/**
 * Cliente ESL inbound minimo para comandos de controle do mod_audio_stream.
 * Uma unica conexao e reutilizada pelo processo; ela so e aberta quando ha
 * FUSION_ESL_PASSWORD/ESL_PASSWORD configurada e algum comando pendente.
 */

import net from "node:net";
import { EventEmitter } from "node:events";

const RECONNECT_DELAY_MS = 500;
let sharedClient = null;
let warnedMissingPassword = false;

function defaultLog(level, message, meta = {}) {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, message, ...meta }));
}

const HEADER_DELIMITERS = [Buffer.from("\r\n\r\n"), Buffer.from("\n\n")];

function indexOfBuffer(haystack, needle, start = 0) {
  for (let i = start; i <= haystack.length - needle.length; i += 1) {
    let match = true;
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) {
        match = false;
        break;
      }
    }
    if (match) return i;
  }
  return -1;
}

function findHeaderDelimiter(buffer) {
  let headerEnd = -1;
  let headerDelimiterLength = 0;
  for (const delimiter of HEADER_DELIMITERS) {
    const index = indexOfBuffer(buffer, delimiter);
    if (index !== -1 && (headerEnd === -1 || index < headerEnd)) {
      headerEnd = index;
      headerDelimiterLength = delimiter.length;
    }
  }
  return { headerEnd, headerDelimiterLength };
}

function safeDecodeEslValue(value) {
  if (!value || !/%[0-9A-Fa-f]{2}/.test(value)) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseHeadersText(text, { decodeValues = false } = {}) {
  const headers = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) continue;
    const key = line.slice(0, colonIndex).trim();
    const rawValue = line.slice(colonIndex + 1).trim();
    headers[key] = decodeValues ? safeDecodeEslValue(rawValue) : rawValue;
  }
  return headers;
}

function getHeader(headers, name) {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return value;
  }
  return undefined;
}

function sanitizeReplyText(reply) {
  return String(reply ?? "")
    .replace(/\s+/g, " ")
    .replace(/(auth\s+)[^\s]+/ig, "$1[redacted]")
    .replace(/(bearer\s+)[^\s]+/ig, "$1[redacted]")
    .trim()
    .slice(0, 240);
}

function unwrapEventPlain(bodyBuffer) {
  const { headerEnd, headerDelimiterLength } = findHeaderDelimiter(bodyBuffer);
  if (headerEnd === -1) {
    return {
      headers: {},
      body: bodyBuffer.toString("utf8"),
      bodyBuffer,
    };
  }

  const eventHeadersBuffer = bodyBuffer.subarray(0, headerEnd);
  const eventHeadersText = eventHeadersBuffer.toString("utf8");
  const eventHeaders = parseHeadersText(eventHeadersText, { decodeValues: true });
  const remainder = bodyBuffer.subarray(headerEnd + headerDelimiterLength);
  const innerContentLength = Number.parseInt(getHeader(eventHeaders, "Content-Length") || "", 10);
  const innerBodyBuffer = Number.isFinite(innerContentLength)
    ? remainder.subarray(0, innerContentLength)
    : remainder;

  return {
    headers: eventHeaders,
    body: innerBodyBuffer.toString("utf8"),
    bodyBuffer: innerBodyBuffer,
  };
}

// Parser incremental de frames ESL inbound.
// Suporta fragmentacao e coalescencia de chunks, honrando Content-Length.
// Frames sem Content-Length terminam com dupla quebra de linha.
function readFrames(state, chunk, onFrame) {
  if (chunk?.length) {
    state.buffer = state.buffer.length ? Buffer.concat([state.buffer, chunk]) : Buffer.from(chunk);
  }

  while (true) {
    const { headerEnd, headerDelimiterLength } = findHeaderDelimiter(state.buffer);
    if (headerEnd === -1) return;

    const headerBlock = state.buffer.subarray(0, headerEnd);
    const headerText = headerBlock.toString("utf8");
    const contentLengthMatch = headerText.match(/Content-Length:\s*(\d+)/i);

    if (contentLengthMatch) {
      const contentLength = Number.parseInt(contentLengthMatch[1], 10);
      const frameEnd = headerEnd + headerDelimiterLength + contentLength;
      if (state.buffer.length < frameEnd) return; // body incompleto

      const frame = state.buffer.subarray(0, frameEnd);
      state.buffer = state.buffer.subarray(frameEnd);
      onFrame(Buffer.from(frame));
    } else {
      const frame = state.buffer.subarray(0, headerEnd);
      state.buffer = state.buffer.subarray(headerEnd + headerDelimiterLength);
      onFrame(Buffer.from(frame));
    }
  }
}

export class EslApiClient extends EventEmitter {
  constructor({
    host = "127.0.0.1",
    port = 8021,
    password,
    connect = net.connect,
    onLog = defaultLog,
    persistent = false,
    reconnectDelayMs = RECONNECT_DELAY_MS,
    maxReconnectAttempts = Infinity,
  }) {
    super();
    this.host = host;
    this.port = port;
    this.password = password;
    this.connect = connect;
    this.onLog = onLog;
    this.persistent = persistent;
    this.reconnectDelayMs = reconnectDelayMs;
    this.maxReconnectAttempts = maxReconnectAttempts;
    this.reconnectAttempts = 0;
    this.socket = null;
    this.ready = false;
    this.closed = false;
    this.reconnectTimer = null;
    this.bufferState = { buffer: Buffer.alloc(0) };
    this.queue = [];
    this.pendingReply = null;
  }

  sendEslApi(command) {
    if (!this.password) return Promise.resolve(false);
    return new Promise((resolve) => {
      this.queue.push({ kind: "bgapi", command, wire: `bgapi ${command}\n\n`, resolve, resolvedOnWrite: false });
      this.ensureConnected();
      this.flush();
    });
  }

  sendEslCommand(command) {
    if (!this.password) return Promise.resolve({ ok: false, reply: "ESL password missing" });
    return new Promise((resolve) => {
      this.queue.push({ kind: "command", command, wire: `${command}\n\n`, resolve, resolvedOnWrite: false });
      this.ensureConnected();
      this.flush();
    });
  }

  sendEslApiCommand(command) {
    if (!this.password) return Promise.resolve({ ok: false, reply: "ESL password missing" });
    return new Promise((resolve) => {
      this.queue.push({ kind: "api", command, wire: `api ${command}\n\n`, resolve, resolvedOnWrite: false });
      this.ensureConnected();
      this.flush();
    });
  }

  ensureConnected() {
    if (this.closed || this.ready || this.socket) return;
    try {
      const socket = this.connect({ host: this.host, port: this.port });
      this.socket = socket;
      this.bufferState = { buffer: Buffer.alloc(0) };

      this.onLog("info", "esl: conectando", { host: this.host, port: this.port });
      this.emit("connecting", { host: this.host, port: this.port });

      socket.on("data", (chunk) => {
        readFrames(this.bufferState, chunk, (frame) => this.handleFrame(frame));
      });
      socket.on("error", (err) => {
        this.onLog("warn", "erro na conexao ESL de audio", { message: err.message });
        this.emit("connection_error", { message: err.message });
        try { socket.destroy(); } catch {}
        this.reconnectAttempts += 1;
      });
      socket.on("close", () => {
        this.onLog("info", "esl: desconectado");
        this.emit("disconnect");
        if (socket !== this.socket) return;
        this.socket = null;
        this.ready = false;
        if (!this.closed && (this.persistent || this.queue.length > 0)) {
          this.reconnectAttempts += 1;
          this.scheduleReconnect();
        }
      });
    } catch (err) {
      this.onLog("warn", "falha ao abrir conexao ESL de audio", { message: err.message });
      this.emit("connection_error", { message: err.message });
      this.socket = null;
      this.reconnectAttempts += 1;
      this.scheduleReconnect();
    }
  }

  handleFrame(frame) {
    if (!this.socket) return;
    let { headerEnd, headerDelimiterLength: delimiterLength } = findHeaderDelimiter(frame);
    const headersBuffer = headerEnd >= 0 ? frame.subarray(0, headerEnd) : frame;
    const bodyBuffer = headerEnd >= 0 ? frame.subarray(headerEnd + delimiterLength) : Buffer.alloc(0);
    const headers = headersBuffer.toString("utf8");
    let body = bodyBuffer.toString("utf8");

    if (/content-type:\s*auth\/request/i.test(headers)) {
      this.socket.write(`auth ${this.password}\n\n`);
      return;
    }
    const contentTypeMatch = headers.match(/Content-Type:\s*([^\n]+)/i);
    const contentType = contentTypeMatch?.[1]?.trim().toLowerCase();
    const replyTextMatch = headers.match(/Reply-Text:\s*([^\n]+)/i);
    const replyText = replyTextMatch?.[1]?.trim();

    if (/reply-text:\s*\+OK/i.test(headers) && !this.ready) {
      this.ready = true;
      this.reconnectAttempts = 0;
      this.onLog("info", "esl: autenticado");
      this.emit("authenticated");
      this.flush();
      return;
    }

    if (contentType === "api/response" || contentType === "command/reply" || replyText) {
      const reply = replyText ?? body.trim();
      const ok = replyText ? /^\+ok\b/i.test(replyText) : !/^-err\b/i.test(reply);
      const pending = this.pendingReply;

      if (pending) {
        this.pendingReply = null;
        if (!pending.resolvedOnWrite) {
          pending.resolve({ ok, reply, headers, body, command: pending.command, kind: pending.kind });
        }
        this.flush();
      }

      this.emit("reply", {
        ok,
        reply,
        replySanitized: sanitizeReplyText(reply),
        headers,
        body,
        contentType,
        command: pending?.command,
        kind: pending?.kind,
      });
      if (!ok) {
        this.onLog("warn", "ESL recusou comando/autenticacao", { reply: sanitizeReplyText(reply), headers });
        this.emit("command_error", { reply, headers, body, contentType });
      }
      return;
    }

    const outerHeaders = parseHeadersText(headers);
    const unwrapped = contentType === "text/event-plain"
      ? unwrapEventPlain(bodyBuffer)
      : { headers: parseHeadersText(headers, { decodeValues: true }), body, bodyBuffer };
    const eventHeaders = unwrapped.headers;
    body = unwrapped.body;
    const subclass = getHeader(eventHeaders, "Event-Subclass")?.trim();
    const eventName = getHeader(eventHeaders, "Event-Name")?.trim();
    const uuid = getHeader(eventHeaders, "Unique-ID")?.trim();

    if (eventName === "CHANNEL_EXECUTE_COMPLETE" || eventName === "CHANNEL_EXECUTE") {
      const app = getHeader(eventHeaders, "Application")?.trim();
      const appData = getHeader(eventHeaders, "Application-Data")?.trim();
      if (app?.includes("audio_stream") || appData?.includes("audio_stream")) {
        this.onLog("info", "esl: evento de audio_stream", {
          eventName,
          uuid,
          application: app,
          applicationData: appData,
        });
        this.emit("audio_stream_event", {
          eventName,
          uuid,
          application: app,
          applicationData: appData,
          frame: Buffer.from(frame),
          outerHeaders,
          eventHeaders,
          body,
        });
      }
    }

    if (subclass) {
      const highFrequencyPlayback = subclass === "mod_audio_stream::play"
        || subclass === "mod_audio_stream::playback";
      if (!highFrequencyPlayback) {
        this.onLog("debug", "esl: subclass", { subclass, uuid, eventName });
      }
      this.emit("subclass", { subclass, uuid, eventName, frame: Buffer.from(frame), outerHeaders, eventHeaders, body });

      // Subclasses assinadas pelo mod_audio_stream:
      // connect, disconnect, error, json, play, playback.
      // Eventos chunk_played/queue_completed vêm DENTRO da subclass playback,
      // no Body como JSON: {"event":"chunk_played",...} ou {"event":"queue_completed",...}.
      if (subclass === "mod_audio_stream::playback") {
        const bodyText = body.trim();
        let playbackEvent = null;
        let playbackPayload = null;
        try {
          if (bodyText) {
            playbackPayload = JSON.parse(bodyText);
            playbackEvent = playbackPayload?.event;
          }
        } catch {
          this.onLog("debug", "esl: playback body nao-json", { uuid, bodyText: bodyText?.slice(0, 200) });
        }

        this.emit("playback", { uuid, playbackEvent, payload: playbackPayload, frame: Buffer.from(frame), outerHeaders, eventHeaders, body });

        if (playbackEvent === "chunk_played") {
          this.emit("chunk_played", { uuid, payload: playbackPayload });
        }
        if (playbackEvent === "queue_completed") {
          this.emit("queue_completed", { uuid, payload: playbackPayload });
        }
      }

      if (subclass === "mod_audio_stream::connect") {
        this.onLog("info", "esl: mod_audio_stream connect", { uuid });
        this.emit("mod_audio_stream_connect", { uuid, frame: Buffer.from(frame), outerHeaders, eventHeaders, body });
      }
      if (subclass === "mod_audio_stream::disconnect") {
        this.onLog("info", "esl: mod_audio_stream disconnect", { uuid });
        this.emit("mod_audio_stream_disconnect", { uuid, frame: Buffer.from(frame), outerHeaders, eventHeaders, body });
      }
      if (subclass === "mod_audio_stream::error") {
        this.onLog("warn", "esl: mod_audio_stream error", { uuid, frame });
        this.emit("mod_audio_stream_error", { uuid, frame: Buffer.from(frame), outerHeaders, eventHeaders, body });
      }
      if (subclass === "mod_audio_stream::json") {
        this.onLog("debug", "esl: mod_audio_stream json", { uuid, frame });
        this.emit("mod_audio_stream_json", { uuid, frame: Buffer.from(frame), outerHeaders, eventHeaders, body });
      }
      if (subclass === "mod_audio_stream::play") {
        this.emit("mod_audio_stream_play", { uuid, frame: Buffer.from(frame), outerHeaders, eventHeaders, body });
      }
    }

    this.emit("raw_event", { eventName, subclass, uuid, frame: Buffer.from(frame), outerHeaders, eventHeaders, body });
  }

  flush() {
    if (!this.ready || !this.socket) return;
    while (this.queue.length > 0) {
      if (this.pendingReply) return;
      const entry = this.queue[0];
      try {
        this.pendingReply = entry;
        this.socket.write(entry.wire);
        this.queue.shift();
        if (entry.kind === "bgapi") {
          entry.resolvedOnWrite = true;
          entry.resolve(true);
        }
      } catch (err) {
        if (this.pendingReply === entry) this.pendingReply = null;
        this.onLog("warn", "falha ao escrever comando ESL", { message: err.message });
        if (this.queue[0] !== entry) this.queue.unshift(entry);
        try { this.socket.destroy(); } catch {}
        break;
      }
    }
  }

  scheduleReconnect() {
    if (this.closed || this.reconnectTimer || (!this.persistent && this.queue.length === 0)) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.onLog("warn", "esl: maximo de tentativas de reconexao atingido; desistindo", {
        host: this.host,
        port: this.port,
        attempts: this.reconnectAttempts,
      });
      this.closed = true;
      return;
    }
    const delay = Math.min(30_000, this.reconnectDelayMs * (2 ** this.reconnectAttempts));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.ensureConnected();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  close() {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    try { this.socket?.destroy(); } catch {}
    this.socket = null;
    this.ready = false;
    if (this.pendingReply) {
      if (!this.pendingReply.resolvedOnWrite) {
        this.pendingReply.resolve({ ok: false, reply: "connection closed" });
      }
      this.pendingReply = null;
    }
    while (this.queue.length) {
      const entry = this.queue.shift();
      entry.resolve(entry.kind === "bgapi" ? false : { ok: false, reply: "connection closed" });
    }
  }
}

/**
 * Retorna um sender ESL compartilhado ou null quando ESL foi deliberadamente
 * deixado sem senha neste processo.
 */
export function getSharedEslApiClient({ env = process.env, onLog = defaultLog } = {}) {
  const password = (env.FUSION_ESL_PASSWORD || env.ESL_PASSWORD || "").trim();
  if (!password) {
    if (!warnedMissingPassword) {
      warnedMissingPassword = true;
      onLog("warn", "ESL sem senha configurada; barge-in por break desabilitado");
    }
    return null;
  }

  if (!sharedClient) {
    sharedClient = new EslApiClient({
      host: env.FUSION_ESL_HOST || env.ESL_HOST || "127.0.0.1",
      port: Number.parseInt(env.FUSION_ESL_PORT || env.ESL_PORT || "8021", 10),
      password,
      onLog,
      persistent: true,
      reconnectDelayMs: 500,
      maxReconnectAttempts: 5,
    });
  }
  return sharedClient;
}

export function getSharedEslApiSender({ env = process.env, onLog = defaultLog } = {}) {
  const client = getSharedEslApiClient({ env, onLog });
  return client ? (command) => client.sendEslApi(command) : null;
}

/** Função publica para enviar um comando bgapi pela conexao ESL compartilhada. */
export function sendEslApi(command, options) {
  const sender = getSharedEslApiSender(options);
  return sender ? sender(command) : Promise.resolve(false);
}

export { readFrames, sanitizeReplyText };
