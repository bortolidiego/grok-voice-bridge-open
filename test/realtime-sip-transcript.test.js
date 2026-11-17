import assert from "node:assert";
import { EventEmitter } from "node:events";
import test from "node:test";
import { connectRealtime } from "../src/realtime.js";

// Socket falso no formato do `ws`: eventos open/message/close e um send que
// registra o que foi enviado pra xAI.
function makeFakeSocket() {
  const socket = new EventEmitter();
  socket.sent = [];
  socket.readyState = 1;
  socket.send = (payload) => socket.sent.push(JSON.parse(payload));
  socket.emitEvent = (event) => socket.emit("message", Buffer.from(JSON.stringify(event)));
  return socket;
}

function sessionConfig() {
  return {
    type: "session.update",
    session: { instructions: "Seja objetivo.", voice: "eve", model: "grok-voice-latest", speed: 1 },
  };
}

function setup({ vbCallId = 77, reports = [], outcomes = [], clock = { t: 1_000 } } = {}) {
  const socket = makeFakeSocket();
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    if (String(url).includes("/report")) reports.push({ url: String(url), body });
    if (String(url).includes("/outcome")) {
      outcomes.push({ url: String(url), body });
      return new Response(JSON.stringify({ ok: true, resultado_para_ia: "anotado" }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const ws = connectRealtime({
    callId: "call_sip_1",
    apiKey: "xai-test",
    sessionConfig: sessionConfig(),
    agent: { greeting: "Alô?" },
    vbCallId,
    vbBase: "http://vb.test",
    vbInternalToken: "vb-s2s",
    fetchImpl,
    createSocket: () => socket,
    now: () => clock.t,
    onLog: () => {},
  });
  return { ws, socket, reports, outcomes, clock };
}

test("sessao SIP nao declara formato de audio (a midia e da xAI)", () => {
  const { socket } = setup();
  socket.emit("open");
  const update = socket.sent.find(m => m.type === "session.update");
  assert.ok(update, "deve enviar session.update");
  assert.equal(update.session.audio?.output, undefined, "declarar saida faz a xAI mandar audio pro WebSocket");
  assert.equal(update.session.audio?.input?.format, undefined);
  assert.equal(update.session.audio?.input?.transcription?.language_hint, "pt-BR");
});

test("transcricao junta falas do agente e do cliente na ordem e reporta no fim", () => {
  const clock = { t: 10_000 };
  const { socket, reports } = setup({ clock });

  socket.emit("open");
  socket.emitEvent({ type: "response.output_audio_transcript.delta", item_id: "i1", delta: "Alô? " });
  socket.emitEvent({ type: "response.output_audio_transcript.delta", item_id: "i1", delta: "tá me ouvindo?" });
  socket.emitEvent({ type: "response.output_audio_transcript.done", item_id: "i1" });
  socket.emitEvent({ type: "conversation.item.input_audio_transcription.completed", transcript: "Tô sim" });
  socket.emitEvent({ type: "response.output_audio_transcript.delta", item_id: "i2", delta: "Você usa maquininha?" });
  socket.emitEvent({ type: "response.output_audio_transcript.done", item_id: "i2" });

  clock.t = 52_000;
  socket.emit("close", 1006, Buffer.from(""));

  assert.equal(reports.length, 1, "um relatorio por chamada");
  assert.ok(reports[0].url.endsWith("/api/internal/calls/77/report"), reports[0].url);
  assert.equal(reports[0].body.status, "ended");
  assert.equal(reports[0].body.duration_sec, 42);
  assert.deepEqual(JSON.parse(reports[0].body.transcript_json), [
    { speaker: "agente", text: "Alô? tá me ouvindo?" },
    { speaker: "cliente", text: "Tô sim" },
    { speaker: "agente", text: "Você usa maquininha?" },
  ]);
});

test("participant.disconnected seguido de close nao duplica relatorio", () => {
  const { socket, reports } = setup();
  socket.emit("open");
  socket.emitEvent({ type: "response.output_audio_transcript.delta", item_id: "i1", delta: "oi" });
  socket.emitEvent({ type: "response.output_audio_transcript.done", item_id: "i1" });
  socket.emitEvent({ type: "participant.disconnected" });
  socket.emit("close", 1006, Buffer.from(""));
  socket.emit("close", 1006, Buffer.from(""));
  assert.equal(reports.length, 1);
});

test("chamada que fecha sem nenhum turno e reportada como failed", () => {
  const { socket, reports } = setup();
  socket.emit("open");
  socket.emit("close", 1006, Buffer.from(""));
  assert.equal(reports.length, 1);
  assert.equal(reports[0].body.status, "failed");
  assert.deepEqual(JSON.parse(reports[0].body.transcript_json), []);
});

test("sem vbCallId nao ha para onde reportar e a sessao nao quebra", () => {
  const reports = [];
  const { socket } = setup({ vbCallId: null, reports });
  socket.emit("open");
  socket.emitEvent({ type: "response.output_audio_transcript.delta", item_id: "i1", delta: "oi" });
  socket.emitEvent({ type: "response.output_audio_transcript.done", item_id: "i1" });
  socket.emit("close", 1006, Buffer.from(""));
  assert.equal(reports.length, 0);
});

test("tool call da IA vira outcome no voice-broadcast e volta pra sessao", async () => {
  const { socket, outcomes } = setup();
  socket.emit("open");
  socket.sent.length = 0;
  socket.emitEvent({
    type: "conversation.item.created",
    item: { id: "item1", type: "function_call", call_id: "fc1", name: "registrar_interesse" },
  });
  socket.emitEvent({ type: "response.function_call_arguments.delta", item_id: "item1", delta: '{"interesse":' });
  socket.emitEvent({ type: "response.function_call_arguments.delta", item_id: "item1", delta: '"alto"}' });
  socket.emitEvent({ type: "response.output_item.done", item_id: "item1" });
  await new Promise(r => setTimeout(r, 10));

  assert.equal(outcomes.length, 1);
  assert.ok(outcomes[0].url.endsWith("/api/internal/calls/77/outcome"), outcomes[0].url);
  assert.equal(outcomes[0].body.tool, "registrar_interesse");
  assert.deepEqual(outcomes[0].body.args, { interesse: "alto" });

  const output = socket.sent.find(m => m.type === "conversation.item.create");
  assert.ok(output, "resultado da ferramenta precisa voltar pra sessao");
  assert.equal(output.item.call_id, "fc1");
  assert.deepEqual(JSON.parse(output.item.output), { resultado_para_ia: "anotado" });
  assert.ok(socket.sent.some(m => m.type === "response.create"), "IA precisa voltar a falar depois da ferramenta");
});

test("evento nao-json nao derruba a sessao", () => {
  const { socket } = setup();
  socket.emit("open");
  socket.emit("message", Buffer.from("isto nao e json"));
  socket.emit("close", 1006, Buffer.from(""));
});
