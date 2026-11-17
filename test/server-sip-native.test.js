import assert from "node:assert";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import test from "node:test";
import { createRequestHandler } from "../src/server.js";
import {
  createSipPrecallRegistry,
  extractCorrelationId,
  normalizeCorrelationId,
} from "../src/sip-precall-registry.js";

const SIGNING_SECRET = "whsec_teste_super_secreto";

function signPayload(secret, id, timestamp, payload) {
  const key = secret.startsWith("whsec_")
    ? Buffer.from(secret.slice("whsec_".length), "base64")
    : Buffer.from(secret, "utf8");
  return "v1," + crypto
    .createHmac("sha256", key)
    .update(`${id}.${timestamp}.${payload}`, "utf8")
    .digest("base64");
}

function makeReq({ method = "POST", url, token, body = {}, headers = {} } = {}) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const req = Readable.from([Buffer.from(raw)]);
  req.method = method;
  req.url = url;
  req.headers = { ...headers };
  if (token) req.headers.authorization = `Bearer ${token}`;
  return req;
}

function makeSignedWebhookReq(payloadObject) {
  const payload = JSON.stringify(payloadObject);
  const id = "msg_test";
  const timestamp = Math.floor(Date.now() / 1000).toString();
  return makeReq({
    url: "/xai/sip-webhook",
    body: payload,
    headers: {
      "webhook-id": id,
      "webhook-timestamp": timestamp,
      "webhook-signature": signPayload(SIGNING_SECRET, id, timestamp, payload),
    },
  });
}

function makeRes() {
  let resolve;
  const done = new Promise((r) => { resolve = r; });
  return {
    statusCode: null,
    body: null,
    done,
    writeHead(statusCode) { this.statusCode = statusCode; },
    end(body) {
      this.body = Buffer.isBuffer(body) ? body : Buffer.from(String(body || ""));
      resolve(this);
    },
  };
}

function bootstrapPayload() {
  return {
    ok: true,
    call_id: 4242,
    agent: { greeting: "Ola!", initial_greeting_played: false },
    session_config: {
      type: "session.update",
      session: { instructions: "Seja objetivo.", voice: "eve", model: "grok-voice-latest", speed: 1 },
    },
  };
}

test("extrai correlation do From em numero puro, com + e em URI SIP", () => {
  assert.equal(extractCorrelationId([{ name: "From", value: "66010281493" }]), "66010281493");
  assert.equal(extractCorrelationId([{ name: "From", value: "+66010281493" }]), "66010281493");
  assert.equal(
    extractCorrelationId([{ name: "from", value: "sip:66010281493@192.0.2.10" }]),
    "66010281493",
  );
  assert.equal(extractCorrelationId([{ name: "To", value: "+15550100001" }]), "");
  assert.equal(extractCorrelationId(undefined), "");
});

test("header customizado tem preferencia sobre o From", () => {
  const headers = [
    { name: "From", value: "11111111111" },
    { name: "X-Correlation-Id", value: "22222222222" },
  ];
  assert.equal(extractCorrelationId(headers), "22222222222");
});

test("registro de precall e de uso unico e expira", () => {
  let clock = 1_000;
  const registry = createSipPrecallRegistry({ ttlMs: 500, now: () => clock });
  registry.register("66010281493", { agent: "x" });
  assert.equal(registry.size(), 1);
  assert.deepEqual(registry.take("+66010281493"), { agent: "x" }, "normaliza a chave");
  assert.equal(registry.take("66010281493"), null, "uso unico");

  registry.register("99999999999", { agent: "y" });
  clock += 501;
  assert.equal(registry.take("99999999999"), null, "expirado nao pode virar chamada");
  assert.equal(normalizeCorrelationId("sip:123@host"), "123");
});

test("precall exige Bearer VB_INTERNAL_TOKEN", async () => {
  let consumed = false;
  const handler = createRequestHandler({
    apiKey: "xai-test",
    signingSecret: SIGNING_SECRET,
    internalToken: "vb-secret",
    consumeBootstrapTokenFn: async () => { consumed = true; return bootstrapPayload(); },
  });
  const res = makeRes();
  await handler(makeReq({ url: "/internal/sip-precall", body: { correlation_id: "1", bootstrap_token: "t" } }), res);
  await res.done;
  assert.equal(res.statusCode, 401);
  assert.equal(consumed, false, "sem token o cracha nem chega a ser consumido");
});

test("precall consome o cracha e o webhook abre a sessao com o cerebro da campanha", async () => {
  const connects = [];
  const consumes = [];
  const handler = createRequestHandler({
    apiKey: "xai-test",
    signingSecret: SIGNING_SECRET,
    internalToken: "vb-secret",
    vbBase: "http://vb.test",
    vbInternalToken: "vb-s2s",
    consumeBootstrapTokenFn: async (args) => { consumes.push(args); return bootstrapPayload(); },
    connectRealtimeFn: (args) => { connects.push(args); return {}; },
  });

  const precallRes = makeRes();
  await handler(makeReq({
    url: "/internal/sip-precall",
    token: "vb-secret",
    body: { correlation_id: "66010281493", bootstrap_token: "cracha-x", call_uuid: "uuid-cliente" },
  }), precallRes);
  await precallRes.done;
  assert.equal(precallRes.statusCode, 200);
  assert.equal(consumes.length, 1);
  assert.equal(consumes[0].token, "cracha-x");
  assert.equal(consumes[0].callUuid, "uuid-cliente");
  assert.equal(consumes[0].vbBase, "http://vb.test");

  const webhookRes = makeRes();
  await handler(makeSignedWebhookReq({
    type: "realtime.call.incoming",
    data: {
      call_id: "call_abc",
      sip_headers: [
        { name: "From", value: "66010281493" },
        { name: "To", value: "+15550100001" },
      ],
    },
  }), webhookRes);
  await webhookRes.done;

  assert.equal(webhookRes.statusCode, 200);
  assert.equal(connects.length, 1, "webhook casado abre o WebSocket de controle");
  assert.equal(connects[0].callId, "call_abc");
  assert.equal(connects[0].agent.greeting, "Ola!");
  assert.equal(connects[0].sessionConfig.session.instructions, "Seja objetivo.");
});

test("saudacao pre-gravada ja tocada instrui a xAI a nao cumprimentar de novo", async () => {
  const connects = [];
  const payload = bootstrapPayload();
  payload.agent.initial_greeting_played = true;
  const handler = createRequestHandler({
    apiKey: "xai-test",
    signingSecret: SIGNING_SECRET,
    internalToken: "vb-secret",
    consumeBootstrapTokenFn: async () => payload,
    connectRealtimeFn: (args) => { connects.push(args); return {}; },
  });

  const precallRes = makeRes();
  await handler(makeReq({
    url: "/internal/sip-precall",
    token: "vb-secret",
    body: { correlation_id: "12345678901", bootstrap_token: "cracha-y" },
  }), precallRes);
  await precallRes.done;

  const webhookRes = makeRes();
  await handler(makeSignedWebhookReq({
    type: "realtime.call.incoming",
    data: { call_id: "call_def", sip_headers: [{ name: "From", value: "12345678901" }] },
  }), webhookRes);
  await webhookRes.done;

  assert.equal(connects.length, 1);
  assert.match(connects[0].sessionConfig.session.instructions, /ja foi reproduzida/);
});

test("chamada sem precall correspondente e derrubada em vez de atender com agente generico", async () => {
  const connects = [];
  const hangups = [];
  const handler = createRequestHandler({
    apiKey: "xai-test",
    signingSecret: SIGNING_SECRET,
    internalToken: "vb-secret",
    connectRealtimeFn: (args) => { connects.push(args); return {}; },
    hangupXaiCallFn: async (args) => { hangups.push(args); return true; },
  });

  const res = makeRes();
  await handler(makeSignedWebhookReq({
    type: "realtime.call.incoming",
    data: { call_id: "call_orfa", sip_headers: [{ name: "From", value: "70000000000" }] },
  }), res);
  await res.done;

  assert.equal(res.statusCode, 409);
  assert.equal(connects.length, 0, "sem cerebro configurado a chamada nao e atendida");
  assert.equal(hangups.length, 1, "perna orfa nao pode ficar tarifando em silencio");
  assert.equal(hangups[0].callId, "call_orfa");
});

test("falha no hangup da chamada orfa nao derruba o servidor", async () => {
  const handler = createRequestHandler({
    apiKey: "xai-test",
    signingSecret: SIGNING_SECRET,
    internalToken: "vb-secret",
    hangupXaiCallFn: async () => { throw new Error("hangup xai recusado (500)"); },
  });
  const res = makeRes();
  await handler(makeSignedWebhookReq({
    type: "realtime.call.incoming",
    data: { call_id: "call_orfa2", sip_headers: [{ name: "From", value: "70000000001" }] },
  }), res);
  await res.done;
  assert.equal(res.statusCode, 409);
});

test("cracha recusado no voice-broadcast nao vira precall", async () => {
  const handler = createRequestHandler({
    apiKey: "xai-test",
    signingSecret: SIGNING_SECRET,
    internalToken: "vb-secret",
    consumeBootstrapTokenFn: async () => {
      const error = new Error("bootstrap consume recusado (403)");
      error.code = "ai_agent_not_enabled";
      throw error;
    },
  });
  const res = makeRes();
  await handler(makeReq({
    url: "/internal/sip-precall",
    token: "vb-secret",
    body: { correlation_id: "33333333333", bootstrap_token: "cracha-z" },
  }), res);
  await res.done;

  assert.equal(res.statusCode, 403);
  assert.match(res.body.toString(), /ai_agent_not_enabled/);
});
