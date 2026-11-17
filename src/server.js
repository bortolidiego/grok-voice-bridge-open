/**
 * Servidor-ponte Grok Voice Bridge.
 *
 * Recebe webhooks da xAI (realtime.call.incoming), valida assinatura e abre
 * WebSocket de controle da chamada na API Realtime da xAI.
 */

import http from "node:http";
import { fileURLToPath } from "node:url";
import { normalizeHeaders, verifyWebhook } from "./webhook.js";
import { connectRealtime, hangupXaiCall } from "./realtime.js";
import { generateGreetingWav } from "./greeting-audio.js";
import { consumeBootstrapToken, withPrerecordedGreetingContext } from "./audio-stream-server.js";
import { createSipPrecallRegistry, extractCorrelationId } from "./sip-precall-registry.js";

const PORT = parseInt(process.env.PORT || "8080", 10);

/**
 * Lê o corpo bruto da requisição.
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<Buffer>}
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * Envia resposta JSON e encerra a resposta.
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
function jsonResponse(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function isAuthorized(req, token) {
  const expected = String(token || "").trim();
  if (!expected) return false;
  const header = String(req.headers.authorization || "");
  const provided = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  return provided === expected;
}

function wavResponse(res, wav) {
  res.writeHead(200, {
    "Content-Type": "audio/wav",
    "Content-Length": wav.length,
    "Cache-Control": "no-store",
  });
  res.end(wav);
}

export function createRequestHandler({
  apiKey = process.env.XAI_API_KEY,
  signingSecret = process.env.XAI_SIGNING_SECRET,
  internalToken = process.env.VB_INTERNAL_TOKEN,
  generateGreeting = generateGreetingWav,
  connectRealtimeFn = connectRealtime,
  hangupXaiCallFn = hangupXaiCall,
  vbBase = process.env.VB_BASE,
  vbInternalToken = process.env.VB_INTERNAL_TOKEN,
  consumeBootstrapTokenFn = consumeBootstrapToken,
  sipPrecallRegistry = createSipPrecallRegistry(),
  fetchImpl = globalThis.fetch,
  onLog = log,
} = {}) {
  return async (req, res) => {
    const url = req.url || "/";
    const method = req.method || "GET";

  // Rota de saúde — usada por load balancers e monitoramento.
  if (method === "GET" && url === "/health") {
    jsonResponse(res, 200, { ok: true });
    return;
  }

  if (method === "POST" && url === "/internal/greeting-audio") {
    try {
      if (!isAuthorized(req, internalToken)) {
        jsonResponse(res, 401, { ok: false, error: "unauthorized" });
        return;
      }
      const body = await readBody(req);
      let payload;
      try {
        payload = JSON.parse(body.toString("utf8"));
      } catch {
        jsonResponse(res, 400, { ok: false, error: "corpo json invalido" });
        return;
      }
      const wav = await generateGreeting({
        text: payload.text,
        model: payload.model,
        voice: payload.voice,
        language: payload.language,
        speed: payload.speed,
        apiKey,
      });
      wavResponse(res, wav);
    } catch (err) {
      onLog("warn", "falha ao gerar saudacao interna", { message: err.message });
      jsonResponse(res, 502, { ok: false, error: "greeting_generation_failed" });
    }
    return;
  }

  // Pre-registro da chamada no caminho de SIP nativo: o discador avisa qual
  // correlation_id vai no From da perna 2 e entrega o cracha. O cracha e
  // consumido AQUI (uso unico, TTL de 60s no emissor), e a sessao resolvida
  // fica guardada ate o webhook da xAI chegar com aquele mesmo From.
  if (method === "POST" && url === "/internal/sip-precall") {
    try {
      if (!isAuthorized(req, internalToken)) {
        jsonResponse(res, 401, { ok: false, error: "unauthorized" });
        return;
      }
      const body = await readBody(req);
      let payload;
      try {
        payload = JSON.parse(body.toString("utf8"));
      } catch {
        jsonResponse(res, 400, { ok: false, error: "corpo json invalido" });
        return;
      }
      const correlationId = String(payload?.correlation_id || "").trim();
      const bootstrapToken = String(payload?.bootstrap_token || "").trim();
      if (!correlationId || !bootstrapToken) {
        jsonResponse(res, 400, { ok: false, error: "correlation_id e bootstrap_token obrigatorios" });
        return;
      }

      let bootstrap;
      try {
        bootstrap = await consumeBootstrapTokenFn({
          token: bootstrapToken,
          callUuid: payload?.call_uuid || null,
          vbBase,
          vbInternalToken,
          fetchImpl,
        });
      } catch (err) {
        onLog("warn", "sip precall recusado no bootstrap consume", {
          correlationId,
          code: err.code || null,
          message: err.message,
        });
        jsonResponse(res, 403, { ok: false, error: err.code || "bootstrap_consume_failed" });
        return;
      }

      sipPrecallRegistry.register(correlationId, {
        callUuid: payload?.call_uuid || null,
        sessionConfig: bootstrap.session_config,
        agent: bootstrap.agent,
        vbCallId: bootstrap.call_id,
      });
      onLog("info", "sip precall registrado", {
        correlationId,
        callUuid: payload?.call_uuid || null,
        vbCallId: bootstrap.call_id,
        pending: sipPrecallRegistry.size(),
      });
      jsonResponse(res, 200, { ok: true, correlation_id: correlationId });
    } catch (err) {
      onLog("error", "erro interno no sip precall", { message: err.message });
      jsonResponse(res, 500, { ok: false, error: "erro interno" });
    }
    return;
  }

  // Webhook da xAI para chamadas entrantes via SIP.
  if (method === "POST" && url === "/xai/sip-webhook") {
    try {
      const body = await readBody(req);
      const headers = normalizeHeaders(req.headers);

      // Valida assinatura HMAC-SHA256 no estilo Svix.
      const verified = verifyWebhook(body, headers, signingSecret);
      if (!verified.ok) {
        onLog("warn", "webhook rejeitado", { reason: verified.error });
        jsonResponse(res, 401, { ok: false, error: verified.error });
        return;
      }

      let event;
      try {
        event = JSON.parse(body.toString("utf8"));
      } catch {
        onLog("warn", "webhook com corpo invalido");
        jsonResponse(res, 400, { ok: false, error: "corpo json invalido" });
        return;
      }

      onLog("info", "webhook recebido", { type: event.type });

      if (event.type === "realtime.call.incoming") {
        const callId = event.data?.call_id;
        if (!callId) {
          onLog("warn", "webhook sem call_id", { event });
          jsonResponse(res, 400, { ok: false, error: "call_id ausente" });
          return;
        }

        // O From da perna 2 carrega o correlation_id pre-registrado pelo
        // discador — e por ele que sabemos QUAL campanha/agente configurar.
        const correlationId = extractCorrelationId(event.data?.sip_headers);
        const precall = correlationId ? sipPrecallRegistry.take(correlationId) : null;
        if (!precall) {
          // Sem cerebro nao ha chamada: atender com um agente generico seria
          // pior que falhar — o cliente ouviria uma IA que nao e a da campanha.
          // A perna SIP ja esta atendida e tarifando, e a doc nao define o que a
          // xAI faz com um 4xx no webhook; entao derrubamos explicitamente em
          // vez de torcer para ela desistir sozinha.
          onLog("error", "chamada entrante sem precall correspondente", { callId, correlationId });
          try {
            await hangupXaiCallFn({ callId, apiKey, fetchImpl });
            onLog("info", "chamada orfa encerrada na xAI", { callId });
          } catch (hangupErr) {
            onLog("error", "falha ao encerrar chamada orfa na xAI", { callId, message: hangupErr.message });
          }
          jsonResponse(res, 409, { ok: false, error: "sip_precall_nao_encontrado" });
          return;
        }

        onLog("info", "chamada entrante detectada", {
          callId,
          correlationId,
          callUuid: precall.callUuid,
          vbCallId: precall.vbCallId,
        });

        // Abre WebSocket de controle da chamada na xAI com o cerebro da campanha.
        connectRealtimeFn({
          callId,
          apiKey,
          sessionConfig: withPrerecordedGreetingContext(precall.sessionConfig, precall.agent),
          agent: precall.agent,
          // Sem o vbCallId a sessao conversa e nao sobra registro nenhum:
          // e o id de voice_ai_calls que o relatorio final usa.
          vbCallId: precall.vbCallId,
          vbBase,
          vbInternalToken,
          fetchImpl,
          onLog,
        });

        jsonResponse(res, 200, { ok: true, call_id: callId });
        return;
      }

      // Outros eventos são reconhecidos mas não disparam ação.
      onLog("info", "evento ignorado", { type: event.type });
      jsonResponse(res, 200, { ok: true, ignored: true });
    } catch (err) {
      onLog("error", "erro interno no webhook", { message: err.message });
      jsonResponse(res, 500, { ok: false, error: "erro interno" });
    }
    return;
  }

  // 404 para qualquer outro endpoint.
  jsonResponse(res, 404, { ok: false, error: "not found" });
  };
}

export function startServer({
  port = PORT,
  apiKey = process.env.XAI_API_KEY,
  signingSecret = process.env.XAI_SIGNING_SECRET,
  internalToken = process.env.VB_INTERNAL_TOKEN,
  onLog = log,
} = {}) {
  if (!apiKey) {
    onLog("error", "variavel XAI_API_KEY nao configurada");
    process.exit(1);
  }

  if (!signingSecret) {
    onLog("error", "variavel XAI_SIGNING_SECRET nao configurada");
    process.exit(1);
  }

  const server = http.createServer(createRequestHandler({
    apiKey,
    signingSecret,
    internalToken,
    onLog,
  }));
  server.listen(port, () => {
    onLog("info", "servidor grok-voice-bridge iniciado", { port });
  });
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  startServer();
}

function log(level, message, meta = {}) {
  const line = {
    ts: new Date().toISOString(),
    level,
    message,
    ...meta,
  };
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(line));
}
