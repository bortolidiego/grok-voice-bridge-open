import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { EslApiClient } from "../src/audio-esl-client.js";

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

function makeClient() {
  const logs = [];
  const socket = new FakeEslSocket();
  const client = new EslApiClient({
    password: "senha-esl",
    connect: () => socket,
    onLog: (level, message, meta) => logs.push({ level, message, meta }),
  });
  // Cria conexao e registra listener de data (igual ao comportamento real).
  client.ensureConnected();
  return { client, socket, logs };
}

function eslFrame(headers, body = "") {
  const h = Array.isArray(headers) ? headers.join("\n") : headers;
  if (!body) return `${h}\n\n`;
  const b = typeof body === "string" ? body : JSON.stringify(body);
  return `Content-Length: ${Buffer.byteLength(b)}\n${h}\n\n${b}`;
}

function eventPlainFrame(headers, body = "") {
  const h = Array.isArray(headers) ? headers.join("\n") : headers;
  const b = typeof body === "string" ? body : JSON.stringify(body);
  const inner = b ? `${h}\nContent-Length: ${Buffer.byteLength(b)}\n\n${b}` : `${h}\n\n`;
  return `Content-Type: text/event-plain\nContent-Length: ${Buffer.byteLength(inner)}\n\n${inner}`;
}

test("emite eventos de conexao, autenticacao e desconexao", async () => {
  const logs = [];
  const socket = new FakeEslSocket();
  const client = new EslApiClient({
    password: "senha-esl",
    connect: () => socket,
    onLog: (level, message, meta) => logs.push({ level, message, meta }),
  });

  const events = [];
  client.on("connecting", (m) => events.push(["connecting", m]));
  client.on("authenticated", () => events.push(["authenticated"]));
  client.on("disconnect", () => events.push(["disconnect"]));

  client.sendEslApi("uuid_audio_stream uuid-1 break");
  socket.emit("data", Buffer.from("Content-Type: auth/request\n\n"));
  socket.emit("data", Buffer.from("Reply-Text: +OK accepted\n\n"));
  socket.emit("close");

  assert.deepEqual(events.map((e) => e[0]), ["connecting", "authenticated", "disconnect"]);
});

test("parseia subclass playback e extrai chunk_played do Body JSON", () => {
  const { client, socket } = makeClient();
  const events = [];
  client.on("playback", (m) => events.push(["playback", m.playbackEvent]));
  client.on("chunk_played", (m) => events.push(["chunk_played", m.uuid]));
  client.on("queue_completed", (m) => events.push(["queue_completed", m.uuid]));

  const frame = eventPlainFrame(
    ["Event-Name: CUSTOM", "Event-Subclass: mod_audio_stream::playback", "Unique-ID: uuid-123"],
    { event: "chunk_played", seq: 5, size: 320 }
  );

  socket.emit("data", Buffer.from(frame));

  assert.deepEqual(events, [
    ["playback", "chunk_played"],
    ["chunk_played", "uuid-123"],
  ]);
});

test("parseia subclass playback e extrai queue_completed do Body JSON", () => {
  const { client, socket } = makeClient();
  const events = [];
  client.on("playback", (m) => events.push(["playback", m.playbackEvent]));
  client.on("chunk_played", (m) => events.push(["chunk_played", m.uuid]));
  client.on("queue_completed", (m) => events.push(["queue_completed", m.uuid]));

  const frame = eventPlainFrame(
    ["Event-Name: CUSTOM", "Event-Subclass: mod_audio_stream::playback", "Unique-ID: uuid-456"],
    { event: "queue_completed", total_chunks: 42 }
  );

  socket.emit("data", Buffer.from(frame));

  assert.deepEqual(events, [
    ["playback", "queue_completed"],
    ["queue_completed", "uuid-456"],
  ]);
});

test("cliente ESL nao loga eventos play/playback por frame mas continua emitindo", () => {
  const { client, socket, logs } = makeClient();
  const events = [];
  client.on("mod_audio_stream_play", ({ uuid }) => events.push(["play", uuid]));
  client.on("playback", ({ uuid, playbackEvent }) => events.push([playbackEvent, uuid]));

  const play = eventPlainFrame(
    ["Event-Name: CUSTOM", "Event-Subclass: mod_audio_stream::play", "Unique-ID: uuid-quiet"],
    "frame",
  );
  const playback = eventPlainFrame(
    ["Event-Name: CUSTOM", "Event-Subclass: mod_audio_stream::playback", "Unique-ID: uuid-quiet"],
    { event: "chunk_played", seq: 1 },
  );
  socket.emit("data", Buffer.from(play + playback));

  assert.deepEqual(events, [
    ["play", "uuid-quiet"],
    ["chunk_played", "uuid-quiet"],
  ]);
  const noisyMessages = new Set([
    "esl: subclass",
    "esl: mod_audio_stream play",
    "esl: playback",
    "esl: chunk_played",
    "esl: queue_completed",
  ]);
  assert.deepEqual(logs.filter((entry) => noisyMessages.has(entry.message)), []);
});

test("NAO trata queue_completed nem chunk_played como subclass direto", () => {
  const { client, socket } = makeClient();
  const subclasses = [];
  client.on("subclass", (m) => subclasses.push(m.subclass));

  const frame = eventPlainFrame(
    ["Event-Name: CUSTOM", "Event-Subclass: mod_audio_stream::playback", "Unique-ID: uuid-789"],
    { event: "queue_completed", total_chunks: 1 }
  );

  socket.emit("data", Buffer.from(frame));

  assert.ok(!subclasses.includes("mod_audio_stream::queue_completed"), "queue_completed nao deve ser subclass");
  assert.ok(!subclasses.includes("mod_audio_stream::chunk_played"), "chunk_played nao deve ser subclass");
  assert.ok(subclasses.includes("mod_audio_stream::playback"), "playback deve ser subclass");
});

test("fragmentacao: evento dividido em varios chunks e reconstruido", () => {
  const { client, socket } = makeClient();
  const events = [];
  client.on("chunk_played", (m) => events.push(m.uuid));

  const frame = eventPlainFrame(
    ["Event-Name: CUSTOM", "Event-Subclass: mod_audio_stream::playback", "Unique-ID: uuid-frag"],
    { event: "chunk_played", seq: 1, size: 160 }
  );

  for (let i = 0; i < frame.length; i += 7) {
    socket.emit("data", Buffer.from(frame.slice(i, i + 7)));
  }

  assert.deepEqual(events, ["uuid-frag"]);
});

test("coalescencia: varios frames em um unico chunk", () => {
  const { client, socket } = makeClient();
  const events = [];
  client.on("chunk_played", (m) => events.push(m.uuid));
  client.on("queue_completed", (m) => events.push(m.uuid));

  const f1 = eventPlainFrame(
    ["Event-Name: CUSTOM", "Event-Subclass: mod_audio_stream::playback", "Unique-ID: uuid-c1"],
    { event: "chunk_played", seq: 1 }
  );
  const f2 = eventPlainFrame(
    ["Event-Name: CUSTOM", "Event-Subclass: mod_audio_stream::playback", "Unique-ID: uuid-c2"],
    { event: "queue_completed", total_chunks: 10 }
  );

  socket.emit("data", Buffer.from(f1 + f2));

  assert.deepEqual(events, ["uuid-c1", "uuid-c2"]);
});

test("framing usa Content-Length em bytes com UTF-8 fragmentado e frame coalescido", () => {
  const { client, socket } = makeClient();
  const events = [];
  client.on("playback", (m) => events.push(m));

  const first = Buffer.from(eventPlainFrame(
    ["Event-Name: CUSTOM", "Event-Subclass: mod_audio_stream::playback", "Unique-ID: uuid-utf8"],
    JSON.stringify({ event: "chunk_played", text: "olá €" })
  ));
  const second = Buffer.from(eventPlainFrame(
    ["Event-Name: CUSTOM", "Event-Subclass: mod_audio_stream::playback", "Unique-ID: uuid-next"],
    JSON.stringify({ event: "queue_completed", total_chunks: 2 })
  ));
  const euro = Buffer.from("€");
  const splitAt = first.indexOf(euro) + 1;

  socket.emit("data", first.subarray(0, splitAt));
  socket.emit("data", Buffer.concat([first.subarray(splitAt), second]));

  assert.equal(events.length, 2);
  assert.equal(events[0].uuid, "uuid-utf8");
  assert.equal(events[0].payload.text, "olá €");
  assert.equal(events[1].uuid, "uuid-next");
});

test("emite eventos assinados mod_audio_stream connect/disconnect/error/json/play", () => {
  const { client, socket } = makeClient();
  const events = [];
  client.on("mod_audio_stream_connect", (m) => events.push(["connect", m.uuid]));
  client.on("mod_audio_stream_disconnect", (m) => events.push(["disconnect", m.uuid]));
  client.on("mod_audio_stream_error", (m) => events.push(["error", m.uuid]));
  client.on("mod_audio_stream_json", (m) => events.push(["json", m.uuid]));
  client.on("mod_audio_stream_play", (m) => events.push(["play", m.uuid]));

  const frame = (subclass, uuid) =>
    eventPlainFrame(
      ["Event-Name: CUSTOM", `Event-Subclass: mod_audio_stream::${subclass}`, `Unique-ID: ${uuid}`],
      ""
    );

  socket.emit("data", Buffer.from(frame("connect", "u1") + frame("disconnect", "u2") + frame("error", "u3") + frame("json", "u4") + frame("play", "u5")));

  assert.deepEqual(events, [
    ["connect", "u1"],
    ["disconnect", "u2"],
    ["error", "u3"],
    ["json", "u4"],
    ["play", "u5"],
  ]);
});

test("emite audio_stream_event para CHANNEL_EXECUTE com audio_stream", () => {
  const { client, socket } = makeClient();
  const events = [];
  client.on("audio_stream_event", (m) => events.push(m));

  const frame = eventPlainFrame(
    [
      "Event-Name: CHANNEL_EXECUTE",
      "Unique-ID: uuid-exec",
      "Application: uuid_audio_stream",
      "Application-Data: uuid-exec%20ws%3A%2F%2Flocalhost%3A8830%20mono%2016k",
    ],
    ""
  );

  socket.emit("data", Buffer.from(frame));

  assert.equal(events.length, 1);
  assert.equal(events[0].eventName, "CHANNEL_EXECUTE");
  assert.equal(events[0].uuid, "uuid-exec");
  assert.equal(events[0].applicationData, "uuid-exec ws://localhost:8830 mono 16k");
});

test("sendEslCommand aguarda command/reply +OK", async () => {
  const { client, socket } = makeClient();
  socket.emit("data", Buffer.from("Content-Type: auth/request\n\n"));
  socket.emit("data", Buffer.from("Reply-Text: +OK accepted\n\n"));

  const replyPromise = client.sendEslCommand("event json ALL");
  assert.deepEqual(socket.writes.slice(-1), ["event json ALL\n\n"]);

  socket.emit("data", Buffer.from("Content-Type: command/reply\nReply-Text: +OK event listener enabled\n\n"));
  const reply = await replyPromise;

  assert.equal(reply.ok, true);
  assert.equal(reply.reply, "+OK event listener enabled");
  assert.equal(reply.command, "event json ALL");
  assert.equal(reply.kind, "command");
});

test("sendEslApiCommand aguarda api/response e retorna body", async () => {
  const { client, socket } = makeClient();
  socket.emit("data", Buffer.from("Content-Type: auth/request\n\n"));
  socket.emit("data", Buffer.from("Reply-Text: +OK accepted\n\n"));

  const replyPromise = client.sendEslApiCommand("uuid_audio_stream uuid-1 stop");
  assert.deepEqual(socket.writes.slice(-1), ["api uuid_audio_stream uuid-1 stop\n\n"]);

  socket.emit("data", Buffer.from(eslFrame(["Content-Type: api/response"], "+OK stopped")));
  const reply = await replyPromise;

  assert.equal(reply.ok, true);
  assert.equal(reply.reply, "+OK stopped");
  assert.equal(reply.command, "uuid_audio_stream uuid-1 stop");
  assert.equal(reply.kind, "api");
});

test("bgapi ocupa ack pendente e nao desalinha command/reply seguinte", async () => {
  const { client, socket } = makeClient();
  socket.emit("data", Buffer.from("Content-Type: auth/request\n\n"));
  socket.emit("data", Buffer.from("Reply-Text: +OK accepted\n\n"));

  const bgapiPromise = client.sendEslApi("status");
  assert.deepEqual(socket.writes.slice(-1), ["bgapi status\n\n"]);
  await assert.doesNotReject(bgapiPromise);
  assert.equal(socket.writes.length, 2);

  const commandPromise = client.sendEslCommand("event plain CHANNEL_EXECUTE");
  assert.equal(socket.writes.length, 2, "nao deve escrever segundo comando antes do ack do bgapi");

  socket.emit("data", Buffer.from("Content-Type: command/reply\nReply-Text: +OK Job-UUID: bgapi-1\n\n"));
  assert.equal(socket.writes[2], "event plain CHANNEL_EXECUTE\n\n");

  socket.emit("data", Buffer.from("Content-Type: command/reply\nReply-Text: +OK event listener enabled\n\n"));
  const reply = await commandPromise;

  assert.equal(reply.ok, true);
  assert.equal(reply.reply, "+OK event listener enabled");
  assert.equal(reply.command, "event plain CHANNEL_EXECUTE");
  assert.equal(reply.kind, "command");
});

test("erro de socket sem listener consumidor nao lanca", () => {
  const { socket } = makeClient();

  assert.doesNotThrow(() => {
    socket.emit("error", new Error("boom"));
  });
});

test("observer persistente reconecta mesmo sem comando pendente", async () => {
  const sockets = [];
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

  client.ensureConnected();
  assert.equal(sockets.length, 1);
  sockets[0].emit("close");

  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(sockets.length, 2);
  client.close();
});
