/**
 * Transporte de audio full-duplex entre mod_audio_stream e xAI Realtime.
 *
 * Este modulo e independente da ponte SIP/webhook: cada conexao WebSocket do
 * FreeSWITCH cria seu proprio WebSocket para a xAI e nao compartilha estado
 * nem buffers de audio com outras chamadas.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import WebSocket, { WebSocketServer } from "ws";
import { getSharedEslApiSender } from "./audio-esl-client.js";
import { buildInitialGreetingResponse, buildRealtimeSessionUpdate } from "./realtime.js";
// Cliente S2S do voice-broadcast vive em modulo proprio para o caminho de SIP
// nativo (src/realtime.js) poder usa-lo sem import circular com este arquivo.
import { consumeBootstrapToken, reportCallEnd, reportCallOutcome } from "./vb-client.js";

export { sendEslApi } from "./audio-esl-client.js";
// Reexportados para nao quebrar quem ja importava daqui (testes, server.js).
export { consumeBootstrapToken, reportCallEnd, reportCallOutcome } from "./vb-client.js";

export const XAI_AUDIO_REALTIME_URL =
  "wss://api.x.ai/v1/realtime?model=grok-voice-latest";
export const AI_AUDIO_SAMPLE_RATE = 16_000;

export function buildXaiAudioRealtimeUrl(model) {
  const url = new URL("wss://api.x.ai/v1/realtime");
  url.searchParams.set("model", model || "grok-voice-latest");
  return url.toString();
}

/**
 * Le a chave explicitamente configurada ou, para uso operacional local,
 * reaproveita o arquivo ja usado pelo bridge SIP.
 */
export function loadXaiApiKey({
  env = process.env,
  homeDir = os.homedir(),
  readFile = fs.readFileSync,
} = {}) {
  const configured = env.XAI_API_KEY?.trim();
  if (configured) return configured;

  const keyFile = path.join(homeDir, ".xai-poc-key");
  try {
    const fromFile = readFile(keyFile, "utf8").trim();
    if (fromFile) return fromFile;
  } catch (err) {
    throw new Error(`XAI_API_KEY ausente e nao foi possivel ler ${keyFile}: ${err.message}`);
  }

  throw new Error("XAI_API_KEY ausente e ~/.xai-poc-key esta vazio");
}

export function buildAudioSessionUpdate({ sessionConfig } = {}) {
  return buildRealtimeSessionUpdate({
    sessionConfig,
    audio: {
      input: {
        format: { type: "audio/pcm", rate: 16000 },
        transcription: { model: "grok-transcribe" },
      },
      output: {
        format: { type: "audio/pcm", rate: AI_AUDIO_SAMPLE_RATE },
      },
    },
  });
}

function buildPrerecordedGreetingInstruction(agent) {
  const greeting = String(agent?.greeting || "").trim();
  const quotedGreeting = greeting ? ` "${greeting}"` : "";
  return [
    `A saudacao inicial${quotedGreeting} ja foi reproduzida por audio pre-gravado antes desta sessao.`,
    "Nao diga alo, nao cumprimente de novo e nao repita a abertura.",
    "Aguarde a primeira fala real do usuario e continue a conversa a partir dela.",
  ].join(" ");
}

// Exportada porque o caminho de SIP nativo (src/server.js) precisa da MESMA
// regra: se a saudacao pre-gravada ja tocou na perna do cliente, a xAI nao pode
// cumprimentar de novo.
export function withPrerecordedGreetingContext(sessionConfig, agent) {
  if (!(agent?.initial_greeting_played === true || agent?.initialGreetingPlayed === true)) {
    return sessionConfig;
  }
  const next = structuredClone(sessionConfig || {});
  next.session = { ...(next.session || {}) };
  next.session.instructions = [
    String(next.session.instructions || "").trim(),
    buildPrerecordedGreetingInstruction(agent),
  ].filter(Boolean).join("\n\n");
  return next;
}

function defaultCreateXaiSocket({ apiKey, url = XAI_AUDIO_REALTIME_URL }) {
  return new WebSocket(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
}

function defaultLog(level, message, meta = {}) {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, message, ...meta }));
}

function socketIsOpen(socket) {
  // `ws` usa 1 para OPEN. A ausencia de readyState facilita mocks pequenos nos testes.
  return socket && (socket.readyState === undefined || socket.readyState === 1);
}

function safeClose(socket, code, reason) {
  if (!socket || socket.readyState === 3) return;
  try {
    socket.close(code, reason);
  } catch {
    // O outro lado pode ja ter sido encerrado no mesmo turno do event loop.
  }
}

function sendJson(socket, payload) {
  socket.send(JSON.stringify(payload));
}

export function limitPcm16Peak(pcm, peak = 24_000) {
  if (!Buffer.isBuffer(pcm) || pcm.length % 2 !== 0) {
    throw new Error("limitPcm16Peak requer PCM16 mono");
  }
  const limited = Buffer.from(pcm);
  const ceiling = Math.max(1, Math.min(32_767, Number(peak) || 24_000));
  const floor = -ceiling;
  for (let offset = 0; offset < limited.length; offset += 2) {
    const sample = limited.readInt16LE(offset);
    if (sample > ceiling) limited.writeInt16LE(ceiling, offset);
    else if (sample < floor) limited.writeInt16LE(floor, offset);
  }
  return limited;
}

export function applyPcm16Gain(pcm, gain = 1) {
  if (!Buffer.isBuffer(pcm) || pcm.length % 2 !== 0) {
    throw new Error("applyPcm16Gain requer PCM16 mono");
  }
  const normalizedGain = Number.isFinite(Number(gain)) ? Number(gain) : 1;
  if (normalizedGain === 1) return Buffer.from(pcm);
  const adjusted = Buffer.alloc(pcm.length);
  for (let offset = 0; offset < pcm.length; offset += 2) {
    const sample = Math.round(pcm.readInt16LE(offset) * normalizedGain);
    adjusted.writeInt16LE(Math.max(-32_768, Math.min(32_767, sample)), offset);
  }
  return adjusted;
}

function buildLowPassKernel({
  taps = 31,
  inputRate = AI_AUDIO_SAMPLE_RATE,
  cutoffHz = 3_400,
} = {}) {
  const safeTaps = taps % 2 === 1 ? taps : taps + 1;
  const middle = (safeTaps - 1) / 2;
  const normalizedCutoff = cutoffHz / inputRate;
  const kernel = [];
  let sum = 0;
  for (let index = 0; index < safeTaps; index += 1) {
    const distance = index - middle;
    const sinc = distance === 0
      ? 2 * normalizedCutoff
      : Math.sin(2 * Math.PI * normalizedCutoff * distance) / (Math.PI * distance);
    const window = 0.54 - (0.46 * Math.cos((2 * Math.PI * index) / (safeTaps - 1)));
    const value = sinc * window;
    kernel.push(value);
    sum += value;
  }
  return kernel.map((value) => value / sum);
}

export function createPcm16Downsampler2x({
  kernel = buildLowPassKernel(),
} = {}) {
  const historySamples = new Array(kernel.length - 1).fill(0);
  let phase = 0;
  return {
    process(pcm) {
      if (!Buffer.isBuffer(pcm) || pcm.length % 2 !== 0) {
        throw new Error("downsample requer PCM16 mono");
      }
      const inputSamples = new Array(pcm.length / 2);
      for (let offset = 0; offset < pcm.length; offset += 2) {
        inputSamples[offset / 2] = pcm.readInt16LE(offset);
      }
      const extended = historySamples.concat(inputSamples);
      const outputSamples = [];
      const firstCurrentIndex = historySamples.length;
      for (let index = firstCurrentIndex; index < extended.length; index += 1) {
        if (phase === 0) {
          let sample = 0;
          for (let tap = 0; tap < kernel.length; tap += 1) {
            sample += extended[index - tap] * kernel[tap];
          }
          outputSamples.push(Math.max(-32_768, Math.min(32_767, Math.round(sample))));
        }
        phase = (phase + 1) % 2;
      }
      historySamples.splice(0, historySamples.length, ...extended.slice(-(kernel.length - 1)));
      const output = Buffer.alloc(outputSamples.length * 2);
      outputSamples.forEach((sample, index) => output.writeInt16LE(sample, index * 2));
      return output;
    },
  };
}

export function buildStreamAudioMessage({
  pcm,
  sampleRate,
  declaredSampleRate = AI_AUDIO_SAMPLE_RATE,
}) {
  if (!Buffer.isBuffer(pcm) || pcm.length === 0 || pcm.length % 2 !== 0) {
    throw new Error("streamAudio requer PCM16 mono nao vazio");
  }
  if (Number(sampleRate) !== Number(declaredSampleRate)) {
    throw new Error(`streamAudio sampleRate divergente: real=${sampleRate} declarado=${declaredSampleRate}`);
  }
  return {
    type: "streamAudio",
    data: {
      audioDataType: "raw",
      sampleRate: declaredSampleRate,
      audioData: pcm.toString("base64"),
    },
  };
}

export function requireVoiceBroadcastConfig({ vbBase, vbInternalToken } = {}) {
  const missing = [];
  if (!String(vbBase || "").trim()) missing.push("VB_BASE");
  if (!String(vbInternalToken || "").trim()) missing.push("VB_INTERNAL_TOKEN");
  if (missing.length > 0) {
    throw new Error(`audio stream requer configuracao interna: ${missing.join(", ")}`);
  }
}

function socketBufferedAmount(socket) {
  const value = Number(socket?.bufferedAmount);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function roundTiming(value) {
  return Number.isFinite(value) ? Math.round(value * 1_000) / 1_000 : null;
}

export function createEventLoopLagMonitor({
  intervalMs = 1_000,
  monotonicNow = () => performance.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  onSample = () => {},
} = {}) {
  let timer = null;
  let stopped = false;
  let expectedMonotonicMs = monotonicNow() + intervalMs;
  const state = { samples: 0, lastLagMs: 0, maxLagMs: 0, totalLagMs: 0 };

  const schedule = () => {
    if (stopped) return;
    const delayMs = Math.max(0, expectedMonotonicMs - monotonicNow());
    timer = setTimer(() => {
      const sampledMonotonicMs = monotonicNow();
      const lagMs = Math.max(0, sampledMonotonicMs - expectedMonotonicMs);
      state.samples += 1;
      state.lastLagMs = lagMs;
      state.maxLagMs = Math.max(state.maxLagMs, lagMs);
      state.totalLagMs += lagMs;
      onSample({
        lagMs: roundTiming(lagMs),
        sampledMonotonicMs: roundTiming(sampledMonotonicMs),
      });
      expectedMonotonicMs = sampledMonotonicMs + intervalMs;
      schedule();
    }, delayMs);
    timer?.unref?.();
  };

  schedule();
  return {
    stop() {
      stopped = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
    snapshot() {
      return {
        intervalMs,
        samples: state.samples,
        lastLagMs: roundTiming(state.lastLagMs),
        maxLagMs: roundTiming(state.maxLagMs),
        avgLagMs: roundTiming(state.samples ? state.totalLagMs / state.samples : 0),
      };
    },
  };
}

export function applyCosinePcm16FadeOut(
  pcm,
  { sampleRate = 24_000, fadeDurationMs = 150 } = {},
) {
  const output = Buffer.from(pcm);
  const totalSamples = Math.floor(output.length / 2);
  const requestedFadeSamples = Math.max(1, Math.round(sampleRate * fadeDurationMs / 1_000));
  const fadeSamples = Math.min(totalSamples, requestedFadeSamples);
  const fadeStart = totalSamples - fadeSamples;

  for (let offset = 0; offset < fadeSamples; offset += 1) {
    const gain = fadeSamples === 1 ? 0 : Math.cos((offset / (fadeSamples - 1)) * (Math.PI / 2));
    const byteOffset = (fadeStart + offset) * 2;
    output.writeInt16LE(Math.round(output.readInt16LE(byteOffset) * gain), byteOffset);
  }

  return output;
}

export function createPcmPlaybackController({
  sampleRate = 24_000,
  frameDurationMs = 20,
  fadeDurationMs = 150,
  sendFrame,
  onBreak,
  onError = () => {},
  now = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  // Mantem no mod_audio_stream no maximo um frame curto adiante. No barge-in,
  // o fade entra logo apos esse frame e o break espera 20ms + 30ms para nao
  // apagar a propria rampa antes de ela alcançar o telefone.
  const bytesPerSample = 2;
  const frameBytes = Math.round(sampleRate * frameDurationMs / 1_000) * bytesPerSample;
  const fadeBytes = Math.round(sampleRate * fadeDurationMs / 1_000) * bytesPerSample;
  const jitterBufferMs = 400;
  const jitterBufferBytes = Math.round(sampleRate * jitterBufferMs / 1_000) * bytesPerSample;
  let pending = Buffer.alloc(0);
  let timer = null;
  let buffering = true;
  let lastEnqueueAt = 0;
  let interrupted = false;
  let closed = false;
  let lastSample = 0;
  let hasLastSample = false;

  const cancelTimer = () => {
    if (timer === null) return;
    clearTimer(timer);
    timer = null;
  };
  const schedule = (callback, delayMs) => {
    cancelTimer();
    timer = setTimer(() => {
      timer = null;
      callback();
    }, delayMs);
    timer?.unref?.();
  };
  const emitFrame = (pcm, kind) => {
    sendFrame(pcm, { kind, sampleRate });
    if (pcm.length >= bytesPerSample) {
      lastSample = pcm.readInt16LE(pcm.length - bytesPerSample);
      hasLastSample = true;
    }
  };
  const emitFramedBuffer = (pcm, kind, onDone) => {
    let offset = 0;
    let emittedFrames = 0;
    const emitNext = () => {
      if (closed) return;
      if (offset >= pcm.length) {
        if (onDone) onDone(emittedFrames);
        return;
      }
      const sourceFrame = pcm.subarray(offset, offset + frameBytes);
      const frame = sourceFrame.length === frameBytes ? sourceFrame : Buffer.alloc(frameBytes);
      if (sourceFrame.length < frameBytes) sourceFrame.copy(frame);
      offset += sourceFrame.length;
      emittedFrames += 1;
      try {
        emitFrame(frame, kind);
      } catch (err) {
        onError(err);
        return;
      }
      if (offset < pcm.length) {
        schedule(emitNext, frameDurationMs);
      } else if (onDone) {
        onDone(emittedFrames);
      }
    };
    emitNext();
  };
  const pump = () => {
    if (closed || interrupted) return;

    if (buffering) {
      const msSinceLast = now() - lastEnqueueAt;
      if (pending.length >= jitterBufferBytes || msSinceLast > 100) {
        buffering = false;
      } else {
        schedule(pump, 10);
        return;
      }
    }

    if (pending.length < frameBytes) {
      const msSinceLast = now() - lastEnqueueAt;
      if (pending.length > 0 && msSinceLast > 150) {
        // pad with 0 to frameBytes and flush
        const frame = Buffer.alloc(frameBytes);
        pending.copy(frame);
        pending = Buffer.alloc(0);
        buffering = true;
        try { emitFrame(frame, "audio"); } catch (err) { onError(err); return; }
        return; // nothing left to schedule
      } else if (pending.length === 0) {
        buffering = true;
        try { emitFrame(Buffer.alloc(frameBytes), "audio"); } catch (err) { onError(err); return; }
        schedule(pump, frameDurationMs);
        return;
      } else {
        buffering = true;
        schedule(pump, 10);
        return;
      }
    }

    const frame = pending.subarray(0, frameBytes);
    pending = pending.subarray(frameBytes);
    try {
      emitFrame(frame, "audio");
    } catch (err) {
      onError(err);
      return;
    }
    schedule(pump, frameDurationMs);
  };
  const buildFadeSource = () => {
    const source = Buffer.alloc(fadeBytes);
    const copiedBytes = Math.min(pending.length, fadeBytes);
    if (copiedBytes > 0) pending.copy(source, 0, 0, copiedBytes);

    const heldSample = copiedBytes >= bytesPerSample
      ? source.readInt16LE(copiedBytes - bytesPerSample)
      : lastSample;
    if ((copiedBytes > 0 || hasLastSample) && copiedBytes < fadeBytes) {
      for (let offset = copiedBytes; offset < fadeBytes; offset += bytesPerSample) {
        source.writeInt16LE(heldSample, offset);
      }
    }
    return source;
  };

  return {
    enqueue(pcm) {
      if (closed || interrupted || !pcm?.length) return false;
      pending = pending.length === 0
        ? Buffer.from(pcm)
        : Buffer.concat([pending, pcm]);
      lastEnqueueAt = now();
      if (timer === null) pump();
      return true;
    },
    interrupt({ skipBreak = false } = {}) {
      if (closed || interrupted) return false;
      interrupted = true;
      cancelTimer();
      const fade = applyCosinePcm16FadeOut(buildFadeSource(), { sampleRate, fadeDurationMs });
      pending = Buffer.alloc(0);
      emitFramedBuffer(fade, "fade", (fadeFrames) => {
        if (skipBreak) return;
        const emittedFadeMs = Math.max(0, (fadeFrames - 1) * frameDurationMs);
        const breakDelayMs = Math.max(
          frameDurationMs,
          frameDurationMs + fadeDurationMs - emittedFadeMs,
        );
        schedule(() => {
          try {
            onBreak();
          } catch (err) {
            onError(err);
          }
        }, breakDelayMs);
      });
      return true;
    },
    startResponseEpoch() {
      cancelTimer();
      pending = Buffer.alloc(0);
      interrupted = false;
      lastSample = 0;
      buffering = true;
      hasLastSample = false;
    },
    close() {
      closed = true;
      cancelTimer();
      pending = Buffer.alloc(0);
    },
    snapshot() {
      return {
        pendingBytes: pending.length,
        interrupted,
        closed,
      };
    },
  };
}

function validCallUuid(value) {
  // Alem de validar metadata, evita que texto recebido do socket vire injecao
  // de comando na linha `bgapi uuid_audio_stream ... break`.
  return typeof value === "string" && /^[A-Za-z0-9-]{1,128}$/.test(value);
}

function validBootstrapToken(value) {
  return typeof value === "string"
    && value.length >= 16
    && value.length <= 8_192
    && /^[A-Za-z0-9._~-]+$/.test(value);
}

function parseNonNegativeInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function parsePositiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseOutputSampleRate(value, fallback = 8_000) {
  const parsed = Number.parseInt(value, 10);
  return parsed === 8_000 || parsed === 16_000 ? parsed : fallback;
}

export function createBootstrapRejectBackoff({
  baseDelayMs = 250,
  maxDelayMs = 2_000,
  resetAfterMs = 30_000,
  now = () => Date.now(),
} = {}) {
  const attempts = new Map();
  return {
    nextDelay(key = "unknown") {
      const at = now();
      const previous = attempts.get(key);
      const count = !previous || at - previous.lastAt > resetAfterMs
        ? 1
        : previous.count + 1;
      attempts.set(key, { count, lastAt: at });
      return Math.min(maxDelayMs, baseDelayMs * (2 ** (count - 1)));
    },
    reset(key = "unknown") {
      attempts.delete(key);
    },
  };
}

export function buildAudioStreamStartCommand({ callUuid, wsUrl, bootstrapToken }) {
  if (!validCallUuid(callUuid)) throw new Error("callUuid invalido para uuid_audio_stream start");
  if (!validBootstrapToken(bootstrapToken)) {
    throw new Error("bootstrapToken invalido para uuid_audio_stream start");
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(wsUrl);
  } catch {
    throw new Error("wsUrl invalida para uuid_audio_stream start");
  }
  if (!["ws:", "wss:"].includes(parsedUrl.protocol) || /\s/.test(wsUrl)) {
    throw new Error("wsUrl invalida para uuid_audio_stream start");
  }

  const metadata = JSON.stringify({ call_uuid: callUuid, bootstrap_token: bootstrapToken });
  return `uuid_audio_stream ${callUuid} start ${wsUrl} mono 16k ${metadata}`;
}

/**
 * Correlaciona os eventos assíncronos de playback do mod_audio_stream com a
 * época da resposta xAI que os originou. Os contadores são acumulados por
 * chamada; somente a confirmação usada para liberar o break é reiniciada.
 */
export function createAudioPlaybackTracker() {
  const calls = new Map();

  const freshState = () => ({
    playAccepted: 0,
    chunkPlayed: 0,
    queueCompleted: 0,
    hasConfirmedPlayback: false,
    bargeInBreakSkippedNoPlayback: 0,
    epochPlayAccepted: 0,
    epochChunkPlayed: 0,
  });
  const stateFor = (callUuid) => {
    if (!validCallUuid(callUuid)) return null;
    if (!calls.has(callUuid)) calls.set(callUuid, freshState());
    return calls.get(callUuid);
  };
  const resetEpoch = (state) => {
    if (!state) return;
    state.epochPlayAccepted = 0;
    state.epochChunkPlayed = 0;
    state.hasConfirmedPlayback = false;
  };

  return {
    startResponseEpoch(callUuid) {
      resetEpoch(stateFor(callUuid));
    },
    recordPlayAccepted(callUuid) {
      const state = stateFor(callUuid);
      if (!state) return;
      state.playAccepted += 1;
      state.epochPlayAccepted += 1;
    },
    recordChunkPlayed(callUuid) {
      const state = stateFor(callUuid);
      if (!state) return;
      state.chunkPlayed += 1;
      // Um chunk antigo, concluído depois do início de uma nova resposta, não
      // confirma a época nova até existir um play aceito dentro dela.
      if (state.epochChunkPlayed < state.epochPlayAccepted) {
        state.epochChunkPlayed += 1;
        state.hasConfirmedPlayback = true;
      }
    },
    recordQueueCompleted(callUuid) {
      const state = stateFor(callUuid);
      if (!state) return;
      state.queueCompleted += 1;
      resetEpoch(state);
    },
    recordBreak(callUuid) {
      resetEpoch(stateFor(callUuid));
    },
    recordBreakSkippedNoPlayback(callUuid) {
      const state = stateFor(callUuid);
      if (state) state.bargeInBreakSkippedNoPlayback += 1;
    },
    canBreak(callUuid) {
      return stateFor(callUuid)?.hasConfirmedPlayback === true;
    },
    snapshot(callUuid) {
      const state = stateFor(callUuid) || freshState();
      return {
        playAccepted: state.playAccepted,
        chunkPlayed: state.chunkPlayed,
        queueCompleted: state.queueCompleted,
        hasConfirmedPlayback: state.hasConfirmedPlayback,
        bargeInBreakSkippedNoPlayback: state.bargeInBreakSkippedNoPlayback,
      };
    },
    delete(callUuid) {
      calls.delete(callUuid);
    },
  };
}

/**
 * Liga uma conexao mod_audio_stream a uma unica sessao xAI.
 * Exportada para testes; o servidor a chama uma vez por conexao do FreeSWITCH.
 */
export function attachAudioStreamConnection({
  fsSocket,
  apiKey,
  createXaiSocket = defaultCreateXaiSocket,
  onLog = defaultLog,
  sendEslApi = null,
  playbackTracker = createAudioPlaybackTracker(),
  now = () => Date.now(),
  writeTranscript = fs.writeFileSync,
  transcriptDir = "/tmp",
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  monotonicNow = () => performance.now(),
  telemetrySetTimer = setTimeout,
  telemetryClearTimer = clearTimeout,
  sessionConfig,
  agent,
  metadata,
  callId = null,
  vbBase = null,
  vbInternalToken = null,
  fetchImpl = globalThis.fetch,
  onToolCall = null,
  env = process.env,
}) {
  const model = sessionConfig?.type === "session.update" ? sessionConfig.session?.model : null;
  const xaiSocket = createXaiSocket({ apiKey, url: buildXaiAudioRealtimeUrl(model) });
  const connection = {
    callUuid: validCallUuid(metadata?.call_uuid) ? metadata.call_uuid : null,
    xaiSocket,
    sessionConfig,
    agent,
    callId,
    close: null,
  };
  const connectionId = crypto.randomUUID();
  let closed = false;
  const initialGreetingPlayed = agent?.initial_greeting_played === true
    || agent?.initialGreetingPlayed === true;
  const initialGreetingAudioMs = parseNonNegativeInteger(
    agent?.initial_greeting_audio_ms ?? agent?.initialGreetingAudioMs,
    0,
  );
  const initialGreetingInputSuppressMs = initialGreetingPlayed
    ? initialGreetingAudioMs + parseNonNegativeInteger(env.INITIAL_GREETING_INPUT_SUPPRESS_GUARD_MS, 0)
    : 0;
  const connectionStartedMonotonicMs = monotonicNow();
  let greetingRequested = initialGreetingPlayed;
  let responseActive = false;
  let activeResponseId = null;
  let activeAssistantItemId = null;
  let lastBargeInAt = -Infinity;
  const pendingInputFrames = [];
  const recentInputFrames = [];
  let recentInputFrameCursor = 0;
  const seenSpeechItemIds = new Set();
  const assistantTranscriptDeltas = new Map();
  const transcriptTurns = [];
  let playbackController = null;
  const outputGain = parsePositiveNumber(env.AUDIO_OUTPUT_GAIN, 0.45);
  const outputSampleRate = parseOutputSampleRate(env.AUDIO_OUTPUT_SAMPLE_RATE, 8_000);
  const outputDownsampler = outputSampleRate === 8_000 ? createPcm16Downsampler2x() : null;
  const activeToolCalls = new Map();
  let outcomeCounter = 0;

  const counters = {
    xaiMessages: 0,
    xaiDeltas: 0,
    xaiDeltaBytes: 0,
    xaiErrorEvents: 0,
    fsInputFrames: 0,
    fsInputBytes: 0,
    fsPendingFrames: 0,
    fsStreamAudioAttempted: 0,
    fsStreamAudioSent: 0,
    fsStreamAudioBytes: 0,
    fsStreamAudioFailed: 0,
    fsStreamAudioFailedSocketClosed: 0,
    inputAppendSent: 0,
    inputAppendBytes: 0,
    inputAppendFailed: 0,
    inputAppendSuppressedInitialGreeting: 0,
    inputAppendSuppressedInitialGreetingBytes: 0,
    bargeInCount: 0,
    bargeInBreakSent: 0,
    bargeInBreakFailed: 0,
    bargeInBreakSkippedNoPlayback: 0,
    bargeInFadeSent: 0,
    bargeInFadeBytes: 0,
    bargeInFadeFailed: 0,
    xaiDeltasDroppedAfterBargeIn: 0,
    metadataReceived: connection.callUuid ? 1 : 0,
    responseCancelSent: 0,
    responseCancelSkippedNoActive: 0,
    speechStartedEvents: 0,
    speechStartedDuplicate: 0,
    transcriptTurnsPersisted: 0,
    transcriptWriteFailed: 0,
  };
  const timing = {
    inputFrameSequence: 0,
    inputAudioCursorMs: 0,
    maxInputForwardDelayMs: 0,
    totalInputForwardDelayMs: 0,
    inputForwardDelaySamples: 0,
    maxFsBufferedAmount: 0,
    maxXaiBufferedAmount: 0,
    lastInputFrame: null,
    lastOutputFrame: null,
  };
  let eventLoopMonitor;

  const transcriptPath = () => path.join(
    transcriptDir,
    `grok-voice-test-${connection.callUuid}.transcript.txt`,
  );
  const persistTranscriptTurn = (speaker, text) => {
    if (typeof text !== "string" || !text.trim()) return;
    const normalizedText = text.trim();
    transcriptTurns.push({ speaker, text: normalizedText });

    if (!validCallUuid(connection.callUuid)) {
      onLog("warn", "transcricao sem call_uuid valido; arquivo nao salvo", {
        connectionId,
        callUuid: connection.callUuid,
        speaker,
      });
      return;
    }

    const filePath = transcriptPath();
    const content = [
      `call_uuid: ${connection.callUuid}`,
      "",
      ...transcriptTurns.map((turn) => `[${turn.speaker}] ${turn.text}`),
      "",
    ].join("\n");
    try {
      writeTranscript(filePath, content, { encoding: "utf8", mode: 0o600 });
      counters.transcriptTurnsPersisted += 1;
      onLog("info", "transcricao persistida", {
        connectionId,
        callUuid: connection.callUuid,
        speaker,
        text: normalizedText,
        transcriptPath: filePath,
        transcriptTurns: transcriptTurns.length,
      });
    } catch (err) {
      counters.transcriptWriteFailed += 1;
      onLog("error", "falha ao persistir transcricao", {
        connectionId,
        callUuid: connection.callUuid,
        speaker,
        transcriptPath: filePath,
        message: err.message,
      });
    }
  };

  const closePair = (source, code, reason) => {
    if (closed) return;
    closed = true;
    eventLoopMonitor?.stop();
    onLog("info", "encerrando par de audio", {
      connectionId,
      callUuid: connection.callUuid,
      source,
      code,
      reason,
      counters,
      timing: {
        inputFramesTracked: timing.inputFrameSequence,
        maxInputForwardDelayMs: roundTiming(timing.maxInputForwardDelayMs),
        avgInputForwardDelayMs: roundTiming(
          timing.inputForwardDelaySamples
            ? timing.totalInputForwardDelayMs / timing.inputForwardDelaySamples
            : 0,
        ),
        maxFsBufferedAmount: timing.maxFsBufferedAmount,
        maxXaiBufferedAmount: timing.maxXaiBufferedAmount,
        lastInputFrame: timing.lastInputFrame,
        lastOutputFrame: timing.lastOutputFrame,
        eventLoop: eventLoopMonitor?.snapshot() ?? null,
      },
    });

    if (connection.callId) {
      reportCallEnd({
        callId: connection.callId,
        transcriptJson: JSON.stringify(transcriptTurns),
        // duration vem do VoIP; pro bridge podemos passar undefined q o coalesce mantem a original
        durationSec: undefined,
        status: code === 1011 ? 'failed' : 'ended',
        vbBase,
        vbInternalToken,
        fetchImpl
      }).catch(err => {
        onLog("error", "falha reportCallEnd", { message: err.message });
      });
    }

    playbackController?.close();
    playbackTracker.delete(connection.callUuid);
    if (source !== "freeswitch") safeClose(fsSocket, code, reason);
    if (source !== "xai") safeClose(xaiSocket, code, reason);
  };

  eventLoopMonitor = createEventLoopLagMonitor({
    monotonicNow,
    setTimer: telemetrySetTimer,
    clearTimer: telemetryClearTimer,
    onSample: (sample) => {
      onLog("debug", "telemetria event loop", {
        connectionId,
        callUuid: connection.callUuid,
        ...sample,
        bufferedAmount: {
          fsSocket: socketBufferedAmount(fsSocket),
          xaiSocket: socketBufferedAmount(xaiSocket),
        },
        lastInputFrame: timing.lastInputFrame,
      });
    },
  });

  const sendPlaybackBreak = () => {
    const command = `uuid_audio_stream ${connection.callUuid} break`;
    Promise.resolve(sendEslApi(command))
      .then((sent) => {
        if (sent) {
          counters.bargeInBreakSent += 1;
          onLog("info", "barge-in: break enviado", {
            connectionId,
            callUuid: connection.callUuid,
            fadeDurationMs: 150,
          });
        } else {
          counters.bargeInBreakFailed += 1;
          onLog("warn", "barge-in: ESL indisponivel; break nao enviado", { connectionId, callUuid: connection.callUuid });
        }
      })
      .catch((err) => {
        counters.bargeInBreakFailed += 1;
        onLog("warn", "barge-in: break falhou", {
          connectionId,
          callUuid: connection.callUuid,
          message: err.message,
        });
      });
  };

  playbackController = createPcmPlaybackController({
    sampleRate: AI_AUDIO_SAMPLE_RATE,
    frameDurationMs: 20,
    fadeDurationMs: 150,
    setTimer,
    clearTimer,
    sendFrame: (pcm, { kind, sampleRate }) => {
      counters.fsStreamAudioAttempted += 1;
      const sentMonotonicMs = roundTiming(monotonicNow());
      const bufferedBefore = socketBufferedAmount(fsSocket);
      timing.maxFsBufferedAmount = Math.max(timing.maxFsBufferedAmount, bufferedBefore);
      if (!socketIsOpen(fsSocket)) {
        counters.fsStreamAudioFailed += 1;
        counters.fsStreamAudioFailedSocketClosed += 1;
        if (kind === "fade") counters.bargeInFadeFailed += 1;
        return;
      }
      const outputPcm = outputDownsampler ? outputDownsampler.process(pcm) : pcm;
      const gainedPcm = applyPcm16Gain(outputPcm, outputGain);
      const limitedPcm = limitPcm16Peak(gainedPcm);
      sendJson(fsSocket, buildStreamAudioMessage({
        pcm: limitedPcm,
        sampleRate: outputSampleRate,
        declaredSampleRate: outputSampleRate,
      }));
      const bufferedAfter = socketBufferedAmount(fsSocket);
      timing.maxFsBufferedAmount = Math.max(timing.maxFsBufferedAmount, bufferedAfter);
      timing.lastOutputFrame = {
        kind,
        bytes: limitedPcm.length,
        inputBytes: pcm.length,
        sampleRate: outputSampleRate,
        sentMonotonicMs,
        bufferedBefore,
        bufferedAfter,
      };
      counters.fsStreamAudioSent += 1;
      counters.fsStreamAudioBytes += limitedPcm.length;
      if (kind === "fade") {
        counters.bargeInFadeSent += 1;
        counters.bargeInFadeBytes += limitedPcm.length;
        onLog("info", "barge-in: fade PCM enviado", {
          connectionId,
          callUuid: connection.callUuid,
          fadeDurationMs: 150,
          bytes: limitedPcm.length,
          sampleRate: outputSampleRate,
        });
      }
    },
    onBreak: sendPlaybackBreak,
    onError: (err) => {
      counters.fsStreamAudioFailed += 1;
      onLog("error", "falha no controlador PCM de playback", {
        connectionId,
        callUuid: connection.callUuid,
        message: err.message,
      });
    },
  });

  const requestInitialGreeting = () => {
    if (greetingRequested) return;
    greetingRequested = true;
    try {
      sendJson(xaiSocket, buildInitialGreetingResponse(agent?.greeting));
      onLog("info", "response.create enviado (saudacao inicial)", { connectionId, callUuid: connection.callUuid });
    } catch (err) {
      onLog("error", "falha ao solicitar saudacao", { connectionId, callUuid: connection.callUuid, message: err.message });
      closePair("server", 1011, "xai response create failed");
    }
  };

  const forwardInputFrame = (pcm16k, frameTiming) => {
    const appendedMonotonicMs = monotonicNow();
    const xaiBufferedAmountAtAppend = socketBufferedAmount(xaiSocket);
    sendJson(xaiSocket, {
      type: "input_audio_buffer.append",
      audio: pcm16k.toString("base64"),
    });
    const forwardDelayMs = appendedMonotonicMs - frameTiming.receivedMonotonicMs;
    frameTiming.appendedMonotonicMs = roundTiming(appendedMonotonicMs);
    frameTiming.bridgeForwardDelayMs = roundTiming(forwardDelayMs);
    frameTiming.xaiBufferedAmountAtAppend = xaiBufferedAmountAtAppend;
    timing.maxInputForwardDelayMs = Math.max(timing.maxInputForwardDelayMs, forwardDelayMs);
    timing.totalInputForwardDelayMs += forwardDelayMs;
    timing.inputForwardDelaySamples += 1;
    timing.maxXaiBufferedAmount = Math.max(
      timing.maxXaiBufferedAmount,
      xaiBufferedAmountAtAppend,
      socketBufferedAmount(xaiSocket),
    );
    timing.lastInputFrame = { ...frameTiming };
  };

  const shouldSuppressInitialGreetingInput = () => (
    initialGreetingInputSuppressMs > 0
    && (monotonicNow() - connectionStartedMonotonicMs) < initialGreetingInputSuppressMs
  );

  xaiSocket.on("open", () => {
    try {
      sendJson(xaiSocket, buildAudioSessionUpdate({
        sessionConfig: withPrerecordedGreetingContext(sessionConfig, agent),
      }));
      requestInitialGreeting();
      // Apenas os frames que chegaram antes do handshake xAI sao preservados.
      // Cada um continua virando um append separado; nao ha batching de audio.
      for (const { pcm16k, frameTiming } of pendingInputFrames) {
        forwardInputFrame(pcm16k, frameTiming);
        counters.inputAppendSent += 1;
        counters.inputAppendBytes += pcm16k.length;
      }
      pendingInputFrames.length = 0;
      counters.fsPendingFrames = 0;
      onLog("info", "session.update de audio enviado", { connectionId });
    } catch (err) {
      onLog("error", "falha ao configurar sessao xAI de audio", {
        connectionId,
        message: err.message,
      });
      closePair("server", 1011, "xai session setup failed");
    }
  });

  async function handleToolCall(itemId, toolName, args) {
    const outcomeId = `outcome-${connection.callId || connectionId}-${Date.now()}-${outcomeCounter}`;
    outcomeCounter += 1;
    onLog("info", "executando tool call", {
      connectionId,
      callUuid: connection.callUuid,
      itemId,
      tool: toolName,
      args,
    });

    let resultText = "";
    try {
      const cb = onToolCall || (async (tool, toolArgs) => {
        if (!connection.callId || !vbBase || !vbInternalToken) {
          throw new Error("outcome routing nao configurado");
        }
        const res = await reportCallOutcome({
          callId: connection.callId,
          outcomeId,
          tool,
          args: toolArgs,
          mediaSessionId: null,
          vbBase,
          vbInternalToken,
          fetchImpl,
        });
        return res.resultado_para_ia || "";
      });
      resultText = await cb(toolName, args);
    } catch (err) {
      onLog("error", "tool call falhou", {
        connectionId,
        callUuid: connection.callUuid,
        tool: toolName,
        message: err.message,
      });
      resultText = "Entendido.";
    }

    if (!socketIsOpen(xaiSocket)) return;
    sendJson(xaiSocket, {
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: itemId,
        output: JSON.stringify({ resultado_para_ia: resultText }),
      },
    });
    sendJson(xaiSocket, { type: "response.create" });
    onLog("info", "function_call_output + response.create enviados", {
      connectionId,
      callUuid: connection.callUuid,
      tool: toolName,
    });
  }

  xaiSocket.on("message", (data) => {
    counters.xaiMessages += 1;
    let event;
    try {
      event = JSON.parse(data.toString("utf8"));
    } catch {
      onLog("warn", "evento xAI nao-json ignorado", { connectionId, callUuid: connection.callUuid });
      return;
    }

    // Log seguro de metadados do evento: type, e campos inofensivos.
    onLog("debug", "evento xAI recebido", {
      connectionId,
      callUuid: connection.callUuid,
      type: event.type,
      item_id: event.item_id,
      call_id: event.call_id,
      audio_start_ms: event.audio_start_ms,
      hasDelta: event.type === "response.output_audio.delta" && typeof event.delta === "string",
      hasTranscriptText: (
        (event.type === "response.output_audio_transcript.delta" && typeof event.delta === "string")
        || (event.type === "conversation.item.input_audio_transcription.completed"
          && typeof (event.transcript ?? event.text) === "string")
      ),
    });

    if (event.type === "error") {
      counters.xaiErrorEvents += 1;
      onLog("error", "erro da xAI no transporte de audio", {
        connectionId,
        callUuid: connection.callUuid,
        event_id: event.event_id,
        errorType: event.error?.type,
        code: event.error?.code ?? event.code,
        message: event.error?.message ?? event.message,
        param: event.error?.param ?? event.param,
      });
      return;
    }

    if (event.type === "response.output_audio_transcript.delta" && typeof event.delta === "string") {
      const itemId = event.item_id || "current-assistant-item";
      activeAssistantItemId = event.item_id || activeAssistantItemId;
      assistantTranscriptDeltas.set(itemId, `${assistantTranscriptDeltas.get(itemId) || ""}${event.delta}`);
      return;
    }

    if (event.type === "response.output_audio_transcript.done") {
      const itemId = event.item_id || "current-assistant-item";
      const text = assistantTranscriptDeltas.get(itemId) || event.transcript || event.text || "";
      assistantTranscriptDeltas.delete(itemId);
      persistTranscriptTurn("IA", text);
      return;
    }

    if (event.type === "conversation.item.input_audio_transcription.completed") {
      const text = event.transcript ?? event.text ?? "";
      persistTranscriptTurn("USUARIO", text);
      return;
    }

    if (event.type === "response.created") {
      responseActive = true;
      activeResponseId = event.response?.id ?? event.response_id ?? null;
      activeAssistantItemId = null;
      playbackTracker.startResponseEpoch(connection.callUuid);
      playbackController.startResponseEpoch();
      return;
    }

    if (event.type === "response.done") {
      responseActive = false;
      activeResponseId = null;
      activeAssistantItemId = null;
      return;
    }

    if (event.type === "session.updated") {
      requestInitialGreeting();
      return;
    }

    if (event.type === "conversation.item.created" && event.item?.type === "function_call") {
      const item = event.item;
      activeToolCalls.set(item.id, { callId: item.call_id, name: item.name, args: "" });
      return;
    }

    if (event.type === "response.function_call_arguments.delta" && event.item_id) {
      const tool = activeToolCalls.get(event.item_id);
      if (tool) {
        tool.args += String(event.delta || "");
      }
      return;
    }

    if (event.type === "response.output_item.done" && activeToolCalls.has(event.item_id)) {
      const tool = activeToolCalls.get(event.item_id);
      activeToolCalls.delete(event.item_id);
      let args = {};
      try {
        args = tool.args ? JSON.parse(tool.args) : {};
      } catch (err) {
        onLog("warn", "argumentos de tool call nao sao JSON valido", {
          connectionId,
          callUuid: connection.callUuid,
          item_id: event.item_id,
          args: tool.args,
          message: err.message,
        });
      }
      handleToolCall(tool.callId, tool.name, args).catch((err) => {
        onLog("error", "handleToolCall falhou", {
          connectionId,
          callUuid: connection.callUuid,
          message: err.message,
        });
      });
      return;
    }

    if (event.type === "response.output_audio.delta" && typeof event.delta === "string") {
      activeAssistantItemId = event.item_id || activeAssistantItemId;
      counters.xaiDeltas += 1;
      const pcm = Buffer.from(event.delta, "base64");
      const deltaBytes = pcm.length;
      counters.xaiDeltaBytes += deltaBytes;
      try {
        if (!playbackController.enqueue(pcm)) counters.xaiDeltasDroppedAfterBargeIn += 1;
      } catch (err) {
        counters.fsStreamAudioFailed += 1;
        onLog("error", "falha ao enviar audio para FreeSWITCH", {
          connectionId,
          callUuid: connection.callUuid,
          message: err.message,
        });
        closePair("server", 1011, "freeswitch audio send failed");
      }
      return;
    }

    if (event.type === "input_audio_buffer.speech_started") {
      counters.speechStartedEvents += 1;
      const speechEventMonotonicMs = monotonicNow();
      const audioStartMs = event.audio_start_ms === undefined || event.audio_start_ms === null
        ? Number.NaN
        : Number(event.audio_start_ms);
      const matchedFrame = Number.isFinite(audioStartMs)
        ? recentInputFrames.find((frame) => (
          audioStartMs >= frame.audioStartMs && audioStartMs < frame.audioEndMs
        ))
        : null;
      const correlatedFrame = matchedFrame ? {
        sequence: matchedFrame.sequence,
        audioStartMs: matchedFrame.audioStartMs,
        audioEndMs: matchedFrame.audioEndMs,
        receivedMonotonicMs: matchedFrame.receivedMonotonicMs,
        appendedMonotonicMs: matchedFrame.appendedMonotonicMs,
        bridgeForwardDelayMs: matchedFrame.bridgeForwardDelayMs,
        speechEventAfterReceiveMs: roundTiming(
          speechEventMonotonicMs - matchedFrame.receivedMonotonicMs,
        ),
        speechEventAfterAppendMs: matchedFrame.appendedMonotonicMs === null
          ? null
          : roundTiming(speechEventMonotonicMs - matchedFrame.appendedMonotonicMs),
        xaiBufferedAmountAtAppend: matchedFrame.xaiBufferedAmountAtAppend,
      } : null;
      const duplicateItem = Boolean(event.item_id && seenSpeechItemIds.has(event.item_id));
      onLog("info", "telemetria VAD speech_started", {
        connectionId,
        callUuid: connection.callUuid,
        monotonicMs: roundTiming(speechEventMonotonicMs),
        audioStartMs: Number.isFinite(audioStartMs) ? audioStartMs : null,
        speechItemId: event.item_id ?? null,
        duplicateItem,
        activeResponseId,
        activeAssistantItemId,
        inputFrame: correlatedFrame,
        bufferedAmount: {
          fsSocket: socketBufferedAmount(fsSocket),
          xaiSocket: socketBufferedAmount(xaiSocket),
        },
        eventLoop: eventLoopMonitor.snapshot(),
      });
      if (duplicateItem) {
        counters.speechStartedDuplicate += 1;
      }
      if (event.item_id) seenSpeechItemIds.add(event.item_id);
      const bargeInAt = now();
      if (bargeInAt - lastBargeInAt < 300) return;
      lastBargeInAt = bargeInAt;
      counters.bargeInCount += 1;

      if (!connection.callUuid || !sendEslApi) {
        onLog("debug", "barge-in sem call_uuid ou ESL; cancel/break indisponivel", { connectionId, callUuid: connection.callUuid });
        return;
      }

      const canBreak = playbackTracker.canBreak(connection.callUuid);
      if (!canBreak) {
        counters.bargeInBreakSkippedNoPlayback += 1;
        playbackTracker.recordBreakSkippedNoPlayback(connection.callUuid);
        onLog("info", "barge-in: cancel/break omitidos; playback ainda nao confirmado", {
          connectionId,
          callUuid: connection.callUuid,
          playback: playbackTracker.snapshot(connection.callUuid),
        });
        return;
      }

      // Evita enviar cancel depois que a resposta ja terminou. Ao aceitar o
      // cancel, o estado local deixa de considerar a resposta ativa para que
      // eventos de fala repetidos nao gerem novos cancels para a mesma resposta.
      if (responseActive && socketIsOpen(xaiSocket)) {
        try {
          sendJson(xaiSocket, { type: "response.cancel" });
          responseActive = false;
          counters.responseCancelSent += 1;
        } catch (err) {
          onLog("warn", "barge-in: response.cancel falhou", { connectionId, callUuid: connection.callUuid, message: err.message });
        }
      } else if (!responseActive) {
        counters.responseCancelSkippedNoActive += 1;
        onLog("debug", "barge-in: response.cancel omitido; sem resposta ativa", {
          connectionId,
          callUuid: connection.callUuid,
        });
      }

      playbackTracker.recordBreak(connection.callUuid);
      playbackController.interrupt();
    }
  });

  xaiSocket.on("error", (err) => {
    onLog("error", "erro no websocket xAI de audio", { connectionId, message: err.message });
    closePair("server", 1011, "xai websocket error");
  });

  xaiSocket.on("close", (code, reason) => {
    closePair("xai", code || 1000, reason?.toString("utf8") || "");
  });

  fsSocket.on("message", (data, isBinary) => {
    if (!isBinary) {
      // O modulo pode enviar metadata JSON como primeira mensagem de texto.
      const metadata = data.toString("utf8");
      try {
        const parsed = JSON.parse(metadata);
        if (validCallUuid(parsed.call_uuid)) {
          connection.callUuid = parsed.call_uuid;
          counters.metadataReceived += 1;
          onLog("info", "metadata do FreeSWITCH recebeu call_uuid", { connectionId, callUuid: connection.callUuid });
        } else {
          onLog("warn", "metadata FreeSWITCH sem call_uuid valido", { connectionId, callUuid: connection.callUuid, metadata });
        }
      } catch {
        onLog("debug", "metadata/texto nao-json do FreeSWITCH ignorado", { connectionId, callUuid: connection.callUuid, metadata });
      }
      return;
    }

    try {
      const pcm16k = Buffer.from(data);
      const receivedMonotonicMs = monotonicNow();
      const audioStartMs = timing.inputAudioCursorMs;
      const audioDurationMs = (pcm16k.length / (16_000 * 2)) * 1_000;
      const frameTiming = {
        sequence: timing.inputFrameSequence + 1,
        audioStartMs: roundTiming(audioStartMs),
        audioEndMs: roundTiming(audioStartMs + audioDurationMs),
        receivedMonotonicMs: roundTiming(receivedMonotonicMs),
        appendedMonotonicMs: null,
        bridgeForwardDelayMs: null,
        xaiBufferedAmountAtAppend: null,
      };
      timing.inputFrameSequence += 1;
      timing.inputAudioCursorMs += audioDurationMs;
      if (recentInputFrames.length < 10_000) {
        recentInputFrames.push(frameTiming);
      } else {
        recentInputFrames[recentInputFrameCursor] = frameTiming;
        recentInputFrameCursor = (recentInputFrameCursor + 1) % recentInputFrames.length;
      }
      counters.fsInputFrames += 1;
      counters.fsInputBytes += pcm16k.length;
      if (shouldSuppressInitialGreetingInput()) {
        counters.inputAppendSuppressedInitialGreeting += 1;
        counters.inputAppendSuppressedInitialGreetingBytes += pcm16k.length;
        timing.lastInputFrame = { ...frameTiming, suppressedInitialGreeting: true };
        return;
      }
      if (xaiSocket.readyState === 0) {
        pendingInputFrames.push({ pcm16k, frameTiming });
        counters.fsPendingFrames = pendingInputFrames.length;
        return;
      }
      if (!socketIsOpen(xaiSocket)) {
        counters.inputAppendFailed += 1;
        return;
      }
      forwardInputFrame(pcm16k, frameTiming);
      counters.inputAppendSent += 1;
      counters.inputAppendBytes += pcm16k.length;
    } catch (err) {
      counters.inputAppendFailed += 1;
      onLog("error", "falha ao encaminhar PCM do FreeSWITCH", {
        connectionId,
        callUuid: connection.callUuid,
        message: err.message,
      });
      closePair("server", 1011, "freeswitch input audio failed");
    }
  });

  fsSocket.on("error", (err) => {
    onLog("error", "erro no websocket FreeSWITCH de audio", {
      connectionId,
      message: err.message,
    });
    closePair("server", 1011, "freeswitch websocket error");
  });

  fsSocket.on("close", (code, reason) => {
    closePair("freeswitch", code || 1000, reason?.toString("utf8") || "");
  });

  connection.close = () => closePair("server", 1001, "server shutdown");
  return connection;
}

/** Cria o listener WebSocket usado pelo mod_audio_stream. */
export function createAudioStreamServer({
  host = "0.0.0.0",
  port = 8830,
  apiKey = loadXaiApiKey(),
  WebSocketServerImpl = WebSocketServer,
  createXaiSocket = defaultCreateXaiSocket,
  onLog = defaultLog,
  env = process.env,
  fetchImpl = globalThis.fetch,
  vbBase = env.VB_BASE,
  vbInternalToken = env.VB_INTERNAL_TOKEN,
  sendEslApi = getSharedEslApiSender({ env, onLog }),
  playbackTracker = createAudioPlaybackTracker(),
  rejectBackoff = createBootstrapRejectBackoff({
    baseDelayMs: parseNonNegativeInteger(env.AUDIO_REJECT_BACKOFF_MS, 250),
    maxDelayMs: parseNonNegativeInteger(env.AUDIO_REJECT_BACKOFF_MAX_MS, 2_000),
  }),
  setTimer = setTimeout,
} = {}) {
  requireVoiceBroadcastConfig({ vbBase, vbInternalToken });
  const server = new WebSocketServerImpl({ host, port });
  const sessions = new Set();
  server.on("connection", (fsSocket) => {
    onLog("info", "FreeSWITCH conectado ao audio stream", {});
    let bootstrapStarted = false;
    let pendingAuthBytes = 0;
    const pendingAuthFrames = [];
    const removeBootstrapListener = () => fsSocket.off("message", handleBootstrapMessage);
    const rejectBootstrap = (reason, logMessage, meta = {}) => {
      removeBootstrapListener();
      const key = validCallUuid(meta.callUuid) ? meta.callUuid : reason;
      const closeDelayMs = rejectBackoff.nextDelay(key);
      onLog("warn", logMessage, { ...meta, closeDelayMs });
      const closeRejectedSocket = () => safeClose(fsSocket, 1008, reason);
      if (closeDelayMs <= 0) {
        closeRejectedSocket();
        return;
      }
      const timer = setTimer(closeRejectedSocket, closeDelayMs);
      timer?.unref?.();
    };
    const handleBootstrapMessage = async (data, isBinary) => {
      if (isBinary) {
        if (!bootstrapStarted) {
          rejectBootstrap("bootstrap token required", "audio stream recusado sem metadata bootstrap", {});
          return;
        }
        const pcm = Buffer.from(data);
        pendingAuthBytes += pcm.length;
        if (pendingAuthBytes > 512 * 1024) {
          rejectBootstrap("bootstrap pending audio overflow", "audio stream recusado por excesso de audio pre-auth", {});
          return;
        }
        pendingAuthFrames.push(pcm);
        return;
      }
      if (bootstrapStarted) return;

      let metadata;
      try { metadata = JSON.parse(data.toString("utf8")); } catch {}
      if (!validCallUuid(metadata?.call_uuid)) {
        rejectBootstrap("valid call_uuid required", "audio stream recusado sem call_uuid valido", {});
        return;
      }
      if (!metadata?.bootstrap_token) {
        rejectBootstrap("bootstrap token required", "audio stream recusado sem bootstrap_token", {});
        return;
      }
      bootstrapStarted = true;

      let bootstrap;
      try {
        bootstrap = await consumeBootstrapToken({
          token: metadata.bootstrap_token,
          callUuid: metadata.call_uuid,
          vbBase,
          vbInternalToken,
          fetchImpl,
        });
      } catch (err) {
        rejectBootstrap("bootstrap token rejected", "audio stream recusado no bootstrap consume", {
          callUuid: validCallUuid(metadata.call_uuid) ? metadata.call_uuid : null,
          status: err.status,
          code: err.code,
        });
        return;
      }
      if (!socketIsOpen(fsSocket)) return;
      removeBootstrapListener();
      rejectBackoff.reset(metadata.call_uuid);
      onLog("info", "bootstrap consume aceito", {
        callUuid: validCallUuid(metadata.call_uuid) ? metadata.call_uuid : null,
        callId: bootstrap.call_id,
      });

      const session = attachAudioStreamConnection({
        fsSocket,
        apiKey,
        createXaiSocket,
        onLog,
        sendEslApi,
        playbackTracker,
        metadata,
        sessionConfig: bootstrap.session_config,
        agent: bootstrap.agent,
        callId: bootstrap.call_id,
        vbBase,
        vbInternalToken,
        fetchImpl,
        env,
      });
      session.callId = bootstrap.call_id;
      sessions.add(session);
      const forgetSession = () => sessions.delete(session);
      fsSocket.once("close", forgetSession);
      session.xaiSocket.once("close", forgetSession);
      for (const pcm of pendingAuthFrames) fsSocket.emit("message", pcm, true);
    };
    fsSocket.on("message", handleBootstrapMessage);
  });
  server.on("error", (err) => onLog("error", "erro no listener audio stream", { message: err.message }));
  server.closeAudioStreams = () => {
    for (const session of sessions) session.close();
    sessions.clear();
  };
  server.audioPlaybackTracker = playbackTracker;
  return server;
}
