import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { EslApiClient } from "../src/audio-esl-client.js";
import { attachEslObserver, startAudioStreamServer } from "../src/audio-stream.js";

class FakeServer extends EventEmitter {
  constructor() {
    super();
    this.closed = false;
  }

  closeAudioStreams() {}

  close(callback) {
    this.closed = true;
    callback?.();
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

async function waitForWrites(socket, count, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (socket.writes.length < count) {
    if (Date.now() > deadline) {
      throw new Error(`timeout aguardando write ${count}; atual=${socket.writes.length}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function waitForCondition(predicate, label, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timeout aguardando ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function replyAfterWrite(socket, count, frame) {
  await waitForWrites(socket, count);
  socket.emit("data", frame);
}

test("entrypoint assina observer ESL apos auth", async () => {
  const socket = new FakeEslSocket();
  const logs = [];
  const server = new FakeServer();
  const client = new EslApiClient({
    password: "senha-esl",
    connect: () => socket,
    onLog: () => {},
  });

  startAudioStreamServer({
    env: { AUDIO_WS_PORT: "8830", XAI_API_KEY: "x" },
    apiKey: "x",
    onLog: (level, message, meta) => logs.push({ level, message, meta }),
    createServer: () => server,
    getEslClient: () => client,
  });

  server.emit("listening");
  socket.emit("data", Buffer.from("Content-Type: auth/request\n\n"));
  await waitForWrites(socket, 1);
  socket.emit("data", Buffer.from("Reply-Text: +OK accepted\n\n"));
  await replyAfterWrite(socket, 2, Buffer.from("Content-Type: command/reply\nReply-Text: +OK event listener enabled\n\n"));
  await replyAfterWrite(socket, 3, Buffer.from("Content-Type: command/reply\nReply-Text: +OK event listener enabled\n\n"));
  await waitForCondition(
    () => logs.some((entry) => entry.message === "observer ESL: assinatura ativa"),
    "log de assinatura ativa"
  );

  assert.deepEqual(socket.writes, [
    "auth senha-esl\n\n",
    "event plain CUSTOM mod_audio_stream::connect mod_audio_stream::disconnect mod_audio_stream::error mod_audio_stream::json mod_audio_stream::play mod_audio_stream::playback\n\n",
    "event plain CHANNEL_EXECUTE CHANNEL_EXECUTE_COMPLETE\n\n",
  ]);
  client.close();
});

test("entrypoint reassina eventos depois de reconexao ESL", async () => {
  const sockets = [];
  const server = new FakeServer();
  const client = new EslApiClient({
    password: "senha-esl",
    persistent: true,
    reconnectDelayMs: 0,
    connect: () => {
      const socket = new FakeEslSocket();
      sockets.push(socket);
      return socket;
    },
    onLog: () => {},
  });

  startAudioStreamServer({
    env: { AUDIO_WS_PORT: "8830", XAI_API_KEY: "x" },
    apiKey: "x",
    onLog: () => {},
    createServer: () => server,
    getEslClient: () => client,
  });

  server.emit("listening");
  await waitForCondition(() => sockets.length === 1, "primeira conexao ESL");
  const first = sockets[0];
  first.emit("data", Buffer.from("Content-Type: auth/request\n\n"));
  first.emit("data", Buffer.from("Reply-Text: +OK accepted\n\n"));
  await replyAfterWrite(first, 2, Buffer.from("Content-Type: command/reply\nReply-Text: +OK event listener enabled\n\n"));
  await replyAfterWrite(first, 3, Buffer.from("Content-Type: command/reply\nReply-Text: +OK event listener enabled\n\n"));

  first.emit("close");
  await waitForCondition(() => sockets.length === 2, "reconexao ESL");
  const second = sockets[1];
  second.emit("data", Buffer.from("Content-Type: auth/request\n\n"));
  second.emit("data", Buffer.from("Reply-Text: +OK accepted\n\n"));
  await replyAfterWrite(second, 2, Buffer.from("Content-Type: command/reply\nReply-Text: +OK event listener enabled\n\n"));
  await replyAfterWrite(second, 3, Buffer.from("Content-Type: command/reply\nReply-Text: +OK event listener enabled\n\n"));

  assert.deepEqual(second.writes, [
    "auth senha-esl\n\n",
    "event plain CUSTOM mod_audio_stream::connect mod_audio_stream::disconnect mod_audio_stream::error mod_audio_stream::json mod_audio_stream::play mod_audio_stream::playback\n\n",
    "event plain CHANNEL_EXECUTE CHANNEL_EXECUTE_COMPLETE\n\n",
  ]);
  client.close();
});

test("falha de assinatura ESL e fail-open sem encerrar servidor", async () => {
  const logs = [];
  const server = new FakeServer();
  const client = {
    on() {},
    sendEslCommand: async () => ({ ok: false, reply: "-ERR auth failed" }),
  };

  startAudioStreamServer({
    env: { AUDIO_WS_PORT: "8830", XAI_API_KEY: "x" },
    apiKey: "x",
    onLog: (level, message, meta) => logs.push({ level, message, meta }),
    createServer: () => server,
    getEslClient: () => client,
  });

  server.emit("listening");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(server.closed, false);
  assert.ok(logs.some((entry) => entry.message === "observer ESL: falha ao assinar eventos"));
});

test("observer correlaciona play e playback no tracker pelo call_uuid", () => {
  const logs = [];
  const client = new EventEmitter();
  const calls = [];
  const playbackTracker = {
    recordPlayAccepted: (uuid) => calls.push(["playAccepted", uuid]),
    recordChunkPlayed: (uuid) => calls.push(["chunkPlayed", uuid]),
    recordQueueCompleted: (uuid) => calls.push(["queueCompleted", uuid]),
  };
  attachEslObserver({
    client,
    playbackTracker,
    onLog: (level, message, meta) => logs.push({ level, message, meta }),
  });

  const uuid = "123e4567-e89b-42d3-a456-426614174000";
  client.emit("mod_audio_stream_play", { uuid, body: "file0.tmp" });
  client.emit("playback", { uuid, playbackEvent: "chunk_played", payload: { seq: 0 } });
  client.emit("playback", { uuid, playbackEvent: "queue_completed", payload: {} });

  assert.deepEqual(calls, [
    ["playAccepted", uuid],
    ["chunkPlayed", uuid],
    ["queueCompleted", uuid],
  ]);
});

test("observer agrega logs play e playback por janela sem perder contadores", () => {
  const logs = [];
  const client = new EventEmitter();
  const timers = [];
  const calls = [];
  attachEslObserver({
    client,
    aggregateWindowMs: 1_000,
    setTimer: (callback, delayMs) => {
      const timer = { callback, delayMs };
      timers.push(timer);
      return timer;
    },
    clearTimer: () => {},
    playbackTracker: {
      recordPlayAccepted: (uuid) => calls.push(["play", uuid]),
      recordChunkPlayed: (uuid) => calls.push(["chunk", uuid]),
      recordQueueCompleted: (uuid) => calls.push(["queue", uuid]),
    },
    onLog: (level, message, meta) => logs.push({ level, message, meta }),
  });

  const uuid = "123e4567-e89b-42d3-a456-426614174000";
  client.emit("mod_audio_stream_play", { uuid, body: "frame-1" });
  client.emit("mod_audio_stream_play", { uuid, body: "frame-2" });
  client.emit("playback", { uuid, playbackEvent: "chunk_played", payload: { seq: 1 } });
  client.emit("playback", { uuid, playbackEvent: "chunk_played", payload: { seq: 2 } });
  client.emit("playback", { uuid, playbackEvent: "queue_completed", payload: {} });

  assert.equal(logs.some((entry) => entry.message === "observer ESL: play"), false);
  assert.equal(logs.some((entry) => entry.message === "observer ESL: playback"), false);
  assert.equal(timers.length, 1, "uma unica janela deve agregar todos os eventos");
  timers[0].callback();

  const summary = logs.find((entry) => entry.message === "observer ESL: resumo play/playback");
  assert.deepEqual(summary.meta, {
    uuid,
    windowMs: 1_000,
    play: 2,
    playback: 3,
    chunkPlayed: 2,
    queueCompleted: 1,
    otherPlayback: 0,
  });
  assert.equal(calls.length, 5, "tracker continua recebendo cada evento individual");
});

test("observer loga reply de uuid_audio_stream stop e disconnect correlacionados", () => {
  const logs = [];
  const client = new EventEmitter();
  attachEslObserver({
    client,
    onLog: (level, message, meta) => logs.push({ level, message, meta }),
  });

  client.emit("reply", {
    ok: true,
    kind: "api",
    command: "uuid_audio_stream 123e4567-e89b-42d3-a456-426614174000 stop",
    reply: "+OK stopped",
  });
  client.emit("mod_audio_stream_disconnect", {
    uuid: "123e4567-e89b-42d3-a456-426614174000",
    body: "",
  });

  assert.ok(logs.some((entry) =>
    entry.message === "observer ESL: uuid_audio_stream reply"
    && entry.meta.uuid === "123e4567-e89b-42d3-a456-426614174000"
    && entry.meta.action === "stop"
    && entry.meta.ok === true
    && entry.meta.reply === "+OK stopped"));
  assert.ok(logs.some((entry) =>
    entry.message === "observer ESL: disconnect"
    && entry.meta.uuid === "123e4567-e89b-42d3-a456-426614174000"));
});
