import assert from "node:assert";
import { Readable } from "node:stream";
import test from "node:test";
import { createRequestHandler } from "../src/server.js";

function makeReq({ method = "POST", url = "/internal/greeting-audio", token, body = {} } = {}) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  req.method = method;
  req.url = url;
  req.headers = token ? { authorization: `Bearer ${token}` } : {};
  return req;
}

function makeRes() {
  let resolve;
  const done = new Promise((r) => { resolve = r; });
  return {
    statusCode: null,
    headers: null,
    body: null,
    done,
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(body) {
      this.body = Buffer.isBuffer(body) ? body : Buffer.from(String(body || ""));
      resolve(this);
    },
  };
}

test("endpoint interno de saudacao exige Bearer VB_INTERNAL_TOKEN", async () => {
  let called = false;
  const handler = createRequestHandler({
    apiKey: "xai-test",
    signingSecret: "whsec_test",
    internalToken: "vb-secret",
    generateGreeting: async () => {
      called = true;
      return Buffer.from("RIFFfake-wav");
    },
  });
  const res = makeRes();

  await handler(makeReq({ body: { text: "Alo?" } }), res);
  await res.done;

  assert.equal(res.statusCode, 401);
  assert.equal(called, false);
});

test("endpoint interno de saudacao devolve WAV gerado pela ponte", async () => {
  const wav = Buffer.from("RIFFfake-wav");
  let payload;
  const handler = createRequestHandler({
    apiKey: "xai-test",
    signingSecret: "whsec_test",
    internalToken: "vb-secret",
    generateGreeting: async (args) => {
      payload = args;
      return wav;
    },
  });
  const res = makeRes();

  await handler(makeReq({
    token: "vb-secret",
    body: {
      text: "Alo? Alo, ta me ouvindo?",
      model: "grok-voice-latest",
      voice: "eve",
      language: "pt-BR",
      speed: 0.9,
    },
  }), res);
  await res.done;

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["Content-Type"], "audio/wav");
  assert.deepEqual(res.body, wav);
  assert.deepEqual(payload, {
    text: "Alo? Alo, ta me ouvindo?",
    model: "grok-voice-latest",
    voice: "eve",
    language: "pt-BR",
    speed: 0.9,
    apiKey: "xai-test",
  });
});

