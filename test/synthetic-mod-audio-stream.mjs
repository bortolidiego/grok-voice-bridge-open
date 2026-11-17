/**
 * Teste sintético do transporte mod_audio_stream <-> grok-voice-bridge <-> fake xAI.
 *
 * NAO usa PSTN, gateway externo nem chamada telefonica real.
 *
 * Modos:
 *   MODE=fake  (padrao): roda dois cenarios separados:
 *                        1) playback puro, sem barge-in;
 *                        2) barge-in puro, sem playback.
 *   MODE=real:           requer FreeSWITCH local com mod_audio_stream e ESL.
 *                        Origina canal loopback inline canonico via ESL, sem dialplan persistente.
 *
 * Variaveis de ambiente (MODE=real):
 *   ESL_HOST / ESL_PORT / ESL_PASSWORD - conexao ESL (default 127.0.0.1:8021).
 *   STREAM_PLAYBACK=true        - obrigatorio para permitir audio de saida.
 *   PORT                        - porta do harness WS (default 8831).
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { buildAudioStreamStartCommand, createAudioStreamServer } from "../src/audio-stream-server.js";
import { EslApiClient } from "../src/audio-esl-client.js";
import { attachEslObserver, subscribeEslObserver } from "../src/audio-stream.js";

const MODE = process.env.MODE || "fake";
const PORT = Number(process.env.PORT || 8831);
const DURATION_MS = Number(process.env.DURATION_MS || 2000);
const TONE_HZ = Number(process.env.TONE_HZ || 440);
const STREAM_PLAYBACK = process.env.STREAM_PLAYBACK === "true";
const SAMPLE_RATE_IN = 16000;
const SAMPLE_RATE_OUT = 24000;
const DEFAULT_TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 15000);
const SYNTHETIC_VB_BASE = "http://synthetic-voice-broadcast.internal";
const SYNTHETIC_VB_INTERNAL_TOKEN = "synthetic-internal-token";
const SYNTHETIC_AGENT = Object.freeze({
  name: "Agente Sintetico",
  prompt: "Responda somente no teste sintetico.",
  greeting: "Ola do agente sintetico.",
  language: "pt-BR",
  model: "grok-voice-latest",
  voice: "eve",
  speed: 1,
  vad_enabled: 1,
  vad_threshold: 0.5,
  vad_silence_ms: 400,
  max_duration_sec: 300,
  transfer_enabled: 0,
  transfer_target: null,
  transfer_timeout_sec: 30,
  handoff_team_id: null,
  fallback_enabled: 0,
  fallback_text: null,
  fallback_whatsapp_template_name: null,
  fallback_whatsapp_inbox_id: null,
});
const SYNTHETIC_SESSION_CONFIG = Object.freeze({
  type: "session.update",
  session: {
    model: SYNTHETIC_AGENT.model,
    voice: SYNTHETIC_AGENT.voice,
    speed: SYNTHETIC_AGENT.speed,
    instructions: SYNTHETIC_AGENT.prompt,
    turn_detection: {
      type: "server_vad",
      threshold: SYNTHETIC_AGENT.vad_threshold,
      silence_duration_ms: SYNTHETIC_AGENT.vad_silence_ms,
      prefix_padding_ms: 500,
    },
  },
});

const RESULT_PATH = "/tmp/synthetic-test-result.json";
const OUT_PCM_PATH = "/tmp/synthetic-out.pcm";
const IN_PCM_PATH = "/tmp/synthetic-in.pcm";
const REAL_WAV_PATH = "/tmp/grok-voice-bridge-synthetic-real.wav";
const CANONICAL_ORIGINATE_REGEX =
  /^originate\s+\{origination_uuid=([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}),loopback_bowout=false,STREAM_PLAYBACK=true\}loopback\/set:synthetic_test=true\\,answer\\,park\/default\/inline\s+&echo\(\)$/i;

const FORBIDDEN_ORIGINATE_PATTERNS = [
  /(^|[^A-Za-z])user\//i,
  /\bsofia\/gateway\b/i,
  /\bsofia\/external\b/i,
  /\bsofia\/internal\b/i,
  /\bexternal\//i,
  /\bpstn\b/i,
  /\bbridge\b/i,
  /\bsip:/i,
  /[;|`$<>]/,
  /@\d{1,3}(?:\.\d{1,3}){3}/,
];

export function buildRealScenarioPlan({ basePath = REAL_WAV_PATH.replace(/\.wav$/i, "") } = {}) {
  return [
    {
      name: "known-tone-no-break",
      toneHz: 440,
      durationMs: 1000,
      breakWhen: null,
      requireChunkPlayed: true,
    },
    {
      name: "empty-break-then-tone",
      toneHz: 550,
      durationMs: 1000,
      breakWhen: "empty-queue",
      expectedEmptyBreakOk: false,
      requireChunkPlayed: true,
    },
    {
      name: "barge-in-after-play-before-chunk-played",
      toneHz: 660,
      durationMs: 2500,
      breakWhen: "barge-in-after-play-before-chunk-played",
      requireChunkPlayed: true,
      expectBreakSent: false,
      expectBreakSkippedNoPlayback: 1,
    },
    {
      name: "recorded-playback-proof",
      toneHz: 880,
      durationMs: 1200,
      breakWhen: null,
      requireChunkPlayed: true,
      requireRecordedPlayback: true,
    },
  ].map((scenario, index) => ({
    ...scenario,
    recordingPath: `${basePath}-${index + 1}-${scenario.name}.wav`,
  }));
}

export function buildCanonicalOriginateCommand(uuid) {
  return `originate {origination_uuid=${uuid},loopback_bowout=false,STREAM_PLAYBACK=true}loopback/set:synthetic_test=true\\,answer\\,park/default/inline &echo()`;
}

export function isAllowedOriginateCommand(cmd) {
  const normalized = cmd.trim();
  if (FORBIDDEN_ORIGINATE_PATTERNS.some((pattern) => pattern.test(normalized))) return false;
  return CANONICAL_ORIGINATE_REGEX.test(normalized);
}

export function tonePcm24k(hz, durationMs) {
  const samples = Math.floor((SAMPLE_RATE_OUT * durationMs) / 1000);
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const t = i / SAMPLE_RATE_OUT;
    const sample = Math.sin(2 * Math.PI * hz * t) * 0.5;
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sample * 32767))), i * 2);
  }
  return buf;
}

export function pcmAverageEnergy(buffer) {
  if (!buffer?.length) return 0;
  let total = 0;
  for (let i = 0; i < buffer.length; i += 2) {
    total += Math.abs(buffer.readInt16LE(i));
  }
  return total / (buffer.length / 2);
}

export function pcmDurationMs(buffer, sampleRate) {
  if (!buffer?.length) return 0;
  return (buffer.length / 2 / sampleRate) * 1000;
}

export function estimateFrequencyHz(buffer, sampleRate) {
  if (!buffer?.length) return 0;
  let zeroCrossings = 0;
  let prev = buffer.readInt16LE(0);
  for (let i = 2; i < buffer.length; i += 2) {
    const curr = buffer.readInt16LE(i);
    if ((prev < 0 && curr >= 0) || (prev > 0 && curr <= 0)) zeroCrossings += 1;
    prev = curr;
  }
  const seconds = buffer.length / 2 / sampleRate;
  return seconds > 0 ? zeroCrossings / 2 / seconds : 0;
}

export function parseWaveFile(buffer) {
  if (buffer.subarray(0, 4).toString("ascii") !== "RIFF" || buffer.subarray(8, 12).toString("ascii") !== "WAVE") {
    throw new Error("WAV invalido: cabecalho RIFF/WAVE ausente");
  }

  let offset = 12;
  let fmt = null;
  let data = null;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.subarray(offset, offset + 4).toString("ascii");
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkSize;
    if (chunkEnd > buffer.length) throw new Error(`WAV invalido: chunk ${chunkId} truncado`);

    if (chunkId === "fmt ") {
      fmt = {
        audioFormat: buffer.readUInt16LE(chunkStart),
        channels: buffer.readUInt16LE(chunkStart + 2),
        sampleRate: buffer.readUInt32LE(chunkStart + 4),
        byteRate: buffer.readUInt32LE(chunkStart + 8),
        blockAlign: buffer.readUInt16LE(chunkStart + 12),
        bitsPerSample: buffer.readUInt16LE(chunkStart + 14),
      };
    }
    if (chunkId === "data") data = buffer.subarray(chunkStart, chunkEnd);
    offset = chunkEnd + (chunkSize % 2);
  }

  if (!fmt || !data) throw new Error("WAV invalido: chunks fmt/data ausentes");
  return { ...fmt, data };
}

export function analyzeWaveActiveRegion(buffer) {
  const wav = parseWaveFile(buffer);
  if (wav.audioFormat !== 1 || wav.bitsPerSample !== 16) {
    throw new Error(`WAV nao suportado: format=${wav.audioFormat} bits=${wav.bitsPerSample}`);
  }

  const sampleCount = wav.data.length / wav.blockAlign;
  const mono = Buffer.alloc(sampleCount * 2);
  for (let i = 0; i < sampleCount; i += 1) {
    let sample = 0;
    for (let channel = 0; channel < wav.channels; channel += 1) {
      sample += wav.data.readInt16LE(i * wav.blockAlign + channel * 2);
    }
    mono.writeInt16LE(Math.round(sample / wav.channels), i * 2);
  }

  const threshold = 500;
  let start = 0;
  while (start < sampleCount && Math.abs(mono.readInt16LE(start * 2)) < threshold) start += 1;
  let end = sampleCount - 1;
  while (end >= start && Math.abs(mono.readInt16LE(end * 2)) < threshold) end -= 1;
  const active = end >= start ? mono.subarray(start * 2, (end + 1) * 2) : Buffer.alloc(0);

  return {
    sampleRate: wav.sampleRate,
    channels: wav.channels,
    bitsPerSample: wav.bitsPerSample,
    totalDurationMs: pcmDurationMs(mono, wav.sampleRate),
    activeDurationMs: pcmDurationMs(active, wav.sampleRate),
    energy: pcmAverageEnergy(active),
    frequencyHz: estimateFrequencyHz(active, wav.sampleRate),
  };
}

function approxEqual(value, expected, tolerance) {
  return Math.abs(value - expected) <= tolerance;
}

function withTimeout(promise, timeoutMs, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timeout after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

class FakeXaiSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 0;
    this.sent = [];
    this.onSend = null;
  }

  send(payload) {
    this.sent.push(payload);
    try {
      const event = JSON.parse(payload);
      this.onSend?.(event);
    } catch {
      // payload nao-json ignorado
    }
  }

  close(code = 1000, reason = "") {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close", code, Buffer.from(reason));
  }

  receive(obj) {
    this.emit("message", Buffer.from(JSON.stringify(obj)));
  }

  receiveDelta(deltaBase64) {
    this.receive({ type: "response.output_audio.delta", delta: deltaBase64 });
  }
}

function makeFakeXaiSocket() {
  return new FakeXaiSocket();
}

function createSyntheticBootstrapFetch() {
  const consumed = new Set();
  return async (url, options) => {
    const expectedUrl = `${SYNTHETIC_VB_BASE}/api/internal/bootstrap-token/consume`;
    const authorization = options?.headers?.Authorization;
    const { token } = JSON.parse(options?.body || "{}");
    if (url !== expectedUrl || authorization !== `Bearer ${SYNTHETIC_VB_INTERNAL_TOKEN}` || !token) {
      return new Response(JSON.stringify({ error: "invalid_token" }), { status: 401 });
    }
    if (consumed.has(token)) {
      return new Response(JSON.stringify({ error: "token_already_consumed" }), { status: 409 });
    }
    consumed.add(token);
    return new Response(JSON.stringify({
      ok: true,
      call_id: `synthetic-${consumed.size}`,
      agent: SYNTHETIC_AGENT,
      session_config: SYNTHETIC_SESSION_CONFIG,
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

function buildFakeXaiResponder({ deltas = [], speechAfterInputFrames = null, responseActiveBeforeSpeech = false }) {
  return (socket) => {
    let inputFrames = 0;
    const timers = new Set();

    const schedule = (fn, delayMs) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        fn();
      }, delayMs);
      timers.add(timer);
    };

    const handleEvent = (event) => {
      if (event.type === "session.update") {
        socket.receive({ type: "session.updated" });
        deltas.forEach((delta, index) => {
          schedule(() => socket.receiveDelta(delta.toString("base64")), 10 + index * 20);
        });
        return;
      }
      if (event.type === "input_audio_buffer.append") {
        inputFrames += 1;
        if (speechAfterInputFrames && inputFrames === speechAfterInputFrames) {
          schedule(() => {
            if (responseActiveBeforeSpeech) {
              socket.receive({ type: "response.created", response: { id: "synthetic-response" } });
            }
            socket.receive({ type: "input_audio_buffer.speech_started" });
          }, 5);
        }
      }
    };

    socket.onSend = handleEvent;
    socket.on("close", () => {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    });
  };
}

function createModAudioStreamFakeClient({ url, callUuid, bootstrapToken, inputFrameBytes, onMetrics }) {
  const ws = new WebSocket(url);
  const metrics = {
    connectedAt: null,
    metadataSentAt: null,
    streamAudioCount: 0,
    streamAudioBytes: 0,
    inputFramesSent: 0,
    inputBytesSent: 0,
    closed: false,
  };
  const outPcm = [];

  ws.on("open", () => {
    metrics.connectedAt = Date.now();
    ws.send(JSON.stringify({ call_uuid: callUuid, bootstrap_token: bootstrapToken }));
    metrics.metadataSentAt = Date.now();
  });

  ws.on("message", (data, isBinary) => {
    if (isBinary) return;
    const msg = JSON.parse(data.toString("utf8"));
    if (msg.type === "streamAudio") {
      metrics.streamAudioCount += 1;
      const bytes = Buffer.byteLength(msg.data.audioData, "base64");
      metrics.streamAudioBytes += bytes;
      outPcm.push(Buffer.from(msg.data.audioData, "base64"));
    }
  });

  ws.on("close", () => {
    metrics.closed = true;
    onMetrics?.(metrics, Buffer.concat(outPcm));
  });

  return {
    ws,
    metrics,
    startSending(frameCount = Math.ceil(DURATION_MS / 20)) {
      let sent = 0;
      const timer = setInterval(() => {
        const frame = inputFrameBytes?.[sent] || Buffer.alloc(Math.floor((SAMPLE_RATE_IN * 20) / 1000) * 2, 0);
        metrics.inputFramesSent += 1;
        metrics.inputBytesSent += frame.length;
        sent += 1;
        if (ws.readyState === 1) ws.send(frame);
        if (sent >= frameCount) clearInterval(timer);
      }, 20);
      return { stop: () => clearInterval(timer) };
    },
  };
}

function waitForEvent(emitter, eventName, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return withTimeout(new Promise((resolve) => emitter.once(eventName, resolve)), timeoutMs, eventName);
}

function waitForServerListening(server, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const isListening = () => (
    (typeof server.address === "function" && server.address())
    || server._server?.listening
  );
  if (isListening()) return Promise.resolve(server.address?.());
  return withTimeout(new Promise((resolve, reject) => {
    let done = false;
    const onError = (err) => {
      if (done) return;
      done = true;
      server.off("error", onError);
      if (["EACCES", "EADDRINUSE", "EPERM"].includes(err?.code)) {
        reject(new Error(`server bind failed: ${err.code} ${err.message}`));
        return;
      }
      reject(err);
    };
    server.once("error", onError);
    const tick = () => {
      if (done) return;
      if (isListening()) {
        done = true;
        server.off("error", onError);
        resolve(server.address?.());
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  }), timeoutMs, "listening");
}

function waitForCondition(predicate, timeoutMs, label) {
  return withTimeout(new Promise((resolve) => {
    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }
      setTimeout(tick, 20);
    };
    tick();
  }), timeoutMs, label);
}

async function closeWsServer(server) {
  server.closeAudioStreams?.();
  if (!server?._server?.listening) {
    try { server.close(); } catch {}
    return;
  }
  await new Promise((resolve) => server.close(resolve));
}

async function waitForUuidExists(client, uuid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const reply = await client.sendEslApiCommand(`uuid_exists ${uuid}`);
    if (reply.ok && /\btrue\b/i.test(reply.reply)) return true;
    await sleep(100);
  }
  return false;
}

function buildAnalysis(buffer, expectedBytes) {
  const energy = pcmAverageEnergy(buffer);
  const durationMs = pcmDurationMs(buffer, SAMPLE_RATE_OUT);
  const frequencyHz = estimateFrequencyHz(buffer, SAMPLE_RATE_OUT);
  return {
    bytes: buffer.length,
    energy,
    durationMs,
    frequencyHz,
    expectedBytes,
  };
}

function evaluatePlaybackAnalysis({ analysis, expectedDurationMs, expectedHz, failures }) {
  if (analysis.bytes !== analysis.expectedBytes) failures.push(`streamAudio bytes mismatch: ${analysis.bytes} !== ${analysis.expectedBytes}`);
  if (analysis.energy < 500) failures.push(`audio de saida com energia baixa: ${analysis.energy}`);
  if (!approxEqual(analysis.durationMs, expectedDurationMs, expectedDurationMs * 0.1)) {
    failures.push(`duracao fora da tolerancia: ${analysis.durationMs}ms !== ${expectedDurationMs}ms`);
  }
  if (!approxEqual(analysis.frequencyHz, expectedHz, 25)) {
    failures.push(`frequencia fora da tolerancia: ${analysis.frequencyHz}Hz !== ${expectedHz}Hz`);
  }
}

async function runFakePlaybackScenario() {
  const deltas = [];
  const chunkMs = 200;
  for (let i = 0; i < Math.ceil(DURATION_MS / chunkMs); i += 1) {
    deltas.push(tonePcm24k(TONE_HZ, chunkMs));
  }
  const expectedBytes = deltas.reduce((sum, delta) => sum + delta.length, 0);
  const expectedFrameBytes = Math.round(SAMPLE_RATE_OUT * 0.02) * 2;
  const expectedFrameCount = Math.ceil(expectedBytes / expectedFrameBytes);

  let capturedXaiSocket = null;
  const bridgeLogs = [];
  let finalMetrics = null;
  let finalOutPcm = null;
  const inputFrames = Array.from({ length: Math.ceil(DURATION_MS / 20) }, () =>
    Buffer.alloc(Math.floor((SAMPLE_RATE_IN * 20) / 1000) * 2, 0)
  );
  const server = createAudioStreamServer({
    host: "127.0.0.1",
    port: PORT,
    apiKey: "test-key",
    vbBase: SYNTHETIC_VB_BASE,
    vbInternalToken: SYNTHETIC_VB_INTERNAL_TOKEN,
    fetchImpl: createSyntheticBootstrapFetch(),
    createXaiSocket: () => {
      const socket = makeFakeXaiSocket();
      capturedXaiSocket = socket;
      buildFakeXaiResponder({ deltas })(socket);
      setImmediate(() => {
        socket.readyState = 1;
        socket.emit("open");
      });
      return socket;
    },
    onLog: (level, message, meta) => {
      bridgeLogs.push({ level, message, meta, ts: new Date().toISOString() });
    },
  });

  try {
    await waitForServerListening(server);
    const client = createModAudioStreamFakeClient({
      url: `ws://127.0.0.1:${PORT}`,
      callUuid: `synthetic-fake-playback-${crypto.randomUUID()}`,
      bootstrapToken: `synthetic.${crypto.randomUUID()}`,
      inputFrameBytes: inputFrames,
      onMetrics: (metrics, pcm) => {
        finalMetrics = metrics;
        finalOutPcm = pcm;
      },
    });

    const sender = client.startSending();
    await waitForCondition(
      () => client.metrics.streamAudioBytes === expectedBytes,
      DURATION_MS + 3000,
      "fake playback PCM queue drain",
    );
    sender.stop();
    client.ws.close();
    await waitForCondition(() => finalMetrics?.closed, 3000, "fake playback client close");
  } finally {
    await closeWsServer(server);
  }

  const analysis = buildAnalysis(finalOutPcm, expectedBytes);
  const failures = [];
  if (!capturedXaiSocket) failures.push("bridge nao conectou ao fake xAI");
  if (finalMetrics?.streamAudioCount !== expectedFrameCount) {
    failures.push(`streamAudio frame count mismatch: ${finalMetrics?.streamAudioCount} !== ${expectedFrameCount}`);
  }
  if (bridgeLogs.some((log) => log.message === "barge-in: break enviado")) {
    failures.push("playback puro nao deveria disparar break");
  }
  evaluatePlaybackAnalysis({ analysis, expectedDurationMs: deltas.length * chunkMs, expectedHz: TONE_HZ, failures });

  return {
    name: "fake-playback",
    passed: failures.length === 0,
    failures,
    details: {
      bridgeConnected: capturedXaiSocket !== null,
      xaiDeltasSent: deltas.length,
      expectedFrameCount,
      streamAudioCount: finalMetrics?.streamAudioCount,
      streamAudioBytes: finalMetrics?.streamAudioBytes,
      inputFramesSent: finalMetrics?.inputFramesSent,
      inputBytesSent: finalMetrics?.inputBytesSent,
      analysis,
      bridgeLogsCount: bridgeLogs.length,
    },
    artifacts: {
      bridgeLogs,
      outPcm: finalOutPcm,
      inPcm: Buffer.concat(inputFrames),
    },
  };
}

async function runFakeBargeInScenario() {
  const bridgeLogs = [];
  const eslCommands = [];
  let finalMetrics = null;
  let finalOutPcm = null;
  let capturedXaiSocket = null;
  const server = createAudioStreamServer({
    host: "127.0.0.1",
    port: PORT,
    apiKey: "test-key",
    vbBase: SYNTHETIC_VB_BASE,
    vbInternalToken: SYNTHETIC_VB_INTERNAL_TOKEN,
    fetchImpl: createSyntheticBootstrapFetch(),
    createXaiSocket: () => {
      const socket = makeFakeXaiSocket();
      capturedXaiSocket = socket;
      buildFakeXaiResponder({ speechAfterInputFrames: 5, responseActiveBeforeSpeech: true })(socket);
      setImmediate(() => {
        socket.readyState = 1;
        socket.emit("open");
      });
      return socket;
    },
    sendEslApi: async (command) => {
      eslCommands.push(command);
      return true;
    },
    onLog: (level, message, meta) => {
      bridgeLogs.push({ level, message, meta, ts: new Date().toISOString() });
    },
  });

  try {
    await waitForServerListening(server);
    const client = createModAudioStreamFakeClient({
      url: `ws://127.0.0.1:${PORT}`,
      callUuid: `synthetic-fake-bargein-${crypto.randomUUID()}`,
      bootstrapToken: `synthetic.${crypto.randomUUID()}`,
      onMetrics: (metrics, pcm) => {
        finalMetrics = metrics;
        finalOutPcm = pcm;
      },
    });
    const sender = client.startSending(8);
    await waitForCondition(
      () => bridgeLogs.some((log) => log.message === "barge-in: break omitido; playback ainda nao confirmado"),
      4000,
      "barge-in break omitido antes de playback",
    );
    sender.stop();
    client.ws.close();
    await waitForCondition(() => finalMetrics?.closed, 3000, "fake barge-in client close");
  } finally {
    await closeWsServer(server);
  }

  const failures = [];
  if (eslCommands.length !== 0) failures.push(`barge-in antes de playback deveria omitir break, recebeu ${eslCommands.length}`);
  const responseCancelCount = capturedXaiSocket?.sent
    .map((payload) => JSON.parse(payload))
    .filter((event) => event.type === "response.cancel").length;
  if (responseCancelCount !== 1) failures.push(`resposta ativa deveria receber 1 response.cancel, recebeu ${responseCancelCount}`);
  if (finalMetrics?.streamAudioCount !== 0) failures.push(`barge-in puro nao deveria receber playback: ${finalMetrics?.streamAudioCount}`);
  const counters = bridgeLogs.find((entry) => entry.message === "encerrando par de audio")?.meta?.counters;
  if (counters?.bargeInBreakSkippedNoPlayback !== 1) {
    failures.push(`bargeInBreakSkippedNoPlayback mismatch: ${counters?.bargeInBreakSkippedNoPlayback} !== 1`);
  }

  return {
    name: "fake-barge-in",
    passed: failures.length === 0,
    failures,
    details: {
      breakCommands: eslCommands,
      bargeInBreakSkippedNoPlayback: counters?.bargeInBreakSkippedNoPlayback,
      responseCancelCount,
      inputFramesSent: finalMetrics?.inputFramesSent,
      inputBytesSent: finalMetrics?.inputBytesSent,
      streamAudioCount: finalMetrics?.streamAudioCount,
      bridgeLogsCount: bridgeLogs.length,
    },
    artifacts: {
      bridgeLogs,
      outPcm: finalOutPcm,
    },
  };
}

async function runFakeMode() {
  const playback = await runFakePlaybackScenario();
  const bargeIn = await runFakeBargeInScenario();
  const result = {
    mode: "fake",
    passed: playback.passed && bargeIn.passed,
    failures: [...playback.failures.map((failure) => `[${playback.name}] ${failure}`), ...bargeIn.failures.map((failure) => `[${bargeIn.name}] ${failure}`)],
    details: {
      scenarios: {
        [playback.name]: playback.details,
        [bargeIn.name]: bargeIn.details,
      },
    },
  };

  writeFileSync(OUT_PCM_PATH, playback.artifacts.outPcm);
  writeFileSync(IN_PCM_PATH, playback.artifacts.inPcm);
  writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2));
  return result;
}

async function runRealMode() {
  if (!STREAM_PLAYBACK) throw new Error("MODE=real exige STREAM_PLAYBACK=true para audio de saida.");

  const eslPassword = process.env.ESL_PASSWORD || "";
  if (!eslPassword) throw new Error("MODE=real exige ESL_PASSWORD.");

  const plan = buildRealScenarioPlan();
  const bridgeLogs = [];
  const eslEvents = [];
  const bridgeBreakCommands = [];
  const xaiSockets = [];
  let eslClient = null;

  const server = createAudioStreamServer({
    host: "127.0.0.1",
    port: PORT,
    apiKey: "test-key",
    vbBase: SYNTHETIC_VB_BASE,
    vbInternalToken: SYNTHETIC_VB_INTERNAL_TOKEN,
    fetchImpl: createSyntheticBootstrapFetch(),
    createXaiSocket: () => {
      const socket = makeFakeXaiSocket();
      socket.onSend = (event) => {
        if (event.type === "session.update") setImmediate(() => socket.receive({ type: "session.updated" }));
      };
      xaiSockets.push(socket);
      setImmediate(() => {
        socket.readyState = 1;
        socket.emit("open");
      });
      return socket;
    },
    sendEslApi: async (command) => {
      bridgeBreakCommands.push({ command, ts: Date.now() });
      return eslClient ? eslClient.sendEslApi(command) : false;
    },
    onLog: (level, message, meta) => {
      bridgeLogs.push({ level, message, meta, ts: Date.now(), iso: new Date().toISOString() });
    },
  });

  const results = [];
  const allFailures = [];

  try {
    await waitForServerListening(server);
    eslClient = new EslApiClient({
      host: process.env.ESL_HOST || "127.0.0.1",
      port: Number(process.env.ESL_PORT || 8021),
      password: eslPassword,
      onLog: (level, message, meta) => {
        bridgeLogs.push({ level: `esl:${level}`, message, meta, ts: Date.now(), iso: new Date().toISOString() });
      },
    });

    for (const eventName of [
      "mod_audio_stream_connect",
      "mod_audio_stream_play",
      "mod_audio_stream_disconnect",
      "mod_audio_stream_error",
      "chunk_played",
      "queue_completed",
      "playback",
    ]) {
      eslClient.on(eventName, (event) => eslEvents.push({ event: eventName, ...event, ts: Date.now() }));
    }

    attachEslObserver({
      client: eslClient,
      playbackTracker: server.audioPlaybackTracker,
      onLog: (level, message, meta) => {
        bridgeLogs.push({ level: `observer:${level}`, message, meta, ts: Date.now(), iso: new Date().toISOString() });
      },
    });

    await withTimeout(new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("ESL connect timeout")), 5000);
      eslClient.once("authenticated", () => {
        clearTimeout(timer);
        resolve();
      });
      eslClient.sendEslApi("status");
    }), 6000, "esl auth");

    const observerOk = await subscribeEslObserver({
      client: eslClient,
      onLog: (level, message, meta) => bridgeLogs.push({ level: `observer:${level}`, message, meta, ts: Date.now(), iso: new Date().toISOString() }),
    });
    if (!observerOk) throw new Error("falha ao assinar observer ESL plain");

    for (const scenario of plan) {
      const failures = [];
      const callUuid = crypto.randomUUID();
      const bootstrapToken = `synthetic.${crypto.randomUUID()}`;
      const originateCmd = buildCanonicalOriginateCommand(callUuid);
      const audioStreamCmd = buildAudioStreamStartCommand({
        callUuid,
        wsUrl: `ws://127.0.0.1:${PORT}`,
        bootstrapToken,
      });
      const firstEventIndex = eslEvents.length;
      const firstSocketIndex = xaiSockets.length;
      const firstBreakIndex = bridgeBreakCommands.length;
      let startStreamReply = null;
      let stopReply = null;
      let recordStartReply = null;
      let recordStopReply = null;
      let rawEmptyBreakReply = null;
      let speechStartedAt = null;
      let playbackSnapshotAtQueue = null;

      if (existsSync(scenario.recordingPath)) rmSync(scenario.recordingPath);

      try {
        if (!isAllowedOriginateCommand(originateCmd)) throw new Error(`originate canonico rejeitado: ${originateCmd}`);
        await eslClient.sendEslApi(originateCmd);
        if (!await waitForUuidExists(eslClient, callUuid, 5000)) throw new Error(`uuid_exists nao confirmou canal ${callUuid}`);

        recordStartReply = await eslClient.sendEslApiCommand(`uuid_record ${callUuid} start ${scenario.recordingPath}`);
        if (!recordStartReply.ok) throw new Error(`uuid_record start falhou: ${recordStartReply.reply}`);

        startStreamReply = await eslClient.sendEslApiCommand(audioStreamCmd);
        if (!startStreamReply.ok) throw new Error(`uuid_audio_stream start falhou: ${startStreamReply.reply}`);

        await waitForCondition(() => xaiSockets.length > firstSocketIndex, 5000, `${scenario.name}: websocket xAI fake`);
        const xaiSocket = xaiSockets[firstSocketIndex];
        await waitForCondition(
          () => eslEvents.slice(firstEventIndex).some((event) => event.event === "mod_audio_stream_connect" && event.uuid === callUuid),
          5000,
          `${scenario.name}: mod_audio_stream connect`,
        );

        if (scenario.breakWhen === "empty-queue") {
          rawEmptyBreakReply = await eslClient.sendEslApiCommand(`uuid_audio_stream ${callUuid} break`);
          if (rawEmptyBreakReply.ok !== scenario.expectedEmptyBreakOk) {
            failures.push(`break com fila vazia ok=${rawEmptyBreakReply.ok} != ${scenario.expectedEmptyBreakOk}: ${rawEmptyBreakReply.reply}`);
          }
        }

        xaiSocket.receive({ type: "response.created", response: { id: `response-${scenario.name}` } });
        xaiSocket.receiveDelta(tonePcm24k(scenario.toneHz, scenario.durationMs).toString("base64"));

        await waitForCondition(
          () => eslEvents.slice(firstEventIndex).some((event) => event.event === "mod_audio_stream_play" && event.uuid === callUuid),
          5000,
          `${scenario.name}: play accepted`,
        );

        if (scenario.breakWhen === "barge-in-after-play-before-chunk-played") {
          const chunkBeforeSpeech = eslEvents.slice(firstEventIndex).some((event) => event.event === "chunk_played" && event.uuid === callUuid);
          if (chunkBeforeSpeech) failures.push("chunk_played ocorreu antes do speech_started; cenario de corrida invalido");
          speechStartedAt = Date.now();
          xaiSocket.receive({ type: "input_audio_buffer.speech_started" });
          await waitForCondition(
            () => bridgeLogs.some((entry) => entry.message === "barge-in: break omitido; playback ainda nao confirmado" && entry.meta.callUuid === callUuid),
            3000,
            `${scenario.name}: break omitido`,
          );
        }

        await waitForCondition(
          () => eslEvents.slice(firstEventIndex).some((event) => event.event === "chunk_played" && event.uuid === callUuid),
          Math.max(DEFAULT_TIMEOUT_MS, scenario.durationMs + 5000),
          `${scenario.name}: chunk_played`,
        );
        await waitForCondition(
          () => eslEvents.slice(firstEventIndex).some((event) => event.event === "queue_completed" && event.uuid === callUuid),
          5000,
          `${scenario.name}: queue_completed`,
        );
        playbackSnapshotAtQueue = server.audioPlaybackTracker.snapshot(callUuid);

        stopReply = await eslClient.sendEslApiCommand(`uuid_audio_stream ${callUuid} stop`);
        recordStopReply = await eslClient.sendEslApiCommand(`uuid_record ${callUuid} stop ${scenario.recordingPath}`);
        await waitForCondition(
          () => bridgeLogs.some((entry) => entry.message === "encerrando par de audio" && entry.meta.callUuid === callUuid),
          3000,
          `${scenario.name}: bridge counters`,
        );
      } catch (err) {
        failures.push(err.message);
      } finally {
        try { await eslClient.sendEslApiCommand(`uuid_audio_stream ${callUuid} stop`); } catch {}
        try { await eslClient.sendEslApiCommand(`uuid_record ${callUuid} stop ${scenario.recordingPath}`); } catch {}
        try { await eslClient.sendEslApi(`uuid_kill ${callUuid}`); } catch {}
      }

      const scenarioEvents = eslEvents.slice(firstEventIndex).filter((event) => event.uuid === callUuid);
      const breakCommands = bridgeBreakCommands.slice(firstBreakIndex).filter((entry) => entry.command.includes(callUuid));
      const counters = bridgeLogs.find((entry) => entry.message === "encerrando par de audio" && entry.meta.callUuid === callUuid)?.meta?.counters || null;
      const playbackSnapshot = playbackSnapshotAtQueue || server.audioPlaybackTracker.snapshot(callUuid);
      const wavExists = existsSync(scenario.recordingPath);
      let analysis = { sampleRate: 0, channels: 0, bitsPerSample: 0, totalDurationMs: 0, activeDurationMs: 0, energy: 0, frequencyHz: 0 };
      if (wavExists) {
        try { analysis = analyzeWaveActiveRegion(readFileSync(scenario.recordingPath)); } catch (err) { failures.push(err.message); }
      } else {
        failures.push(`gravacao WAV ausente: ${scenario.recordingPath}`);
      }

      const playEvent = scenarioEvents.find((event) => event.event === "mod_audio_stream_play");
      const chunkEvent = scenarioEvents.find((event) => event.event === "chunk_played");
      const queueEvent = scenarioEvents.find((event) => event.event === "queue_completed");
      if (!playEvent) failures.push("evento play ausente");
      if (scenario.requireChunkPlayed && !chunkEvent) failures.push("evento chunk_played ausente");
      if (!queueEvent) failures.push("evento queue_completed ausente");
      if (analysis.energy < 500) failures.push(`energia WAV baixa: ${analysis.energy}`);
      if (!approxEqual(analysis.frequencyHz, scenario.toneHz, 45)) failures.push(`frequencia WAV ${analysis.frequencyHz}Hz != ${scenario.toneHz}Hz`);
      if (!approxEqual(analysis.activeDurationMs, scenario.durationMs, scenario.durationMs * 0.3)) {
        failures.push(`duracao ativa WAV ${analysis.activeDurationMs}ms != ${scenario.durationMs}ms`);
      }
      if (!startStreamReply?.ok) failures.push(`start nao retornou +OK: ${startStreamReply?.reply}`);
      if (!stopReply?.ok) failures.push(`stop nao retornou +OK: ${stopReply?.reply}`);
      if (!recordStartReply?.ok) failures.push(`record start nao retornou +OK: ${recordStartReply?.reply}`);
      if (!recordStopReply?.ok) failures.push(`record stop nao retornou +OK: ${recordStopReply?.reply}`);

      if (scenario.breakWhen === "barge-in-after-play-before-chunk-played") {
        if (breakCommands.length !== 0) failures.push(`bridge enviou ${breakCommands.length} break(s) antes de chunk_played`);
        if (counters?.bargeInBreakSkippedNoPlayback !== scenario.expectBreakSkippedNoPlayback) {
          failures.push(`bargeInBreakSkippedNoPlayback=${counters?.bargeInBreakSkippedNoPlayback} != ${scenario.expectBreakSkippedNoPlayback}`);
        }
        if (!(playEvent?.ts <= speechStartedAt && speechStartedAt < chunkEvent?.ts)) {
          failures.push(`ordem de timing invalida: play=${playEvent?.ts}, speech=${speechStartedAt}, chunk=${chunkEvent?.ts}`);
        }
      }

      const scenarioResult = {
        name: scenario.name,
        passed: failures.length === 0,
        failures,
        callUuid,
        audioStreamCmd,
        originateCmd,
        recordingPath: scenario.recordingPath,
        toneHz: scenario.toneHz,
        durationMs: scenario.durationMs,
        analysis,
        counters,
        playbackSnapshot,
        rawEmptyBreakReply,
        breakCommands,
        timeline: {
          playAcceptedAt: playEvent?.ts || null,
          speechStartedAt,
          chunkPlayedAt: chunkEvent?.ts || null,
          queueCompletedAt: queueEvent?.ts || null,
        },
        events: scenarioEvents.map((event) => ({ event: event.event, ts: event.ts, playbackEvent: event.playbackEvent, payload: event.payload })),
      };
      results.push(scenarioResult);
      allFailures.push(...failures.map((failure) => `[${scenario.name}] ${failure}`));
    }
  } finally {
    eslClient?.close();
    await closeWsServer(server);
  }

  const result = {
    mode: "real",
    port: PORT,
    passed: allFailures.length === 0 && results.length === plan.length,
    failures: allFailures,
    details: { scenarios: results },
  };
  writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2));
  return result;
}

function cleanup() {
  const realArtifacts = buildRealScenarioPlan().map((scenario) => scenario.recordingPath);
  for (const filePath of [RESULT_PATH, OUT_PCM_PATH, IN_PCM_PATH, REAL_WAV_PATH, ...realArtifacts]) {
    if (existsSync(filePath)) rmSync(filePath);
  }
}

export async function main() {
  cleanup();
  const result = MODE === "fake"
    ? await runFakeMode()
    : MODE === "real"
      ? await runRealMode()
      : (() => { throw new Error(`MODE invalido: ${MODE}. Use fake ou real.`); })();
  console.log(JSON.stringify(result, null, 2));
  return result;
}

const isDirectRun =
  !process.execArgv.includes("--test")
  && process.argv[1]
  && path.resolve(process.argv[1]).endsWith(path.basename(fileURLToPath(import.meta.url)));

if (isDirectRun) {
  try {
    const result = await main();
    process.exitCode = result.passed ? 0 : 1;
  } catch (err) {
    console.error(err.message || err);
    process.exitCode = 1;
  }
}
