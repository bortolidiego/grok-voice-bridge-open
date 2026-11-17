import { createSupervisor } from "./process-supervisor.js";

const supervisor = createSupervisor();
supervisor.startAll();

process.once("SIGTERM", () => supervisor.stopAll("SIGTERM"));
process.once("SIGINT", () => supervisor.stopAll("SIGINT"));

