/**
 * Conexão WebSocket com a API Realtime da xAI para uma chamada ativa.
 */

import WebSocket from "ws";
import { buildServerVadConfig } from "./vad-config.js";
import { reportCallEnd, reportCallOutcome } from "./vb-client.js";

const XAI_REALTIME_URL = "wss://api.x.ai/v1/realtime";

function defaultCreateSocket({ url, apiKey }) {
  return new WebSocket(url, { headers: { Authorization: `Bearer ${apiKey}` } });
}

export function buildRealtimeSessionUpdate({
  sessionConfig,
  fallbackSession,
  audio,
} = {}) {
  const configuredSession = sessionConfig?.type === "session.update"
    ? sessionConfig.session
    : sessionConfig?.session ?? sessionConfig;
  if (!configuredSession && !fallbackSession) {
    throw new Error("session_config ausente ou invalido");
  }
  const session = {
    ...(fallbackSession || {}),
    ...(configuredSession || {}),
  };
  if (session.turn_detection === undefined) session.turn_detection = buildServerVadConfig();
  if (audio) session.audio = audio;
  return { type: "session.update", session };
}

export function buildInitialGreetingResponse(greeting) {
  const normalizedGreeting = typeof greeting === "string" ? greeting.trim() : "";
  return normalizedGreeting
    ? {
        type: "response.create",
        response: {
          instructions: [
            `Diga exatamente: "${normalizedGreeting}"`,
            "Use tom natural de pergunta curta, com entonacao ascendente em cada pergunta e uma pausa breve entre elas.",
            "Nao acrescente outras frases.",
          ].join(" "),
        },
      }
    : { type: "response.create" };
}

/**
 * Abre o WebSocket da xAI e configura a sessão com o agente da campanha.
 *
 * @param {Object} params
 * @param {string} params.callId        call_id recebido no webhook
 * @param {string} params.apiKey        XAI_API_KEY
 * @param {Object} params.sessionConfig session.update retornado pelo bootstrap
 * @param {Object} params.agent         agente retornado pelo bootstrap
 * @param {Function} [params.onLog]     função de log opcional (level, message, meta)
 */
export function connectRealtime({
  callId,
  apiKey,
  sessionConfig,
  agent,
  // Id da chamada NO voice-broadcast (voice_ai_calls.id), devolvido pelo
  // bootstrap consume. Sem ele o relatorio final nao tem onde ser gravado.
  vbCallId = null,
  vbBase = null,
  vbInternalToken = null,
  fetchImpl = globalThis.fetch,
  createSocket = defaultCreateSocket,
  now = () => Date.now(),
  onLog = defaultLog,
}) {
  if (!callId || !apiKey) {
    onLog("error", "callId ou apiKey ausente; nao foi possivel abrir websocket");
    return null;
  }

  let sessionUpdate;
  try {
    // Numa sessao SIP a MIDIA e da xAI: ela recebe e devolve audio pela propria
    // perna SIP. Declarar `audio.output.format` aqui faz a xAI tratar o
    // WebSocket como destino do audio — foi exatamente o que aconteceu em
    // 2026-08-01: o `response.output_audio.delta` chegava aqui e o telefone
    // ficava MUDO. Enviamos so a dica de transcricao de entrada, sem formato.
    sessionUpdate = buildRealtimeSessionUpdate({
      sessionConfig,
      audio: {
        input: {
          transcription: { language_hint: "pt-BR" },
        },
      },
    });
  } catch (err) {
    onLog("error", "session_config ausente; websocket xAI nao sera aberto", {
      callId,
      message: err.message,
    });
    return null;
  }

  const url = `${XAI_REALTIME_URL}?call_id=${encodeURIComponent(callId)}`;
  onLog("info", `abrindo websocket xai`, { callId, url });

  const ws = createSocket({ url, apiKey });

  // ── Transcrição da conversa ───────────────────────────────────────────────
  //
  // Em SIP nativo a mídia não passa por aqui, mas os EVENTOS de texto passam:
  // é por eles que o app fica sabendo o que foi dito. Sem isto a ligação
  // acontece e não sobra registro nenhum — foi o buraco do caminho SIP até
  // 2026-08-01.
  const transcriptTurns = [];
  const assistantDeltas = new Map();
  const activeToolCalls = new Map();
  const startedAt = now();
  let reported = false;
  let outcomeCounter = 0;

  function pushTurn(speaker, text) {
    const normalized = String(text ?? "").trim();
    if (!normalized) return;
    transcriptTurns.push({ speaker, text: normalized });
  }

  // Executa uma ferramenta pedida pela IA e devolve o resultado pra sessão.
  // Hoje nenhuma ferramenta é declarada no session.update (nem aqui nem no
  // caminho WebSocket), então isto fica dormente — existe para os dois
  // caminhos terem o MESMO comportamento no dia em que forem declaradas.
  async function handleToolCall(itemId, toolName, args) {
    outcomeCounter += 1;
    const outcomeId = `outcome-sip-${vbCallId || callId}-${startedAt}-${outcomeCounter}`;
    let resultText = "";
    try {
      if (!vbCallId || !vbBase || !vbInternalToken) throw new Error("outcome routing nao configurado");
      const res = await reportCallOutcome({
        callId: vbCallId,
        outcomeId,
        tool: toolName,
        args,
        mediaSessionId: null,
        vbBase,
        vbInternalToken,
        fetchImpl,
      });
      resultText = res.resultado_para_ia || "";
    } catch (err) {
      onLog("error", "tool call falhou", { callId, tool: toolName, message: err.message });
      resultText = "Entendido.";
    }
    if (ws.readyState !== 1) return;
    ws.send(JSON.stringify({
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: itemId, output: JSON.stringify({ resultado_para_ia: resultText }) },
    }));
    ws.send(JSON.stringify({ type: "response.create" }));
    onLog("info", "function_call_output + response.create enviados", { callId, tool: toolName });
  }

  // O relatório sai UMA vez, no fechamento do socket. `participant.disconnected`
  // chega ~2ms antes do close — usar os dois duplicaria o registro.
  //
  // `durationSec` aqui é a duração da SESSÃO DE IA (socket aberto → fechado),
  // que começa depois de o cliente atender. Não é o billsec da telefonia, que o
  // discador grava no CDR: são dois números diferentes de propósito.
  function reportOnce(status) {
    if (reported) return;
    reported = true;
    if (!vbCallId || !vbBase || !vbInternalToken) {
      onLog("warn", "sem destino para o relatorio final da chamada", { callId, vbCallId });
      return;
    }
    const durationSec = Math.max(0, Math.round((now() - startedAt) / 1000));
    onLog("info", "reportando fim da chamada", {
      callId, vbCallId, durationSec, turnos: transcriptTurns.length, status,
    });
    void reportCallEnd({
      callId: vbCallId,
      transcriptJson: JSON.stringify(transcriptTurns),
      durationSec,
      status,
      vbBase,
      vbInternalToken,
      fetchImpl,
    });
  }

  ws.on("open", () => {
    onLog("info", "websocket aberto", { callId });

    ws.send(JSON.stringify(sessionUpdate));
    onLog("info", "session.update enviado", { callId });
    ws.send(JSON.stringify(buildInitialGreetingResponse(agent?.greeting)));
    onLog("info", "response.create enviado (saudação inicial)", { callId });
  });

  ws.on("message", (data) => {
    let raw = "";
    try {
      raw = data.toString("utf8");
      const event = JSON.parse(raw);

      onLog("debug", "evento recebido", { callId, type: event.type });

      // Fala do agente: chega em pedaços (delta) e fecha no done.
      if (event.type === "response.output_audio_transcript.delta" && typeof event.delta === "string") {
        onLog("info", "transcricao agente", {
          callId,
          delta: event.delta,
          item_id: event.item_id,
        });
        const itemId = event.item_id || "sem-item";
        assistantDeltas.set(itemId, (assistantDeltas.get(itemId) || "") + event.delta);
      }

      if (event.type === "response.output_audio_transcript.done") {
        const itemId = event.item_id || "sem-item";
        const text = assistantDeltas.get(itemId) || event.transcript || event.text || "";
        assistantDeltas.delete(itemId);
        pushTurn("agente", text);
      }

      // Fala do cliente: a xAI transcreve e devolve pronta.
      if (event.type === "conversation.item.input_audio_transcription.completed") {
        const text = event.transcript ?? event.text ?? "";
        pushTurn("cliente", text);
        onLog("info", "transcricao cliente", { callId, texto: String(text).slice(0, 200) });
      }

      // Ferramentas (dormentes hoje — ver handleToolCall).
      if (event.type === "conversation.item.created" && event.item?.type === "function_call") {
        activeToolCalls.set(event.item.id, { callId: event.item.call_id, name: event.item.name, args: "" });
      }
      if (event.type === "response.function_call_arguments.delta" && event.item_id) {
        const tool = activeToolCalls.get(event.item_id);
        if (tool) tool.args += event.delta || "";
      }
      if (event.type === "response.output_item.done" && activeToolCalls.has(event.item_id)) {
        const tool = activeToolCalls.get(event.item_id);
        activeToolCalls.delete(event.item_id);
        let parsedArgs = {};
        try { parsedArgs = tool.args ? JSON.parse(tool.args) : {}; } catch { parsedArgs = {}; }
        void handleToolCall(tool.callId, tool.name, parsedArgs);
      }

      if (event.type === "error") {
        onLog("error", "erro da xAI", {
          callId,
          code: event.code,
          message: event.message,
        });
      }
    } catch (err) {
      onLog("warn", "mensagem nao-json recebida", { callId, raw });
    }
  });

  ws.on("error", (err) => {
    onLog("error", "erro no websocket", { callId, message: err.message });
  });

  ws.on("close", (code, reason) => {
    onLog("info", "websocket fechado", {
      callId,
      code,
      reason: reason?.toString ? reason.toString("utf8") : String(reason ?? ""),
    });
    // 1006 é o fechamento normal aqui: a xAI derruba o socket quando a perna
    // SIP cai. Só um fechamento sem nenhum turno registrado é "failed".
    reportOnce(transcriptTurns.length > 0 ? "ended" : "failed");
  });

  return ws;
}

/**
 * Encerra uma chamada SIP do lado da xAI.
 *
 * Necessario quando recebemos o webhook de uma chamada que NAO conseguimos
 * configurar: a perna SIP ja esta atendida e tarifando ($0,05/min). Sem este
 * hangup ela so morreria no teto de duracao da campanha, gastando minutos de
 * silencio.
 *
 * @param {Object} params
 * @param {string} params.callId
 * @param {string} params.apiKey
 */
export async function hangupXaiCall({ callId, apiKey, fetchImpl = globalThis.fetch }) {
  if (!callId || !apiKey) throw new Error("callId ou apiKey ausente para hangup");
  const response = await fetchImpl(
    `https://api.x.ai/v1/realtime/calls/${encodeURIComponent(callId)}/hangup`,
    { method: "POST", headers: { Authorization: `Bearer ${apiKey}` } },
  );
  if (!response.ok) throw new Error(`hangup xai recusado (${response.status})`);
  return true;
}

function defaultLog(level, message, meta = {}) {
  const line = {
    ts: new Date().toISOString(),
    level,
    message,
    ...meta,
  };
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(line));
}
