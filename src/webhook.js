/**
 * Validação de assinatura dos webhooks da xAI.
 *
 * A xAI envia headers no estilo Svix:
 *   webhook-id
 *   webhook-timestamp
 *   webhook-signature
 *
 * A assinatura é HMAC-SHA256 do payload com timestamp, no formato:
 *   v1=<hmac-sha256-base64(‘timestamp.payload’?)>
 *
 * A doc da xAI ainda não detalha o formato exato; implementamos o esquema Svix-
 * compatível (concatenação id.timestamp.payload) que é o padrão mais comum para
 * webhooks assinados.
 *
 * TODO: validar contra um webhook real da xAI quando tivermos um evento de teste.
 */

import crypto from "node:crypto";

const HEADER_ID = "webhook-id";
const HEADER_TIMESTAMP = "webhook-timestamp";
const HEADER_SIGNATURE = "webhook-signature";

// Tempo máximo tolerado entre o timestamp do webhook e o relógio local (em segundos).
const MAX_AGE_SECONDS = 5 * 60;

/**
 * Verifica se a assinatura do webhook é válida.
 *
 * @param {string|Buffer} rawBody      corpo bruto da requisição
 * @param {Record<string,string>} headers  headers normalizados (lowercase)
 * @param {string} secret              XAI_SIGNING_SECRET
 * @returns {{ok:true}|{ok:false,error:string}}
 */
export function verifyWebhook(rawBody, headers, secret) {
  const id = headers[HEADER_ID];
  const timestamp = headers[HEADER_TIMESTAMP];
  const signature = headers[HEADER_SIGNATURE];

  if (!id || !timestamp || !signature || !secret) {
    return { ok: false, error: "faltam headers ou secret de assinatura" };
  }

  const now = Math.floor(Date.now() / 1000);
  const ts = parseInt(timestamp, 10);
  if (Number.isNaN(ts)) {
    return { ok: false, error: "timestamp invalido" };
  }
  if (Math.abs(now - ts) > MAX_AGE_SECONDS) {
    return { ok: false, error: "timestamp fora da janela permitida" };
  }

  // Esquema Svix (confirmado: xAI usa secret com prefixo "whsec_"):
  //  - chave HMAC = base64-decode do secret sem o prefixo "whsec_"
  //  - conteudo assinado = "<webhook-id>.<webhook-timestamp>.<rawBody>"
  //  - header webhook-signature = lista separada por espaco de "v1,<base64sig>"
  const key = secret.startsWith("whsec_")
    ? Buffer.from(secret.slice("whsec_".length), "base64")
    : Buffer.from(secret, "utf8");
  const signedContent = `${id}.${timestamp}.${rawBody}`;
  const expected = crypto
    .createHmac("sha256", key)
    .update(signedContent, "utf8")
    .digest("base64");

  const parts = signature.split(/\s+/).map((p) => p.trim()).filter(Boolean);
  let valid = false;
  for (const part of parts) {
    const comma = part.indexOf(",");
    if (comma === -1) continue;
    const ver = part.slice(0, comma);
    const value = part.slice(comma + 1);
    if (ver !== "v1" || !value) continue;
    try {
      const a = Buffer.from(value);
      const b = Buffer.from(expected);
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
        valid = true;
        break;
      }
    } catch {
      // tamanhos diferentes — ignora silenciosamente
    }
  }

  if (!valid) {
    return { ok: false, error: "assinatura invalida" };
  }

  return { ok: true };
}

/**
 * Normaliza headers para lowercase, facilitando a busca pelas chaves.
 * @param {import('node:http').IncomingHttpHeaders} headers
 * @returns {Record<string,string>}
 */
export function normalizeHeaders(headers) {
  /** @type {Record<string,string>} */
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") {
      out[key.toLowerCase()] = value;
    } else if (Array.isArray(value)) {
      out[key.toLowerCase()] = value.join(", ");
    }
  }
  return out;
}
