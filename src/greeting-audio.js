import WebSocket from "ws";

const DEFAULT_REALTIME_URL = "wss://api.x.ai/v1/realtime";
const OUTPUT_RATE = 16_000;

export function pcm16ToWav(pcm, { sampleRate = OUTPUT_RATE, channels = 1 } = {}) {
  if (!Buffer.isBuffer(pcm) || pcm.length % 2 !== 0) {
    throw new Error("pcm16ToWav requer PCM16");
  }
  const dataBytes = pcm.length;
  const blockAlign = channels * 2;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write("WAVEfmt ", 8, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * blockAlign, 28);
  wav.writeUInt16LE(blockAlign, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(dataBytes, 40);
  pcm.copy(wav, 44);
  return wav;
}

function buildSessionUpdate({ text, model, voice, speed }) {
  return {
    type: "session.update",
    session: {
      model: model || "grok-voice-latest",
      voice: voice || "eve",
      speed: Number(speed) || 1,
      instructions: [
        `Diga exatamente: "${String(text || "").trim()}"`,
        "Use tom natural de pergunta curta, com entonacao ascendente em cada pergunta.",
        "Nao acrescente outras frases.",
      ].join(" "),
      audio: {
        output: { format: { type: "audio/pcm", rate: OUTPUT_RATE } },
      },
    },
  };
}

export async function generateGreetingWav({
  text,
  model = "grok-voice-latest",
  voice = "eve",
  speed = 1,
  apiKey = process.env.XAI_API_KEY,
  realtimeUrl = process.env.XAI_REALTIME_URL || DEFAULT_REALTIME_URL,
  WebSocketImpl = WebSocket,
  timeoutMs = 15_000,
} = {}) {
  if (!apiKey) throw new Error("XAI_API_KEY ausente");
  if (!String(text || "").trim()) throw new Error("texto da saudacao ausente");

  const url = new URL(realtimeUrl);
  url.searchParams.set("model", model || "grok-voice-latest");
  const socket = new WebSocketImpl(url.toString(), { headers: { Authorization: `Bearer ${apiKey}` } });
  const chunks = [];

  return await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err, wav = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close?.(); } catch {}
      if (err) reject(err);
      else resolve(wav);
    };
    const timer = setTimeout(() => finish(new Error("timeout gerando saudacao xAI")), timeoutMs);
    timer.unref?.();

    socket.on("open", () => {
      socket.send(JSON.stringify(buildSessionUpdate({ text, model, voice, speed })));
      socket.send(JSON.stringify({ type: "response.create" }));
    });
    socket.on("message", (data) => {
      let event;
      try { event = JSON.parse(data.toString("utf8")); } catch { return; }
      if (event.type === "error") {
        finish(new Error(event.error?.message || event.message || "erro xAI"));
        return;
      }
      if (event.type === "response.output_audio.delta" && event.delta) {
        chunks.push(Buffer.from(event.delta, "base64"));
        return;
      }
      if (event.type === "response.done" || event.type === "response.output_audio.done") {
        const pcm = Buffer.concat(chunks);
        if (!pcm.length) finish(new Error("xAI nao retornou audio"));
        else finish(null, pcm16ToWav(pcm, { sampleRate: OUTPUT_RATE, channels: 1 }));
      }
    });
    socket.on("error", finish);
    socket.on("close", () => {
      if (!settled && chunks.length) finish(null, pcm16ToWav(Buffer.concat(chunks), { sampleRate: OUTPUT_RATE, channels: 1 }));
      else if (!settled) finish(new Error("websocket xAI fechou sem audio"));
    });
  });
}

