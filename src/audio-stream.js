/** Entry point independente do transporte mod_audio_stream <-> xAI. */

import { createAudioPlaybackTracker, createAudioStreamServer, loadXaiApiKey } from "./audio-stream-server.js";
import { getSharedEslApiClient, sanitizeReplyText } from "./audio-esl-client.js";

const MOD_AUDIO_STREAM_SUBCLASSES = ["connect", "disconnect", "error", "json", "play", "playback"];

function log(level, message, meta = {}) {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, message, ...meta }));
}

function parseUuidAudioStreamCommand(command) {
  const match = typeof command === "string"
    ? command.match(/^uuid_audio_stream\s+([A-Za-z0-9-]{1,128})\s+(stop|break)\b/i)
    : null;
  if (!match) return null;
  return { uuid: match[1], action: match[2].toLowerCase() };
}

function parsePort(value) {
  const port = Number.parseInt(value || "8830", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("AUDIO_WS_PORT deve ser uma porta entre 1 e 65535");
  }
  return port;
}

function createEslPlaybackLogAggregator({
  onLog,
  windowMs = 1_000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  const calls = new Map();

  const flush = (uuid) => {
    const state = calls.get(uuid);
    if (!state) return;
    if (state.timer !== null) clearTimer(state.timer);
    calls.delete(uuid);
    onLog("info", "observer ESL: resumo play/playback", {
      uuid,
      windowMs,
      play: state.play,
      playback: state.playback,
      chunkPlayed: state.chunkPlayed,
      queueCompleted: state.queueCompleted,
      otherPlayback: state.otherPlayback,
    });
  };

  const stateFor = (uuid) => {
    let state = calls.get(uuid);
    if (state) return state;
    state = {
      play: 0,
      playback: 0,
      chunkPlayed: 0,
      queueCompleted: 0,
      otherPlayback: 0,
      timer: null,
    };
    state.timer = setTimer(() => flush(uuid), windowMs);
    state.timer?.unref?.();
    calls.set(uuid, state);
    return state;
  };

  return {
    recordPlay(uuid) {
      stateFor(uuid).play += 1;
    },
    recordPlayback(uuid, playbackEvent) {
      const state = stateFor(uuid);
      state.playback += 1;
      if (playbackEvent === "chunk_played") state.chunkPlayed += 1;
      else if (playbackEvent === "queue_completed") state.queueCompleted += 1;
      else state.otherPlayback += 1;
    },
    flush,
    flushAll() {
      for (const uuid of [...calls.keys()]) flush(uuid);
    },
  };
}

export function attachEslObserver({
  client,
  onLog = log,
  playbackTracker,
  aggregateWindowMs = 1_000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (!client) return null;
  const playbackLogs = createEslPlaybackLogAggregator({
    onLog,
    windowMs: aggregateWindowMs,
    setTimer,
    clearTimer,
  });

  client.on("connection_error", (meta) => onLog("warn", "observer ESL: erro de conexao", meta));
  client.on("reply", ({ ok, reply, contentType, command, kind }) => {
    if (!ok) onLog("warn", "observer ESL: reply nao-ok", { reply: sanitizeReplyText(reply), contentType });
    const parsed = parseUuidAudioStreamCommand(command);
    if (parsed) {
      onLog(ok ? "info" : "warn", "observer ESL: uuid_audio_stream reply", {
        uuid: parsed.uuid,
        action: parsed.action,
        ok,
        kind,
        reply: sanitizeReplyText(reply),
      });
    }
  });
  client.on("audio_stream_event", ({ eventName, uuid, application, applicationData }) => {
    onLog("info", "observer ESL: evento de audio_stream", { eventName, uuid, application, applicationData });
  });
  client.on("mod_audio_stream_connect", ({ uuid }) => onLog("info", "observer ESL: connect", { uuid }));
  client.on("mod_audio_stream_disconnect", ({ uuid }) => {
    playbackLogs.flush(uuid);
    onLog("info", "observer ESL: disconnect", { uuid });
  });
  client.on("mod_audio_stream_error", ({ uuid, body }) => onLog("warn", "observer ESL: error", { uuid, body }));
  client.on("mod_audio_stream_json", ({ uuid, body }) => onLog("debug", "observer ESL: json", { uuid, body }));
  client.on("mod_audio_stream_play", ({ uuid }) => {
    playbackTracker?.recordPlayAccepted(uuid);
    playbackLogs.recordPlay(uuid);
  });
  client.on("playback", ({ uuid, playbackEvent }) => {
    if (playbackEvent === "chunk_played") playbackTracker?.recordChunkPlayed(uuid);
    if (playbackEvent === "queue_completed") playbackTracker?.recordQueueCompleted(uuid);
    playbackLogs.recordPlayback(uuid, playbackEvent);
  });
  client.on("disconnect", () => playbackLogs.flushAll());

  return client;
}

export async function subscribeEslObserver({ client, onLog = log } = {}) {
  if (!client) return false;

  const subscription = await client.sendEslCommand("event plain CUSTOM mod_audio_stream::connect mod_audio_stream::disconnect mod_audio_stream::error mod_audio_stream::json mod_audio_stream::play mod_audio_stream::playback");
  if (!subscription?.ok) {
    onLog("warn", "observer ESL: falha ao assinar eventos", { reply: subscription?.reply });
    return false;
  }

  const channelEventsReply = await client.sendEslCommand("event plain CHANNEL_EXECUTE CHANNEL_EXECUTE_COMPLETE");
  if (!channelEventsReply?.ok) {
    onLog("warn", "observer ESL: falha ao assinar channel execute", { reply: channelEventsReply?.reply });
    return false;
  }

  onLog("info", "observer ESL: assinatura ativa", { subclasses: MOD_AUDIO_STREAM_SUBCLASSES });
  return true;
}

export function startAudioStreamServer({
  env = process.env,
  onLog = log,
  apiKey = loadXaiApiKey({ env }),
  createServer = createAudioStreamServer,
  getEslClient = getSharedEslApiClient,
} = {}) {
  const port = parsePort(env.AUDIO_WS_PORT);
  const playbackTracker = createAudioPlaybackTracker();
  const server = createServer({
    host: "0.0.0.0",
    port,
    apiKey,
    onLog,
    env,
    playbackTracker,
  });

  const client = attachEslObserver({
    client: getEslClient({ env, onLog }),
    onLog,
    playbackTracker,
  });

  if (client) {
    server.once("listening", () => {
      if (typeof client.ensureConnected === "function") {
        client.persistent = true;
        client.on("authenticated", () => {
          subscribeEslObserver({ client, onLog }).catch((err) => {
            onLog("warn", "observer ESL: reassinatura falhou em modo fail-open", { message: err.message });
          });
        });
        client.ensureConnected();
      } else {
        subscribeEslObserver({ client, onLog }).catch((err) => {
          onLog("warn", "observer ESL: assinatura falhou em modo fail-open", { message: err.message });
        });
      }
    });
  }

  return { server, client, port };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const { server, port } = startAudioStreamServer();
    server.on("listening", () => log("info", "audio stream server iniciado", { host: "0.0.0.0", port }));

    const shutdown = (signal) => {
      log("info", "encerrando audio stream server", { signal });
      server.closeAudioStreams();
      server.close(() => process.exit(0));
    };
    process.once("SIGTERM", () => shutdown("SIGTERM"));
    process.once("SIGINT", () => shutdown("SIGINT"));
  } catch (err) {
    log("error", "falha ao iniciar audio stream server", { message: err.message });
    process.exit(1);
  }
}
