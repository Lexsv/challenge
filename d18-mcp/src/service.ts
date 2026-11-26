import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Readable } from "node:stream";
import { LOG_BUDGET, RotatingLogs, type Channel } from "./rotating-logs.js";

async function run() {
  process.umask(0o077);
  const directory = process.env.LOG_DIRECTORY ?? dirname(process.env.DATABASE_PATH!);
  const logs = new RotatingLogs(directory, Number(process.env.LOG_MAX_BYTES ?? LOG_BUDGET));
  const main = fileURLToPath(new URL("./main.js", import.meta.url));
  const child = spawn(process.execPath, [main], {stdio: ["ignore", "pipe", "pipe"]});
  const closed = once(child, "close");
  const stop = () => { child.kill("SIGTERM"); };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  async function capture(pipe: Readable, channel: Channel) {
    for await (const chunk of pipe) logs.write(channel, chunk);
  }
  const captures = [capture(child.stdout, "server.log"), capture(child.stderr, "error.log")];
  try {
    const [[code]] = await Promise.all([closed, ...captures]);
    process.exitCode = code ?? 1;
  } catch (error) {
    stop();
    await Promise.allSettled([closed, ...captures]);
    throw error;
  } finally {
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
  }
}

run().catch(() => {
  // launchd owns no append-only files. Report sink failures out of band.
  spawnSync("/usr/bin/logger", ["-t", "local.d18.weather-mcp", "Weather log capture failed; inspect log directory access and free space."]);
  process.exitCode = 1;
});
