import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import * as audioStreamServer from "../src/audio-stream-server.js";
import {
  attachAudioStreamConnection,
  buildAudioStreamStartCommand,
  createAudioStreamServer,
} from "../src/audio-stream-server.js";
import { EslApiClient } from "../src/audio-esl-client.js";

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1;
    this.sent = [];
    this.bufferedAmount = 0;
  }

  send(payload) {
    this.sent.push(payload);
  }

  close(code = 1000, reason = "") {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close", code, Buffer.from(reason));
  }
}

class FakeEslSocket extends EventEmitter {
  constructor() {
    super();
    this.writes = [];
  }

  write(payload) {
    this.writes.push(payload);
  }

  destroy() {
    this.emit("close");
  }
}

class FakeWebSocketServer extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
  }
}

function parsedMessages(socket) {
  return socket.sent.map((message) => JSON.parse(message));
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

function immediateRejectBackoff() {
  return {
    nextDelay: () => 0,
    reset: () => {},
  };
}

const CAMPAIGN_AGENT = Object.freeze({
  name: "Agente Campanha Teste",
  prompt: "PROMPT EXCLUSIVO DA CAMPANHA",
  greeting: "Ola, esta e a saudacao exclusiva da campanha.",
  language: "pt-BR",
  model: "grok-voice-think-fast-1.0",
  voice: "ara",
  speed: 1.25,
  vad_enabled: 1,
  vad_threshold: 0.62,
  vad_silence_ms: 550,
  max_duration_sec: 420,
  transfer_enabled: 1,
  transfer_target: "2001",
  transfer_timeout_sec: 30,
  handoff_team_id: 7,
  fallback_enabled: 1,
  fallback_text: "Retorno por WhatsApp",
  fallback_whatsapp_template_name: "retorno_voz",
  fallback_whatsapp_inbox_id: 9,
});

const CAMPAIGN_SESSION_CONFIG = Object.freeze({
  type: "session.update",
  session: {
    model: CAMPAIGN_AGENT.model,
    voice: CAMPAIGN_AGENT.voice,
    speed: CAMPAIGN_AGENT.speed,
    instructions: CAMPAIGN_AGENT.prompt,
    turn_detection: {
      type: "server_vad",
      threshold: CAMPAIGN_AGENT.vad_threshold,
      silence_duration_ms: CAMPAIGN_AGENT.vad_silence_ms,
    },
  },
});

function greetingInstructions(greeting = CAMPAIGN_AGENT.greeting) {
  return [
    `Diga exatamente: "${greeting}"`,
    "Use tom natural de pergunta curta, com entonacao ascendente em cada pergunta e uma pausa breve entre elas.",
    "Nao acrescente outras frases.",
  ].join(" ");
}

test("servidor recusa metadata sem bootstrap_token sem abrir xAI", async () => {
  const xaiRequests = [];
  const fetchCalls = [];
  const server = createAudioStreamServer({
    apiKey: "test-api-key",
    env: {
      VB_BASE: "http://voice-broadcast.internal",
      VB_INTERNAL_TOKEN: "internal-test-token",
    },
    WebSocketServerImpl: FakeWebSocketServer,
    fetchImpl: async (...args) => {
      fetchCalls.push(args);
      return new Response(JSON.stringify({ error: "unexpected_call" }), { status: 500 });
    },
    createXaiSocket: (request) => {
      xaiRequests.push(request);
      return new FakeSocket();
    },
    sendEslApi: null,
    rejectBackoff: immediateRejectBackoff(),
    onLog: () => {},
  });
  const fsSocket = new FakeSocket();

  server.emit("connection", fsSocket);
  fsSocket.emit("message", Buffer.from(JSON.stringify({ call_uuid: "call-without-token" })), false);
  await nextTurn();

  assert.deepEqual(fetchCalls, []);
  assert.deepEqual(xaiRequests, []);
  assert.equal(fsSocket.readyState, 3);
});

test("servidor recusa metadata sem call_uuid antes de consumir token", async () => {
  const xaiRequests = [];
  const fetchCalls = [];
  const server = createAudioStreamServer({
    apiKey: "test-api-key",
    env: {
      VB_BASE: "http://voice-broadcast.internal",
      VB_INTERNAL_TOKEN: "internal-test-token",
    },
    WebSocketServerImpl: FakeWebSocketServer,
    fetchImpl: async (...args) => {
      fetchCalls.push(args);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
    createXaiSocket: (request) => {
      xaiRequests.push(request);
      return new FakeSocket();
    },
    sendEslApi: null,
    rejectBackoff: immediateRejectBackoff(),
    onLog: () => {},
  });
  const fsSocket = new FakeSocket();

  server.emit("connection", fsSocket);
  fsSocket.emit("message", Buffer.from(JSON.stringify({
    bootstrap_token: "valid-bootstrap-token",
  })), false);
  await nextTurn();

  assert.deepEqual(fetchCalls, []);
  assert.deepEqual(xaiRequests, []);
  assert.equal(fsSocket.readyState, 3);
});

test("servidor recusa consume 401 sem abrir xAI", async () => {
  const xaiRequests = [];
  const fetchCalls = [];
  const server = createAudioStreamServer({
    apiKey: "test-api-key",
    env: {
      VB_BASE: "http://voice-broadcast.internal/",
      VB_INTERNAL_TOKEN: "internal-test-token",
    },
    WebSocketServerImpl: FakeWebSocketServer,
    fetchImpl: async (url, options) => {
      fetchCalls.push({ url, options });
      return new Response(JSON.stringify({ error: "invalid_token" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    },
    createXaiSocket: (request) => {
      xaiRequests.push(request);
      return new FakeSocket();
    },
    sendEslApi: null,
    rejectBackoff: immediateRejectBackoff(),
    onLog: () => {},
  });
  const fsSocket = new FakeSocket();

  server.emit("connection", fsSocket);
  fsSocket.emit("message", Buffer.from(JSON.stringify({
    call_uuid: "call-invalid-token",
    bootstrap_token: "invalid-bootstrap-token",
  })), false);
  await nextTurn();

  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, "http://voice-broadcast.internal/api/internal/bootstrap-token/consume");
  assert.equal(fetchCalls[0].options.method, "POST");
  assert.equal(fetchCalls[0].options.headers.Authorization, "Bearer internal-test-token");
  assert.deepEqual(JSON.parse(fetchCalls[0].options.body), { token: "invalid-bootstrap-token", call_uuid: "call-invalid-token" });
  assert.deepEqual(xaiRequests, []);
  assert.equal(fsSocket.readyState, 3);
});

test("audio stream falha no start quando falta configuracao interna do voice-broadcast", () => {
  assert.throws(
    () => createAudioStreamServer({
      apiKey: "test-api-key",
      env: {},
      WebSocketServerImpl: FakeWebSocketServer,
      sendEslApi: null,
      onLog: () => {},
    }),
    /VB_BASE, VB_INTERNAL_TOKEN/,
  );
});

test("recusas de bootstrap usam backoff antes de fechar a conexao", async () => {
  const logs = [];
  const timers = [];
  let now = 1_000;
  const server = createAudioStreamServer({
    apiKey: "test-api-key",
    env: {
      VB_BASE: "http://voice-broadcast.internal",
      VB_INTERNAL_TOKEN: "internal-test-token",
    },
    WebSocketServerImpl: FakeWebSocketServer,
    sendEslApi: null,
    rejectBackoff: audioStreamServer.createBootstrapRejectBackoff({
      baseDelayMs: 100,
      maxDelayMs: 250,
      now: () => now,
    }),
    setTimer: (callback, delayMs) => {
      const timer = { callback, delayMs, unref: () => {} };
      timers.push(timer);
      return timer;
    },
    onLog: (level, message, meta) => logs.push({ level, message, meta }),
  });

  const firstSocket = new FakeSocket();
  server.emit("connection", firstSocket);
  firstSocket.emit("message", Buffer.from(JSON.stringify({ call_uuid: "retry-call" })), false);
  await nextTurn();
  assert.equal(firstSocket.readyState, 1, "nao deve fechar imediatamente");
  assert.equal(timers[0].delayMs, 100);
  assert.equal(logs.at(-1).meta.closeDelayMs, 100);
  timers[0].callback();
  assert.equal(firstSocket.readyState, 3);

  now += 1_000;
  const secondSocket = new FakeSocket();
  server.emit("connection", secondSocket);
  secondSocket.emit("message", Buffer.from(JSON.stringify({ call_uuid: "retry-call" })), false);
  await nextTurn();
  assert.equal(timers[1].delayMs, 200);
  timers[1].callback();

  now += 1_000;
  const thirdSocket = new FakeSocket();
  server.emit("connection", thirdSocket);
  thirdSocket.emit("message", Buffer.from(JSON.stringify({ call_uuid: "retry-call" })), false);
  await nextTurn();
  assert.equal(timers[2].delayMs, 250);
});

test("consume 200 abre xAI uma vez e aplica config e greeting da campanha", async () => {
  const fetchCalls = [];
  const xaiRequests = [];
  const xaiSocket = new FakeSocket();
  const bootstrapPayload = {
    ok: true,
    call_id: 314,
    agent: CAMPAIGN_AGENT,
    session_config: CAMPAIGN_SESSION_CONFIG,
  };
  const server = createAudioStreamServer({
    apiKey: "test-api-key",
    env: {
      VB_BASE: "http://voice-broadcast.internal",
      VB_INTERNAL_TOKEN: "internal-test-token",
    },
    WebSocketServerImpl: FakeWebSocketServer,
    fetchImpl: async (url, options) => {
      fetchCalls.push({ url, options });
      return new Response(JSON.stringify(bootstrapPayload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    createXaiSocket: (request) => {
      xaiRequests.push(request);
      return xaiSocket;
    },
    sendEslApi: null,
    rejectBackoff: immediateRejectBackoff(),
    onLog: () => {},
  });
  const fsSocket = new FakeSocket();
  const metadata = {
    call_uuid: "call-valid-token",
    bootstrap_token: "single-use-bootstrap-token",
  };

  server.emit("connection", fsSocket);
  assert.deepEqual(xaiRequests, [], "xAI nao pode abrir antes da metadata/consume");
  fsSocket.emit("message", Buffer.from(JSON.stringify(metadata)), false);
  await nextTurn();

  assert.equal(fetchCalls.length, 1);
  assert.equal(xaiRequests.length, 1);
  assert.equal(
    xaiRequests[0].url,
    "wss://api.x.ai/v1/realtime?model=grok-voice-think-fast-1.0",
  );
  xaiSocket.emit("open");
  const sessionUpdate = parsedMessages(xaiSocket)[0];
  assert.equal(sessionUpdate.session.model, CAMPAIGN_AGENT.model);
  assert.equal(sessionUpdate.session.voice, CAMPAIGN_AGENT.voice);
  assert.equal(sessionUpdate.session.speed, CAMPAIGN_AGENT.speed);
  assert.equal(sessionUpdate.session.instructions, CAMPAIGN_AGENT.prompt);

  assert.deepEqual(parsedMessages(xaiSocket).at(-1), {
    type: "response.create",
    response: { instructions: greetingInstructions() },
  });

  fsSocket.emit("message", Buffer.from(JSON.stringify(metadata)), false);
  await nextTurn();
  assert.equal(fetchCalls.length, 1, "bootstrap token deve ser consumido uma unica vez por conexao");
  fsSocket.close(1000, "end");
});

test("consume 200 sem agent/session_config e recusado sem fallback fixo", async () => {
  const xaiRequests = [];
  const server = createAudioStreamServer({
    apiKey: "test-api-key",
    env: {
      VB_BASE: "http://voice-broadcast.internal",
      VB_INTERNAL_TOKEN: "internal-test-token",
    },
    WebSocketServerImpl: FakeWebSocketServer,
    fetchImpl: async () => new Response(JSON.stringify({ ok: true, call_id: 315 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    createXaiSocket: (request) => {
      xaiRequests.push(request);
      return new FakeSocket();
    },
    sendEslApi: null,
    rejectBackoff: immediateRejectBackoff(),
    onLog: () => {},
  });
  const fsSocket = new FakeSocket();

  server.emit("connection", fsSocket);
  fsSocket.emit("message", Buffer.from(JSON.stringify({
    call_uuid: "call-incomplete-bootstrap",
    bootstrap_token: "valid-but-incomplete-bootstrap",
  })), false);
  await nextTurn();

  assert.deepEqual(xaiRequests, []);
  assert.equal(fsSocket.readyState, 3);
});

test("PCM recebido durante o consume e preservado ate a xAI abrir", async () => {
  let resolveFetch;
  const xaiSocket = new FakeSocket();
  xaiSocket.readyState = 0;
  const server = createAudioStreamServer({
    apiKey: "test-api-key",
    env: {
      VB_BASE: "http://voice-broadcast.internal",
      VB_INTERNAL_TOKEN: "internal-test-token",
    },
    WebSocketServerImpl: FakeWebSocketServer,
    fetchImpl: () => new Promise((resolve) => { resolveFetch = resolve; }),
    createXaiSocket: () => xaiSocket,
    sendEslApi: null,
    onLog: () => {},
  });
  const fsSocket = new FakeSocket();
  const pcm = Buffer.from([0x00, 0x80, 0xff, 0x7f]);

  server.emit("connection", fsSocket);
  fsSocket.emit("message", Buffer.from(JSON.stringify({
    call_uuid: "call-pending-auth-audio",
    bootstrap_token: "valid-bootstrap-token",
  })), false);
  fsSocket.emit("message", pcm, true);
  resolveFetch(new Response(JSON.stringify({
    ok: true,
    call_id: 316,
    agent: CAMPAIGN_AGENT,
    session_config: CAMPAIGN_SESSION_CONFIG,
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
  await nextTurn();

  xaiSocket.readyState = 1;
  xaiSocket.emit("open");
  assert.deepEqual(parsedMessages(xaiSocket).at(-1), {
    type: "input_audio_buffer.append",
    audio: pcm.toString("base64"),
  });
  fsSocket.close(1000, "end");
});

function makePair({
  sendEslApi = null,
  now,
  onLog,
  playbackTracker,
  writeTranscript,
  transcriptDir,
  setTimer,
  clearTimer,
  monotonicNow,
  telemetrySetTimer,
  telemetryClearTimer,
  sessionConfig = CAMPAIGN_SESSION_CONFIG,
  agent = CAMPAIGN_AGENT,
  env = { AUDIO_OUTPUT_SAMPLE_RATE: "16000", AUDIO_OUTPUT_GAIN: "1" },
} = {}) {
  const fsSocket = new FakeSocket();
  const xaiSocket = new FakeSocket();
  const xaiRequests = [];
  const connection = attachAudioStreamConnection({
    fsSocket,
    apiKey: "test-api-key",
    createXaiSocket: (request) => {
      xaiRequests.push(request);
      return xaiSocket;
    },
    onLog: onLog || (() => {}),
    sendEslApi,
    now,
    playbackTracker,
    writeTranscript,
    transcriptDir,
    setTimer,
    clearTimer,
    monotonicNow,
    telemetrySetTimer,
    telemetryClearTimer,
    sessionConfig,
    agent,
    env,
  });
  return { fsSocket, xaiSocket, xaiRequests, connection };
}

test("session.update usa model, prompt, voz e velocidade da campanha", () => {
  const { xaiSocket, xaiRequests, connection } = makePair({
    sessionConfig: CAMPAIGN_SESSION_CONFIG,
    agent: CAMPAIGN_AGENT,
  });

  assert.deepEqual(xaiRequests, [{
    apiKey: "test-api-key",
    url: "wss://api.x.ai/v1/realtime?model=grok-voice-think-fast-1.0",
  }]);
  xaiSocket.emit("open");

  const [sessionUpdate] = parsedMessages(xaiSocket);
  assert.equal(sessionUpdate.type, "session.update");
  assert.equal(sessionUpdate.session.model, CAMPAIGN_AGENT.model);
  assert.equal(sessionUpdate.session.voice, CAMPAIGN_AGENT.voice);
  assert.equal(sessionUpdate.session.speed, CAMPAIGN_AGENT.speed);
  assert.equal(sessionUpdate.session.instructions, CAMPAIGN_AGENT.prompt);
  assert.deepEqual(sessionUpdate.session.audio.input.format, { type: "audio/pcm", rate: 16000 });
  assert.deepEqual(sessionUpdate.session.audio.input.transcription, { model: "grok-transcribe" });
  assert.deepEqual(sessionUpdate.session.audio.output.format, { type: "audio/pcm", rate: 16000 });
  assert.deepEqual(sessionUpdate.session.turn_detection, {
    type: "server_vad",
    threshold: CAMPAIGN_AGENT.vad_threshold,
    silence_duration_ms: CAMPAIGN_AGENT.vad_silence_ms,
  });
  assert.equal(connection.agent.transfer_target, CAMPAIGN_AGENT.transfer_target);
  assert.equal(connection.agent.fallback_text, CAMPAIGN_AGENT.fallback_text);
});

test("persiste transcript acumulado de IA e usuario por call_uuid", () => {
  const writes = [];
  const logs = [];
  const callUuid = "f1d5e0ab-1234-4567-8901-acdeff012345";
  const { fsSocket, xaiSocket } = makePair({
    transcriptDir: "/tmp",
    writeTranscript: (filePath, content) => writes.push({ filePath, content }),
    onLog: (level, message, meta) => logs.push({ level, message, meta }),
  });
  fsSocket.emit("message", Buffer.from(JSON.stringify({ call_uuid: callUuid })), false);

  xaiSocket.emit("message", Buffer.from(JSON.stringify({
    type: "response.output_audio_transcript.delta",
    item_id: "assistant-1",
    delta: "Ola, ",
  })));
  xaiSocket.emit("message", Buffer.from(JSON.stringify({
    type: "response.output_audio_transcript.delta",
    item_id: "assistant-1",
    delta: "como vai?",
  })));
  xaiSocket.emit("message", Buffer.from(JSON.stringify({
    type: "response.output_audio_transcript.done",
    item_id: "assistant-1",
  })));
  xaiSocket.emit("message", Buffer.from(JSON.stringify({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "user-1",
    transcript: "Tudo bem.",
  })));

  const transcriptPath = `/tmp/grok-voice-test-${callUuid}.transcript.txt`;
  assert.equal(writes.length, 2);
  assert.deepEqual(writes.at(-1), {
    filePath: transcriptPath,
    content: `call_uuid: ${callUuid}\n\n[IA] Ola, como vai?\n[USUARIO] Tudo bem.\n`,
  });
  assert.deepEqual(
    logs.filter((entry) => entry.message === "transcricao persistida").map((entry) => ({
      speaker: entry.meta.speaker,
      text: entry.meta.text,
      transcriptPath: entry.meta.transcriptPath,
    })),
    [
      { speaker: "IA", text: "Ola, como vai?", transcriptPath },
      { speaker: "USUARIO", text: "Tudo bem.", transcriptPath },
    ],
  );
});

test("nao grava transcript sem call_uuid valido", () => {
  const writes = [];
  const { xaiSocket } = makePair({
    writeTranscript: (filePath, content) => writes.push({ filePath, content }),
  });

  xaiSocket.emit("message", Buffer.from(JSON.stringify({
    type: "response.output_audio_transcript.delta",
    item_id: "assistant-1",
    delta: "texto sem chamada",
  })));
  xaiSocket.emit("message", Buffer.from(JSON.stringify({
    type: "response.output_audio_transcript.done",
    item_id: "assistant-1",
  })));

  assert.deepEqual(writes, []);
});

test("PCM binario do FreeSWITCH vira input_audio_buffer.append em base64", () => {
  const { fsSocket, xaiSocket } = makePair();
  xaiSocket.emit("open");
  const pcm = Buffer.from([0x00, 0x80, 0xff, 0x7f]);

  fsSocket.emit("message", pcm, true);

  const messages = parsedMessages(xaiSocket);
  assert.equal(messages.filter((message) => message.type === "response.create").length, 1);
  assert.deepEqual(messages.at(-1), {
    type: "input_audio_buffer.append",
    audio: pcm.toString("base64"),
  });
});

test("speech_started correlaciona audio_start_ms com frame monotonicamente e backpressure", () => {
  const logs = [];
  let monotonicMs = 1_000;
  const { fsSocket, xaiSocket } = makePair({
    monotonicNow: () => monotonicMs,
    onLog: (level, message, meta) => logs.push({ level, message, meta }),
  });
  const callUuid = "f1d5e0ab-1234-4567-8901-acdeff012345";
  fsSocket.emit("message", Buffer.from(JSON.stringify({ call_uuid: callUuid })), false);
  xaiSocket.emit("open");

  xaiSocket.bufferedAmount = 120;
  fsSocket.emit("message", Buffer.alloc(640), true);
  xaiSocket.emit("message", Buffer.from(JSON.stringify({
    type: "response.created",
    response: { id: "response-1" },
  })));
  xaiSocket.emit("message", Buffer.from(JSON.stringify({
    type: "response.output_audio_transcript.delta",
    item_id: "assistant-item-1",
    delta: "ola",
  })));

  monotonicMs = 1_175;
  fsSocket.bufferedAmount = 33;
  xaiSocket.bufferedAmount = 44;
  xaiSocket.emit("message", Buffer.from(JSON.stringify({
    type: "input_audio_buffer.speech_started",
    item_id: "user-item-1",
    audio_start_ms: 5,
  })));

  const telemetry = logs.find((entry) => entry.message === "telemetria VAD speech_started");
  assert.ok(telemetry, "deve emitir telemetria correlacionada no barge-in");
  assert.equal(telemetry.meta.callUuid, callUuid);
  assert.equal(telemetry.meta.monotonicMs, 1_175);
  assert.equal(telemetry.meta.audioStartMs, 5);
  assert.equal(telemetry.meta.speechItemId, "user-item-1");
  assert.equal(telemetry.meta.activeResponseId, "response-1");
  assert.equal(telemetry.meta.activeAssistantItemId, "assistant-item-1");
  assert.deepEqual(telemetry.meta.inputFrame, {
    sequence: 1,
    audioStartMs: 0,
    audioEndMs: 20,
    receivedMonotonicMs: 1_000,
    appendedMonotonicMs: 1_000,
    bridgeForwardDelayMs: 0,
    speechEventAfterReceiveMs: 175,
    speechEventAfterAppendMs: 175,
    xaiBufferedAmountAtAppend: 120,
  });
  assert.deepEqual(telemetry.meta.bufferedAmount, { fsSocket: 33, xaiSocket: 44 });
  fsSocket.close(1000, "end");
});

test("amostrador mede atraso do event loop sem amostrar por frame", () => {
  const createMonitor = audioStreamServer.createEventLoopLagMonitor;
  assert.ok(createMonitor, "createEventLoopLagMonitor deve existir");
  let clock = 0;
  const timers = [];
  const samples = [];
  const monitor = createMonitor({
    intervalMs: 1_000,
    monotonicNow: () => clock,
    setTimer: (callback, delayMs) => {
      const timer = { callback, delayMs, cancelled: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => { timer.cancelled = true; },
    onSample: (sample) => samples.push(sample),
  });

  assert.equal(timers.length, 1);
  assert.equal(timers[0].delayMs, 1_000);
  clock = 1_125;
  timers[0].callback();
  assert.deepEqual(samples, [{ lagMs: 125, sampledMonotonicMs: 1_125 }]);
  assert.deepEqual(monitor.snapshot(), {
    intervalMs: 1_000,
    samples: 1,
    lastLagMs: 125,
    maxLagMs: 125,
    avgLagMs: 125,
  });
  monitor.stop();
  assert.equal(timers.at(-1).cancelled, true);
});

test("PCM recebido antes da abertura xAI e preservado como frame separado", () => {
  const { fsSocket, xaiSocket } = makePair();
  const pcm = Buffer.from([0x01, 0x02]);

  xaiSocket.readyState = 0;
  fsSocket.emit("message", pcm, true);
  assert.equal(xaiSocket.sent.length, 0);

  xaiSocket.readyState = 1;
  xaiSocket.emit("open");
  const messages = parsedMessages(xaiSocket);
  assert.equal(messages.filter((message) => message.type === "response.create").length, 1);
  assert.deepEqual(messages.at(-1), {
    type: "input_audio_buffer.append",
    audio: pcm.toString("base64"),
  });
});

test("flush de pendingInputFrames atualiza contadores e zera fsPendingFrames", () => {
  const logs = [];
  const { fsSocket, xaiSocket } = makePair({ onLog: (level, message, meta) => logs.push({ level, message, meta }) });
  const pcm = Buffer.from([0x01, 0x02, 0x03, 0x04]);

  xaiSocket.readyState = 0;
  fsSocket.emit("message", pcm, true);
  xaiSocket.readyState = 1;
  xaiSocket.emit("open");
  fsSocket.close(1000, "end");

  const closeLog = logs.find((l) => l.message === "encerrando par de audio");
  const c = closeLog.meta.counters;
  assert.equal(c.fsPendingFrames, 0);
  assert.equal(c.inputAppendSent, 1);
  assert.equal(c.inputAppendBytes, pcm.length);
});

test("PCM 16k da xAI e ritmado em frames de 20ms sem perda de bytes", () => {
  const scheduled = [];
  const { fsSocket, xaiSocket } = makePair({
    setTimer: (callback, delayMs) => {
      const timer = { callback, delayMs, cancelled: false };
      scheduled.push(timer);
      return timer;
    },
    clearTimer: (timer) => { timer.cancelled = true; },
  });
  xaiSocket.emit("open");

  const pcm = Buffer.alloc(16_000 * 2 * 0.4, 0x2a);
  xaiSocket.emit("message", Buffer.from(JSON.stringify({
    type: "response.output_audio.delta",
    delta: pcm.toString("base64"),
  })));

  assert.equal(fsSocket.sent.length, 1);
  assert.equal(parsedMessages(fsSocket)[0].data.sampleRate, 16_000);
  assert.equal(Buffer.from(parsedMessages(fsSocket)[0].data.audioData, "base64").length, 640);
  assert.equal(scheduled[0].delayMs, 20);

  let timerIndex = 0;
  while (timerIndex < scheduled.length && fsSocket.sent.length < 20) {
    const timer = scheduled[timerIndex];
    timerIndex += 1;
    if (!timer.cancelled) timer.callback();
  }
  const output = Buffer.concat(parsedMessages(fsSocket).map((message) => (
    Buffer.from(message.data.audioData, "base64")
  )));
  assert.equal(fsSocket.sent.length, 20);
  assert.deepEqual(output, pcm);
  fsSocket.close(1000, "end");
});

test("saida 8k reamostra com filtro e emite frames de 20ms/320 bytes", () => {
  const scheduled = [];
  const { fsSocket, xaiSocket } = makePair({
    env: { AUDIO_OUTPUT_SAMPLE_RATE: "8000", AUDIO_OUTPUT_GAIN: "1" },
    setTimer: (callback, delayMs) => {
      const timer = { callback, delayMs, cancelled: false };
      scheduled.push(timer);
      return timer;
    },
    clearTimer: (timer) => { timer.cancelled = true; },
  });
  xaiSocket.emit("open");

  const pcm = Buffer.alloc(16_000 * 2 * 0.4);
  for (let offset = 0; offset < pcm.length; offset += 2) {
    pcm.writeInt16LE(offset % 4 === 0 ? 12_000 : -12_000, offset);
  }
  xaiSocket.emit("message", Buffer.from(JSON.stringify({
    type: "response.output_audio.delta",
    delta: pcm.toString("base64"),
  })));

  assert.equal(fsSocket.sent.length, 1);
  const first = parsedMessages(fsSocket)[0];
  assert.equal(first.data.sampleRate, 8_000);
  assert.equal(Buffer.from(first.data.audioData, "base64").length, 320);
  assert.equal(scheduled[0].delayMs, 20);
  fsSocket.close(1000, "end");
});

test("streamAudio falha quando taxa real e taxa declarada divergem", () => {
  assert.throws(
    () => audioStreamServer.buildStreamAudioMessage({
      pcm: Buffer.alloc(640),
      sampleRate: 16_000,
      declaredSampleRate: 24_000,
    }),
    /sampleRate divergente/,
  );
});


test("limitPcm16Peak limita picos sem alterar o buffer original", () => {
  const pcm = Buffer.alloc(8);
  pcm.writeInt16LE(32_000, 0);
  pcm.writeInt16LE(-32_000, 2);
  pcm.writeInt16LE(12_000, 4);
  pcm.writeInt16LE(-12_000, 6);

  const limited = audioStreamServer.limitPcm16Peak(pcm, 24_000);

  assert.equal(limited.readInt16LE(0), 24_000);
  assert.equal(limited.readInt16LE(2), -24_000);
  assert.equal(limited.readInt16LE(4), 12_000);
  assert.equal(limited.readInt16LE(6), -12_000);
  assert.equal(pcm.readInt16LE(0), 32_000);
});

test("applyPcm16Gain reduz ganho antes do limitador", () => {
  const pcm = Buffer.alloc(4);
  pcm.writeInt16LE(30_000, 0);
  pcm.writeInt16LE(-30_000, 2);

  const gained = audioStreamServer.applyPcm16Gain(pcm, 0.5);
  const limited = audioStreamServer.limitPcm16Peak(gained, 24_000);

  assert.equal(gained.readInt16LE(0), 15_000);
  assert.equal(gained.readInt16LE(2), -15_000);
  assert.equal(limited.readInt16LE(0), 15_000);
  assert.equal(limited.readInt16LE(2), -15_000);
  assert.equal(pcm.readInt16LE(0), 30_000);
});

test.skip("fade linear PCM16 de 30ms preserva o inicio e termina em zero sem degraus", () => {
  const applyFade = audioStreamServer.applyLinearPcm16FadeOut;
  assert.ok(applyFade, "applyLinearPcm16FadeOut deve existir");

  const sampleRate = 24_000;
  const samples = Math.round(sampleRate * 0.03);
  const pcm = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) pcm.writeInt16LE(12_000, index * 2);

  const faded = applyFade(pcm, { sampleRate, fadeDurationMs: 30 });
  const amplitudes = Array.from(
    { length: samples },
    (_, index) => Math.abs(faded.readInt16LE(index * 2)),
  );

  assert.equal(amplitudes[0], 12_000);
  assert.ok(amplitudes[Math.floor(samples / 2)] >= 5_900);
  assert.ok(amplitudes[Math.floor(samples / 2)] <= 6_100);
  assert.equal(amplitudes.at(-1), 0);
  assert.ok(amplitudes.every((value, index) => index === 0 || value <= amplitudes[index - 1]));
  assert.equal(pcm.readInt16LE((samples - 1) * 2), 12_000, "nao deve mutar o delta original");
});

test("controlador ritma PCM e conclui fade em frames de 20ms antes do break", async () => {
  const createController = audioStreamServer.createPcmPlaybackController;
  assert.ok(createController, "createPcmPlaybackController deve existir");

  let clock = 0;
  let nextTimerId = 1;
  const timers = new Map();
  const setTimer = (callback, delayMs) => {
    const id = nextTimerId;
    nextTimerId += 1;
    timers.set(id, { callback, at: clock + delayMs });
    return id;
  };
  const clearTimer = (id) => timers.delete(id);
  const advance = async (durationMs) => {
    const target = clock + durationMs;
    while (true) {
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      const [id, timer] = due;
      timers.delete(id);
      clock = timer.at;
      timer.callback();
      await Promise.resolve();
    }
    clock = target;
  };

  const frames = [];
  const breaks = [];
  const controller = createController({
    sampleRate: 24_000,
    frameDurationMs: 20,
    fadeDurationMs: 30,
    sendFrame: (pcm, meta) => frames.push({ pcm, meta, at: clock }),
    onBreak: () => breaks.push(clock),
    setTimer,
    clearTimer,
  });
  const pcm = Buffer.alloc(24_000 * 2 * 0.4);
  for (let offset = 0; offset < pcm.length; offset += 2) pcm.writeInt16LE(10_000, offset);

  controller.enqueue(pcm);
  assert.equal(frames.length, 1, "o primeiro frame de 20ms deve sair sem espera");
  assert.equal(frames[0].pcm.length, 24_000 * 2 * 0.02);
  assert.equal(frames[0].meta.kind, "audio");

  controller.interrupt();
  assert.equal(frames.length, 2, "o fade deve entrar imediatamente atras do frame atual");
  assert.equal(frames[1].pcm.length, 24_000 * 2 * 0.02);
  assert.equal(frames[1].meta.kind, "fade");
  assert.equal(frames[1].pcm.readInt16LE(0), 10_000);
  assert.notEqual(frames[1].pcm.readInt16LE(frames[1].pcm.length - 2), 0);

  await advance(20);
  assert.equal(frames.length, 3, "a cauda do fade tambem deve sair em frame inteiro");
  assert.equal(frames[2].pcm.length, 24_000 * 2 * 0.02);
  assert.equal(frames[2].meta.kind, "fade");
  assert.equal(frames[2].pcm.readInt16LE(frames[2].pcm.length - 2), 0);

  await advance(29);
  assert.deepEqual(breaks, [], "nao pode limpar a fila antes de o fade tocar");
  await advance(1);
  assert.deepEqual(breaks, [50]);

  controller.enqueue(pcm);
  await advance(100);
  assert.equal(frames.length, 3, "deltas tardios da resposta cancelada devem ser descartados");

  controller.startResponseEpoch();
  controller.enqueue(pcm);
  assert.equal(frames.length, 4, "uma nova resposta deve reabrir o playback");
  controller.close();
});

test("controlador emite silencio, nao ruido, quando o jitter buffer esvazia", async () => {
  let clock = 0;
  let nextTimerId = 1;
  const timers = new Map();
  const setTimer = (callback, delayMs) => {
    const id = nextTimerId;
    nextTimerId += 1;
    timers.set(id, { callback, at: clock + delayMs });
    return id;
  };
  const clearTimer = (id) => timers.delete(id);
  const advance = async (durationMs) => {
    const target = clock + durationMs;
    while (true) {
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      const [id, timer] = due;
      timers.delete(id);
      clock = timer.at;
      timer.callback();
      await Promise.resolve();
    }
    clock = target;
  };

  const frames = [];
  const controller = audioStreamServer.createPcmPlaybackController({
    sampleRate: 16_000,
    frameDurationMs: 20,
    sendFrame: (pcm, meta) => frames.push({ pcm, meta }),
    now: () => clock,
    setTimer,
    clearTimer,
  });

  controller.enqueue(Buffer.alloc(640, 0x11));
  await advance(130);
  await advance(20);

  const silence = frames.find((frame) => frame.pcm.every((byte) => byte === 0));
  assert.ok(silence, "underflow deve preencher com silencio puro");
  controller.close();
});

test("xAI open fala uma unica vez o greeting da campanha", () => {
  const { xaiSocket } = makePair({
    sessionConfig: CAMPAIGN_SESSION_CONFIG,
    agent: CAMPAIGN_AGENT,
  });
  xaiSocket.emit("open");
  xaiSocket.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));
  xaiSocket.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));

  const greetings = parsedMessages(xaiSocket).filter((message) => message.type === "response.create");
  assert.deepEqual(greetings, [{
    type: "response.create",
    response: { instructions: greetingInstructions() },
  }]);
});

test("nao pede greeting xAI quando a discadora ja tocou a saudacao", () => {
  const { xaiSocket } = makePair({
    sessionConfig: CAMPAIGN_SESSION_CONFIG,
    agent: { ...CAMPAIGN_AGENT, initial_greeting_played: true },
  });
  xaiSocket.emit("open");
  xaiSocket.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));

  const greetings = parsedMessages(xaiSocket).filter((message) => message.type === "response.create");
  assert.deepEqual(greetings, []);
});

test("saudacao pregravada instrui xAI a nao repetir abertura", () => {
  const { xaiSocket } = makePair({
    sessionConfig: CAMPAIGN_SESSION_CONFIG,
    agent: { ...CAMPAIGN_AGENT, initial_greeting_played: true },
  });
  xaiSocket.emit("open");

  const sessionUpdate = parsedMessages(xaiSocket).find((message) => message.type === "session.update");
  assert.match(sessionUpdate.session.instructions, /ja foi reproduzida por audio pre-gravado/);
  assert.match(sessionUpdate.session.instructions, /Nao diga alo/);
});

test("suprime entrada do FreeSWITCH durante a saudacao pregravada", () => {
  let monotonicMs = 1_000;
  const { fsSocket, xaiSocket } = makePair({
    monotonicNow: () => monotonicMs,
    agent: {
      ...CAMPAIGN_AGENT,
      initial_greeting_played: true,
      initial_greeting_audio_ms: 1_000,
    },
    env: {
      AUDIO_OUTPUT_SAMPLE_RATE: "16000",
      AUDIO_OUTPUT_GAIN: "1",
      INITIAL_GREETING_INPUT_SUPPRESS_GUARD_MS: "300",
    },
  });
  xaiSocket.emit("open");

  const pcm = Buffer.from([0x00, 0x80, 0xff, 0x7f]);
  monotonicMs = 1_200;
  fsSocket.emit("message", pcm, true);
  assert.equal(
    parsedMessages(xaiSocket).filter((message) => message.type === "input_audio_buffer.append").length,
    0,
  );

  monotonicMs = 2_350;
  fsSocket.emit("message", pcm, true);
  assert.deepEqual(parsedMessages(xaiSocket).at(-1), {
    type: "input_audio_buffer.append",
    audio: pcm.toString("base64"),
  });
});

function makeBootstrapPair({ fetchImpl, agent = CAMPAIGN_AGENT, sessionConfig = CAMPAIGN_SESSION_CONFIG } = {}) {
  const fsSocket = new FakeSocket();
  const xaiSocket = new FakeSocket();
  const xaiRequests = [];
  const fetchCalls = [];
  const audioServer = createAudioStreamServer({
    apiKey: "test-api-key",
    env: {
      VB_BASE: "http://voice-broadcast.internal",
      VB_INTERNAL_TOKEN: "internal-test-token",
    },
    WebSocketServerImpl: FakeWebSocketServer,
    fetchImpl: async (...args) => {
      fetchCalls.push(args);
      return fetchImpl ? fetchImpl(...args) : new Response(JSON.stringify({ ok: true, call_id: 315, agent, session_config: sessionConfig }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    createXaiSocket: (request) => {
      xaiRequests.push(request);
      return xaiSocket;
    },
    sendEslApi: null,
    rejectBackoff: immediateRejectBackoff(),
    onLog: () => {},
  });
  return { fsSocket, xaiSocket, xaiRequests, fetchCalls, server: audioServer };
}

function functionCallItem(itemId, callId, name) {
  return {
    type: "conversation.item.created",
    item: {
      id: itemId,
      type: "function_call",
      name,
      call_id: callId,
      status: "in_progress",
    },
  };
}

function functionCallArgsDelta(itemId, delta) {
  return {
    type: "response.function_call_arguments.delta",
    item_id: itemId,
    delta,
  };
}

function functionCallDone(itemId) {
  return {
    type: "response.output_item.done",
    item_id: itemId,
    item: { id: itemId, type: "function_call", status: "completed" },
  };
}

test("tool call qualificar_lead dispara S2S outcome e envia function_call_output + response.create", async () => {
  const outcomeCalls = [];
  const fetchImpl = async (url, options) => {
    if (url.includes("/outcome")) {
      outcomeCalls.push({ url, options: { ...options, body: JSON.parse(options.body) } });
      return new Response(JSON.stringify({ ok: true, resultado_para_ia: "Só um momento, vou te transferir." }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ ok: true, call_id: 315, agent: CAMPAIGN_AGENT, session_config: CAMPAIGN_SESSION_CONFIG }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const { fsSocket, xaiSocket, server: audioServer } = makeBootstrapPair({ fetchImpl });

  audioServer.emit("connection", fsSocket);
  fsSocket.emit("message", Buffer.from(JSON.stringify({
    call_uuid: "call-tool-test",
    bootstrap_token: "bootstrap-tool-token",
  })), false);
  await nextTurn();

  xaiSocket.emit("open");
  xaiSocket.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));

  const itemId = "tool-item-1";
  const callId = "tool-call-1";
  xaiSocket.emit("message", Buffer.from(JSON.stringify(functionCallItem(itemId, callId, "qualificar_lead"))));
  xaiSocket.emit("message", Buffer.from(JSON.stringify(functionCallArgsDelta(itemId, '{"resultado":"quente","motivo":"Quer receber no WhatsApp","resumo_curto":"Interesse alto"}'))));
  xaiSocket.emit("message", Buffer.from(JSON.stringify(functionCallDone(itemId))));
  await nextTurn();
  await nextTurn();

  assert.equal(outcomeCalls.length, 1);
  const body = outcomeCalls[0].options.body;
  assert.equal(body.tool, "qualificar_lead");
  assert.equal(body.args.resultado, "quente");
  assert.equal(body.outcome_id.startsWith("outcome-315-"), true);

  const messages = parsedMessages(xaiSocket);
  const output = messages.find((m) => m.type === "conversation.item.create" && m.item?.type === "function_call_output");
  assert.ok(output, "deve enviar function_call_output");
  assert.equal(output.item.call_id, callId);
  const create = messages.filter((m) => m.type === "response.create");
  assert.equal(create.length, 2, "greeting + apos tool");

  fsSocket.close(1000, "end");
});

test("tool call sem call_id usa onToolCall local quando fornecido", async () => {
  const onToolCalls = [];
  const fsSocket = new FakeSocket();
  const xaiSocket = new FakeSocket();
  const connection = attachAudioStreamConnection({
    fsSocket,
    apiKey: "test-api-key",
    createXaiSocket: () => xaiSocket,
    onLog: () => {},
    sessionConfig: CAMPAIGN_SESSION_CONFIG,
    agent: CAMPAIGN_AGENT,
    onToolCall: async (tool, args) => {
      onToolCalls.push({ tool, args });
      return "ok local";
    },
  });

  xaiSocket.emit("open");
  const itemId = "tool-item-local";
  const callId = "tool-call-local";
  xaiSocket.emit("message", Buffer.from(JSON.stringify(functionCallItem(itemId, callId, "qualificar_lead"))));
  xaiSocket.emit("message", Buffer.from(JSON.stringify(functionCallArgsDelta(itemId, '{"resultado":"quente"}'))));
  xaiSocket.emit("message", Buffer.from(JSON.stringify(functionCallDone(itemId))));
  await nextTurn();
  await nextTurn();

  assert.equal(onToolCalls.length, 1);
  assert.equal(onToolCalls[0].tool, "qualificar_lead");
  assert.equal(onToolCalls[0].args.resultado, "quente");
  const output = parsedMessages(xaiSocket).find((m) => m.type === "conversation.item.create" && m.item?.type === "function_call_output");
  assert.ok(output);
  assert.equal(JSON.parse(output.item.output).resultado_para_ia, "ok local");
  fsSocket.close(1000, "end");
});

test("tool call com args JSON invalido nao quebra e envia output neutro", async () => {
  const fsSocket = new FakeSocket();
  const xaiSocket = new FakeSocket();
  attachAudioStreamConnection({
    fsSocket,
    apiKey: "test-api-key",
    createXaiSocket: () => xaiSocket,
    onLog: () => {},
    sessionConfig: CAMPAIGN_SESSION_CONFIG,
    agent: CAMPAIGN_AGENT,
    onToolCall: async () => "ok",
  });

  xaiSocket.emit("open");
  const itemId = "tool-item-broken";
  const callId = "tool-call-broken";
  xaiSocket.emit("message", Buffer.from(JSON.stringify(functionCallItem(itemId, callId, "qualificar_lead"))));
  xaiSocket.emit("message", Buffer.from(JSON.stringify(functionCallArgsDelta(itemId, "nao-eh-json"))));
  xaiSocket.emit("message", Buffer.from(JSON.stringify(functionCallDone(itemId))));
  await nextTurn();
  await nextTurn();

  const output = parsedMessages(xaiSocket).find((m) => m.type === "conversation.item.create" && m.item?.type === "function_call_output");
  assert.ok(output);
  fsSocket.close(1000, "end");
});

test("fechamento do FreeSWITCH encerra o websocket xAI da mesma chamada", () => {
  const { fsSocket, xaiSocket } = makePair();

  fsSocket.close(1000, "call ended");

  assert.equal(xaiSocket.readyState, 3);
});

test("fechamento da chamada remove o estado de playback correlacionado", () => {
  const deleted = [];
  const tracker = {
    startResponseEpoch() {},
    recordBreakSkippedNoPlayback() {},
    recordBreak() {},
    canBreak: () => false,
    snapshot: () => ({}),
    delete: (uuid) => deleted.push(uuid),
  };
  const { fsSocket } = makePair({ playbackTracker: tracker });
  const callUuid = "f1d5e0ab-1234-4567-8901-acdeff012345";

  fsSocket.emit("message", Buffer.from(JSON.stringify({ call_uuid: callUuid })), false);
  fsSocket.close(1000, "call ended");

  assert.deepEqual(deleted, [callUuid]);
});

test("metadata JSON guarda call_uuid da chamada", () => {
  const { fsSocket, connection } = makePair();

  fsSocket.emit("message", Buffer.from(JSON.stringify({ call_uuid: "f1d5e0ab-1234-4567-8901-acdeff012345" })), false);

  assert.equal(connection.callUuid, "f1d5e0ab-1234-4567-8901-acdeff012345");
});

test("comando start inclui call_uuid e bootstrap_token na metadata", () => {
  const callUuid = "f1d5e0ab-1234-4567-8901-acdeff012345";
  const command = buildAudioStreamStartCommand({
    callUuid,
    wsUrl: "ws://127.0.0.1:8831",
    bootstrapToken: "synthetic-bootstrap-token",
  });

  assert.equal(
    command,
    `uuid_audio_stream ${callUuid} start ws://127.0.0.1:8831 mono 16k {"call_uuid":"${callUuid}","bootstrap_token":"synthetic-bootstrap-token"}`,
  );
});

test("speech_started antes de chunk_played omite break e conta o bloqueio", async () => {
  const commands = [];
  const logs = [];
  let time = 10_000;
  const { fsSocket, xaiSocket } = makePair({
    now: () => time,
    sendEslApi: async (command) => {
      commands.push(command);
      return true;
    },
    onLog: (level, message, meta) => logs.push({ level, message, meta }),
  });
  fsSocket.emit("message", Buffer.from(JSON.stringify({ call_uuid: "f1d5e0ab-1234-4567-8901-acdeff012345" })), false);

  xaiSocket.emit("message", Buffer.from(JSON.stringify({ type: "input_audio_buffer.speech_started" })));
  time += 100;
  xaiSocket.emit("message", Buffer.from(JSON.stringify({ type: "input_audio_buffer.speech_started" })));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(commands, []);
  assert.equal(parsedMessages(xaiSocket).filter((message) => message.type === "response.cancel").length, 0);
  assert.deepEqual(parsedMessages(fsSocket), [], "nao deve aplicar fade sem playback confirmado");
  fsSocket.close(1000, "end");
  const counters = logs.find((entry) => entry.message === "encerrando par de audio").meta.counters;
  assert.equal(counters.bargeInBreakSkippedNoPlayback, 1);
});

test("speech_started repetido marca item duplicado sem mudar a logica de barge-in", () => {
  const logs = [];
  let time = 10_000;
  const { fsSocket, xaiSocket } = makePair({
    now: () => time,
    onLog: (level, message, meta) => logs.push({ level, message, meta }),
  });
  fsSocket.emit("message", Buffer.from(JSON.stringify({
    call_uuid: "f1d5e0ab-1234-4567-8901-acdeff012345",
  })), false);

  xaiSocket.emit("message", Buffer.from(JSON.stringify({
    type: "input_audio_buffer.speech_started",
    item_id: "user-item-1",
  })));
  time += 1_000;
  xaiSocket.emit("message", Buffer.from(JSON.stringify({
    type: "input_audio_buffer.speech_started",
    item_id: "user-item-1",
  })));
  time += 1_000;
  xaiSocket.emit("message", Buffer.from(JSON.stringify({
    type: "input_audio_buffer.speech_started",
    item_id: "user-item-2",
  })));

  fsSocket.close(1000, "end");
  const closeLog = logs.find((entry) => entry.message === "encerrando par de audio");
  assert.equal(closeLog.meta.counters.bargeInCount, 3);
  assert.equal(closeLog.meta.counters.speechStartedDuplicate, 1);
  assert.ok(logs.some((entry) => (
    entry.message === "telemetria VAD speech_started"
    && entry.meta.speechItemId === "user-item-1"
    && entry.meta.duplicateItem === true
  )));
});

test.skip("speech_started envia break", async () => {
  const commands = [];
  const scheduled = [];
  const tracker = audioStreamServer.createAudioPlaybackTracker?.();
  assert.ok(tracker, "createAudioPlaybackTracker deve existir");
  let time = 10_000;
  const { fsSocket, xaiSocket } = makePair({
    playbackTracker: tracker,
    now: () => time,
    sendEslApi: async (command) => {
      commands.push(command);
      return true;
    },
    setTimer: (callback, delayMs) => {
      const timer = { callback, delayMs, cancelled: false };
      scheduled.push(timer);
      return timer;
    },
    clearTimer: (timer) => { timer.cancelled = true; },
  });
  const callUuid = "f1d5e0ab-1234-4567-8901-acdeff012345";
  fsSocket.emit("message", Buffer.from(JSON.stringify({ call_uuid: callUuid })), false);

  xaiSocket.emit("message", Buffer.from(JSON.stringify({ type: "response.created", response: { id: "response-1" } })));
  tracker.recordPlayAccepted(callUuid);
  tracker.recordChunkPlayed(callUuid);
  xaiSocket.emit("message", Buffer.from(JSON.stringify({ type: "input_audio_buffer.speech_started" })));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(parsedMessages(xaiSocket).filter((message) => message.type === "response.cancel").length, 1);
  assert.deepEqual(commands, [], "break deve aguardar a transicao PCM");
  const [fadeMessage] = parsedMessages(fsSocket);
  assert.equal(fadeMessage.data.sampleRate, 16_000);
  assert.equal(Buffer.from(fadeMessage.data.audioData, "base64").length, 960);
  assert.equal(Buffer.from(fadeMessage.data.audioData, "base64").readInt16LE(958), 0);
  assert.equal(scheduled.at(-1).delayMs, 50);
  scheduled.at(-1).callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(commands, [`uuid_audio_stream ${callUuid} break`]);
  assert.equal(tracker.snapshot(callUuid).hasConfirmedPlayback, false);
});

test("tracker correlaciona playback por call_uuid e reseta a cada nova epoca", () => {
  const tracker = audioStreamServer.createAudioPlaybackTracker?.();
  assert.ok(tracker, "createAudioPlaybackTracker deve existir");
  const callUuid = "f1d5e0ab-1234-4567-8901-acdeff012345";

  tracker.startResponseEpoch(callUuid);
  tracker.recordPlayAccepted(callUuid);
  assert.equal(tracker.canBreak(callUuid), false);
  tracker.recordChunkPlayed(callUuid);
  assert.equal(tracker.canBreak(callUuid), true);
  assert.deepEqual(tracker.snapshot(callUuid), {
    playAccepted: 1,
    chunkPlayed: 1,
    queueCompleted: 0,
    hasConfirmedPlayback: true,
    bargeInBreakSkippedNoPlayback: 0,
  });

  tracker.startResponseEpoch(callUuid);
  assert.equal(tracker.canBreak(callUuid), false);
  tracker.recordChunkPlayed(callUuid);
  assert.equal(tracker.canBreak(callUuid), false, "chunk antigo sem play da nova epoca nao pode liberar break");
  tracker.recordPlayAccepted(callUuid);
  tracker.recordChunkPlayed(callUuid);
  assert.equal(tracker.canBreak(callUuid), true);
  tracker.recordQueueCompleted(callUuid);
  assert.equal(tracker.canBreak(callUuid), false);
  tracker.recordBreakSkippedNoPlayback(callUuid);
  assert.equal(tracker.snapshot(callUuid).bargeInBreakSkippedNoPlayback, 1);
});

test("speech_started sem call_uuid nao dispara break", () => {
  const commands = [];
  const { xaiSocket } = makePair({
    sendEslApi: (command) => {
      commands.push(command);
      return Promise.resolve(true);
    },
  });

  assert.doesNotThrow(() => {
    xaiSocket.emit("message", Buffer.from(JSON.stringify({ type: "input_audio_buffer.speech_started" })));
  });
  assert.deepEqual(commands, []);
});

test("speech_started com call_uuid e sem ESL nao quebra o audio", () => {
  const { fsSocket, xaiSocket } = makePair({ sendEslApi: null });
  fsSocket.emit("message", Buffer.from(JSON.stringify({ call_uuid: "f1d5e0ab-1234-4567-8901-acdeff012345" })), false);

  assert.doesNotThrow(() => {
    xaiSocket.emit("message", Buffer.from(JSON.stringify({ type: "input_audio_buffer.speech_started" })));
  });
});

test("cliente ESL autentica e envia break por bgapi na mesma conexao", async () => {
  const socket = new FakeEslSocket();
  const client = new EslApiClient({
    password: "senha-esl",
    connect: () => socket,
    onLog: () => {},
  });
  const sent = client.sendEslApi("uuid_audio_stream f1d5e0ab-1234-4567-8901-acdeff012345 break");

  socket.emit("data", Buffer.from("Content-Type: auth/request\n\n"));
  assert.deepEqual(socket.writes, ["auth senha-esl\n\n"]);

  socket.emit("data", Buffer.from("Reply-Text: +OK accepted\n\n"));
  assert.equal(await sent, true);
  assert.deepEqual(socket.writes, [
    "auth senha-esl\n\n",
    "bgapi uuid_audio_stream f1d5e0ab-1234-4567-8901-acdeff012345 break\n\n",
  ]);
  client.close();
});

test("log seguro de event.type xAI apos parse", () => {
  const logs = [];
  const { xaiSocket } = makePair({ onLog: (level, message, meta) => logs.push({ level, message, meta }) });
  xaiSocket.emit("open");
  xaiSocket.emit("message", Buffer.from(JSON.stringify({ type: "session.updated", item_id: "item-1" })));

  const log = logs.find((l) => l.message === "evento xAI recebido");
  assert.ok(log, "deve logar evento xAI recebido");
  assert.equal(log.meta.type, "session.updated");
  assert.equal(log.meta.item_id, "item-1");
});

test("contadores de deltas PCM e streamAudio", () => {
  const logs = [];
  const { fsSocket, xaiSocket } = makePair({ onLog: (level, message, meta) => logs.push({ level, message, meta }) });
  xaiSocket.emit("open");

  const delta = Buffer.alloc(16_000 * 2 * 0.4, 0x2a).toString("base64");
  xaiSocket.emit("message", Buffer.from(JSON.stringify({ type: "response.output_audio.delta", delta })));

  const pcm = Buffer.from([0x00, 0x80]);
  fsSocket.emit("message", pcm, true);

  fsSocket.close(1000, "end");

  const closeLog = logs.find((l) => l.message === "encerrando par de audio");
  assert.ok(closeLog, "deve logar close com counters");
  const c = closeLog.meta.counters;
  assert.equal(c.xaiDeltas, 1);
  assert.equal(c.xaiDeltaBytes, 12800);
  assert.equal(c.fsStreamAudioAttempted, 1);
  assert.equal(c.fsStreamAudioSent, 1);
  assert.equal(c.fsStreamAudioBytes, 640);
  assert.equal(c.fsInputFrames, 1);
  assert.equal(c.fsInputBytes, 2);
  assert.equal(c.inputAppendSent, 1);
  assert.equal(c.inputAppendBytes, 2);
});

test("delta com socket FreeSWITCH fechado incrementa attempted e failed sem alterar forwarding", () => {
  const logs = [];
  const { fsSocket, xaiSocket } = makePair({ onLog: (level, message, meta) => logs.push({ level, message, meta }) });
  xaiSocket.emit("open");
  fsSocket.readyState = 3;

  const delta = Buffer.alloc(16_000 * 2 * 0.4, 0x2a).toString("base64");
  xaiSocket.emit("message", Buffer.from(JSON.stringify({ type: "response.output_audio.delta", delta })));
  xaiSocket.close(1000, "done");

  const closeLog = logs.find((l) => l.message === "encerrando par de audio");
  const c = closeLog.meta.counters;
  assert.equal(c.fsStreamAudioAttempted, 1);
  assert.equal(c.fsStreamAudioSent, 0);
  assert.equal(c.fsStreamAudioFailed, 1);
  assert.equal(c.fsStreamAudioFailedSocketClosed, 1);
  assert.equal(fsSocket.sent.length, 0);
});

test("evento error nested vence valores legacy", () => {
  const logs = [];
  const { xaiSocket } = makePair({ onLog: (level, message, meta) => logs.push({ level, message, meta }) });

  xaiSocket.emit("message", Buffer.from(JSON.stringify({
    type: "error",
    event_id: "evt-nested-1",
    code: "legacy-code-ignored",
    message: "legacy message ignored",
    param: "legacy-param-ignored",
    error: {
      type: "rate_limit_exceeded",
      code: "rate_limit_code",
      message: "Rate limit exceeded",
      param: "requests_per_minute",
    },
  })));

  const errors = logs.filter((l) => l.message === "erro da xAI no transporte de audio");
  assert.equal(errors.length, 1);
  assert.equal(errors[0].meta.event_id, "evt-nested-1");
  assert.equal(errors[0].meta.errorType, "rate_limit_exceeded");
  assert.equal(errors[0].meta.code, "rate_limit_code");
  assert.equal(errors[0].meta.message, "Rate limit exceeded");
  assert.equal(errors[0].meta.param, "requests_per_minute");
});

test("evento error legacy sem nested usa fallback", () => {
  const logs = [];
  const { xaiSocket } = makePair({ onLog: (level, message, meta) => logs.push({ level, message, meta }) });

  xaiSocket.emit("message", Buffer.from(JSON.stringify({
    type: "error",
    event_id: "evt-legacy-1",
    code: "quota_exceeded",
    message: "Quota exceeded",
    param: "tokens",
  })));

  const errors = logs.filter((l) => l.message === "erro da xAI no transporte de audio");
  assert.equal(errors.length, 1);
  assert.equal(errors[0].meta.event_id, "evt-legacy-1");
  assert.equal(errors[0].meta.errorType, undefined);
  assert.equal(errors[0].meta.code, "quota_exceeded");
  assert.equal(errors[0].meta.message, "Quota exceeded");
  assert.equal(errors[0].meta.param, "tokens");
});
