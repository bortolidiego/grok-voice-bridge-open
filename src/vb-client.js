/**
 * Cliente S2S do discador.
 *
 * Fica em modulo proprio porque os DOIS caminhos de midia precisam dele:
 * o WebSocket do mod_audio_stream (src/audio-stream-server.js) e o SIP nativo
 * (src/realtime.js). Deixa-lo no audio-stream-server criaria import circular.
 */

export async function consumeBootstrapToken({
  token,
  callUuid,
  vbBase,
  vbInternalToken,
  fetchImpl = globalThis.fetch,
}) {
  if (!token || !vbBase || !vbInternalToken) {
    throw new Error("bootstrap consume sem token ou configuracao interna");
  }
  const url = `${vbBase.replace(/\/+$/, "")}/api/internal/bootstrap-token/consume`;
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${vbInternalToken}`,
    },
    body: JSON.stringify({ token, call_uuid: callUuid }),
  });
  const payload = await response.json().catch(() => null);
  if (response.status !== 200 || payload?.ok !== true) {
    const error = new Error(`bootstrap consume recusado (${response.status})`);
    error.status = response.status;
    error.code = payload?.error || "bootstrap_consume_failed";
    throw error;
  }
  const configuredSession = payload.session_config?.type === "session.update"
    ? payload.session_config.session
    : null;
  if (
    !payload.agent
    || !configuredSession
    || typeof configuredSession.instructions !== "string"
    || typeof configuredSession.voice !== "string"
    || typeof configuredSession.model !== "string"
    || !Number.isFinite(Number(configuredSession.speed))
  ) {
    const error = new Error("bootstrap consume retornou payload incompleto");
    error.status = 502;
    error.code = "invalid_bootstrap_payload";
    throw error;
  }
  return payload;
}

export async function reportCallOutcome({
  callId,
  outcomeId,
  tool,
  args,
  mediaSessionId,
  vbBase,
  vbInternalToken,
  fetchImpl = globalThis.fetch,
}) {
  if (!callId || !outcomeId || !tool || !vbBase || !vbInternalToken) {
    throw new Error("outcome report sem call_id, outcome_id, tool ou configuracao interna");
  }
  const url = `${vbBase.replace(/\/+$/, "")}/api/internal/calls/${encodeURIComponent(callId)}/outcome`;
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${vbInternalToken}`,
    },
    body: JSON.stringify({
      outcome_id: outcomeId,
      tool,
      args,
      media_session_id: mediaSessionId,
    }),
  });
  const payload = await response.json().catch(() => null);
  if (response.status !== 200 || payload?.ok !== true) {
    const error = new Error(`outcome report recusado (${response.status})`);
    error.status = response.status;
    error.code = payload?.error || "outcome_report_failed";
    throw error;
  }
  return payload;
}

export async function reportCallEnd({
  callId,
  transcriptJson,
  durationSec,
  status,
  vbBase,
  vbInternalToken,
  fetchImpl = globalThis.fetch,
}) {
  if (!callId || !vbBase || !vbInternalToken) return;
  const url = `${vbBase.replace(/\/+$/, "")}/api/internal/calls/${encodeURIComponent(callId)}/report`;
  // report_id pro bridge, pra ser idempotente e não colidir com o ID que o voip softphone usa
  const reportId = `bridge-${callId}-${Date.now()}`;
  try {
    await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${vbInternalToken}`,
      },
      body: JSON.stringify({
        report_id: reportId,
        status: status || 'ended',
        duration_sec: durationSec,
        transcript_json: transcriptJson,
      }),
    });
  } catch (err) {
    // Fail-open — apenas logaríamos, mas a função é utilitária
  }
}

