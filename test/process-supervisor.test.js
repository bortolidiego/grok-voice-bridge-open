import { EventEmitter } from "node:events";
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildProcessSpecs, createSupervisor } from "../src/process-supervisor.js";

test("buildProcessSpecs inicia API HTTP e listener WS de audio", () => {
  assert.deepEqual(buildProcessSpecs({ nodeBin: "node" }), [
    { name: "http-api", command: "node", args: ["src/server.js"] },
    { name: "audio-ws", command: "node", args: ["src/audio-stream.js"] },
  ]);
});

test("supervisor reinicia processo filho quando ele sai inesperadamente", () => {
  const spawned = [];
  const timers = [];
  const spawnImpl = (command, args) => {
    const child = new EventEmitter();
    child.kill = () => {};
    spawned.push({ command, args, child });
    return child;
  };
  const supervisor = createSupervisor({
    specs: [{ name: "audio-ws", command: "node", args: ["src/audio-stream.js"] }],
    spawnImpl,
    setTimer: (fn) => {
      timers.push(fn);
      return { unref() {} };
    },
    onLog: () => {},
  });

  supervisor.startAll();
  spawned[0].child.emit("exit", 1, null);
  assert.equal(spawned.length, 1);
  timers[0]();
  assert.equal(spawned.length, 2);
});

test("supervisor encerra quando todos os filhos param apos SIGTERM", () => {
  const spawned = [];
  let exitCode = null;
  const spawnImpl = (command, args) => {
    const child = new EventEmitter();
    child.killedWith = null;
    child.kill = (signal) => { child.killedWith = signal; };
    spawned.push(child);
    return child;
  };
  const supervisor = createSupervisor({
    specs: [
      { name: "http-api", command: "node", args: ["src/server.js"] },
      { name: "audio-ws", command: "node", args: ["src/audio-stream.js"] },
    ],
    spawnImpl,
    onLog: () => {},
    exit: (code) => { exitCode = code; },
  });

  supervisor.startAll();
  supervisor.stopAll("SIGTERM");
  assert.deepEqual(spawned.map(child => child.killedWith), ["SIGTERM", "SIGTERM"]);
  spawned[0].emit("exit", 0, "SIGTERM");
  assert.equal(exitCode, null);
  spawned[1].emit("exit", 0, "SIGTERM");
  assert.equal(exitCode, 0);
});
