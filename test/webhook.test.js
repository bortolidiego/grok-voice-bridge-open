import assert from "node:assert";
import test from "node:test";
import crypto from "node:crypto";
import { verifyWebhook } from "../src/webhook.js";
import { buildRealtimeSessionUpdate } from "../src/realtime.js";

/**
 * Cria um exemplo de assinatura Svix real para testes locais.
 * Formato do header: "v1,<base64(hmac-sha256(id.timestamp.payload))>"
 * A chave HMAC é o base64-decode do secret sem o prefixo "whsec_".
 */
function signPayload(secret, id, timestamp, payload) {
  const key = secret.startsWith("whsec_")
    ? Buffer.from(secret.slice("whsec_".length), "base64")
    : Buffer.from(secret, "utf8");
  const signedContent = `${id}.${timestamp}.${payload}`;
  return (
    "v1," +
    crypto.createHmac("sha256", key).update(signedContent, "utf8").digest("base64")
  );
}

test("verificacao de assinatura valida", () => {
  const secret = "whsec_teste_super_secreto";
  const id = "msg_123";
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const payload = JSON.stringify({ type: "realtime.call.incoming", data: { call_id: "call_abc" } });

  const signature = signPayload(secret, id, timestamp, payload);
  const headers = {
    "webhook-id": id,
    "webhook-timestamp": timestamp,
    "webhook-signature": signature,
  };

  const result = verifyWebhook(Buffer.from(payload), headers, secret);
  assert.strictEqual(result.ok, true, result.error);
});

test("verificacao rejeita assinatura invalida", () => {
  const secret = "whsec_teste_super_secreto";
  const id = "msg_123";
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const payload = JSON.stringify({ type: "realtime.call.incoming", data: { call_id: "call_abc" } });

  const headers = {
    "webhook-id": id,
    "webhook-timestamp": timestamp,
    "webhook-signature": "v1=assinatura_falsa",
  };

  const result = verifyWebhook(Buffer.from(payload), headers, secret);
  assert.strictEqual(result.ok, false);
});

test("verificacao rejeita timestamp muito antigo", () => {
  const secret = "whsec_teste_super_secreto";
  const id = "msg_123";
  // Timestamp de 10 minutos atrás, fora da janela padrão de 5 minutos.
  const timestamp = (Math.floor(Date.now() / 1000) - 10 * 60).toString();
  const payload = JSON.stringify({ type: "realtime.call.incoming", data: { call_id: "call_abc" } });

  const signature = signPayload(secret, id, timestamp, payload);
  const headers = {
    "webhook-id": id,
    "webhook-timestamp": timestamp,
    "webhook-signature": signature,
  };

  const result = verifyWebhook(Buffer.from(payload), headers, secret);
  assert.strictEqual(result.ok, false);
});

test("session.update realtime usa config da campanha", () => {
  const sessionUpdate = buildRealtimeSessionUpdate({
    sessionConfig: {
      type: "session.update",
      session: {
        model: "grok-voice-think-fast-1.0",
        instructions: "Prompt da campanha",
        voice: "ara",
        speed: 1.2,
        turn_detection: {
          type: "server_vad",
          threshold: 0.61,
          silence_duration_ms: 520,
        },
      },
    },
    audio: {
      input: {
        format: { type: "audio/pcmu" },
        transcription: { language_hint: "pt-BR" },
      },
      output: {
        format: { type: "audio/pcmu" },
      },
    },
  });

  assert.deepStrictEqual(sessionUpdate, {
    type: "session.update",
    session: {
      model: "grok-voice-think-fast-1.0",
      instructions: "Prompt da campanha",
      voice: "ara",
      speed: 1.2,
      turn_detection: {
        type: "server_vad",
        threshold: 0.61,
        silence_duration_ms: 520,
      },
      audio: {
        input: {
          format: { type: "audio/pcmu" },
          transcription: { language_hint: "pt-BR" },
        },
        output: {
          format: { type: "audio/pcmu" },
        },
      },
    },
  });
});

test("builder realtime exige session_config sem fallback fixo", () => {
  assert.throws(
    () => buildRealtimeSessionUpdate(),
    /session_config ausente ou invalido/,
  );
});
