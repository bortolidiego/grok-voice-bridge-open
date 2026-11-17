/**
 * Correlacao de chamadas no caminho de SIP nativo (tronco BYO da xAI).
 *
 * No caminho mod_audio_stream o cracha (bootstrap token) chega junto do audio,
 * na metadata do WebSocket. Em SIP nativo quem abre a sessao e a xAI, via
 * webhook `realtime.call.incoming`, e o unico identificador nosso que chega la
 * sao os headers SIP da perna 2 — na pratica o `From`.
 *
 * Por isso o discador avisa este servico ANTES de mandar o INVITE: manda o
 * correlation_id (que vai no From da perna) junto do cracha. Aqui o cracha e
 * consumido na hora e a configuracao de sessao resolvida fica guardada em
 * memoria, com TTL curto, ate o webhook chegar.
 *
 * Estado em memoria e proposital: e uma janela de segundos entre o pre-registro
 * e o INVITE. Se o processo reiniciar no meio, a chamada falha alto (sem
 * cerebro configurado) em vez de atender com um agente generico.
 */

const DEFAULT_TTL_MS = 120_000;

/** Normaliza um correlation_id para comparacao: so digitos. */
export function normalizeCorrelationId(value) {
  return String(value ?? "").replace(/\D/g, "");
}

/**
 * Extrai o correlation_id dos headers SIP do webhook da xAI.
 *
 * Preferencia pelo header customizado (por padrao `X-Correlation-Id`; mude com a
 * variavel `CORRELATION_HEADER`), exato, se a xAI repassar headers extras; senao cai no `From`, que a doc garante. O `From`
 * pode vir como numero puro ("66010281493"), com "+" ou como URI SIP completa
 * ("sip:66010281493@192.0.2.10") — todos reduzem ao mesmo identificador.
 */
export function extractCorrelationId(
  sipHeaders,
  customHeader = process.env.CORRELATION_HEADER || "x-correlation-id",
) {
  const headers = Array.isArray(sipHeaders) ? sipHeaders : [];
  const byName = (wanted) => headers.find(
    (h) => String(h?.name || "").toLowerCase() === wanted,
  )?.value;

  const custom = byName(String(customHeader).toLowerCase());
  if (custom && normalizeCorrelationId(custom)) return normalizeCorrelationId(custom);

  const from = String(byName("from") || "");
  if (!from) return "";
  // Pega o user part: tudo entre um eventual "sip:" e o "@".
  const user = from.replace(/^.*?<?(?:sips?:)?/, "").split("@")[0];
  return normalizeCorrelationId(user);
}

export function createSipPrecallRegistry({
  ttlMs = DEFAULT_TTL_MS,
  now = () => Date.now(),
} = {}) {
  const entries = new Map();

  function prune() {
    const cutoff = now();
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= cutoff) entries.delete(key);
    }
  }

  return {
    /** Guarda a sessao resolvida ate o webhook da xAI chegar. */
    register(correlationId, payload) {
      const key = normalizeCorrelationId(correlationId);
      if (!key) throw new Error("correlation_id invalido");
      prune();
      entries.set(key, { payload, expiresAt: now() + ttlMs });
      return key;
    },

    /** Consome (uso unico) a sessao daquele correlation_id. */
    take(correlationId) {
      const key = normalizeCorrelationId(correlationId);
      if (!key) return null;
      prune();
      const entry = entries.get(key);
      if (!entry) return null;
      entries.delete(key);
      return entry.payload;
    },

    size() {
      prune();
      return entries.size;
    },
  };
}
