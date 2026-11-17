import { spawn } from "node:child_process";

function defaultLog(level, message, meta = {}) {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, message, ...meta }));
}

export function buildProcessSpecs({ nodeBin = process.execPath } = {}) {
  return [
    { name: "http-api", command: nodeBin, args: ["src/server.js"] },
    { name: "audio-ws", command: nodeBin, args: ["src/audio-stream.js"] },
  ];
}

export function createSupervisor({
  specs = buildProcessSpecs(),
  spawnImpl = spawn,
  restartDelayMs = 1_000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  onLog = defaultLog,
  exit = process.exit,
} = {}) {
  const children = new Map();
  const timers = new Map();
  let stopping = false;

  const start = (spec) => {
    if (stopping || children.has(spec.name)) return;
    onLog("info", "iniciando processo", { name: spec.name, command: spec.command, args: spec.args });
    const child = spawnImpl(spec.command, spec.args, {
      stdio: ["ignore", "inherit", "inherit"],
      env: process.env,
    });
    children.set(spec.name, child);
    child.on("exit", (code, signal) => {
      children.delete(spec.name);
      onLog(code === 0 && stopping ? "info" : "warn", "processo saiu", {
        name: spec.name,
        code,
        signal,
      });
      if (stopping && children.size === 0) {
        exit(0);
        return;
      }
      if (!stopping) {
        const timer = setTimer(() => {
          timers.delete(spec.name);
          start(spec);
        }, restartDelayMs);
        timer?.unref?.();
        timers.set(spec.name, timer);
      }
    });
  };

  const startAll = () => {
    for (const spec of specs) start(spec);
  };

  const stopAll = (signal = "SIGTERM") => {
    if (stopping) return;
    stopping = true;
    for (const timer of timers.values()) clearTimer(timer);
    timers.clear();
    for (const [name, child] of children.entries()) {
      onLog("info", "encerrando processo", { name, signal });
      try { child.kill(signal); } catch {}
    }
    if (children.size === 0) exit(0);
  };

  return { startAll, stopAll, children, timers };
}
