// launchd supervises this process. The child retains its existing console
// logger; pipes capture its native stdout/stderr as well as application logs.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { captureOutput, rotationSettings } from "./infrastructure/rotating-output.js";

async function runService() {
  const settings = rotationSettings(process.env);
  const main = fileURLToPath(new URL("./main.js", import.meta.url));
  const child = spawn(process.execPath, [main], { stdio: ["ignore", "pipe", "pipe"] });
  const stopped = once(child, "close");
  const terminate = () => { child.kill("SIGTERM"); };
  process.on("SIGINT", terminate);
  process.on("SIGTERM", terminate);
  const streams = [
    captureOutput(child.stdout, "stdout.log", settings),
    captureOutput(child.stderr, "scheduler.log", settings)
  ];
  try {
    const [[code]] = await Promise.all([stopped, ...streams]);
    process.exitCode = code ?? 1;
  } catch (error) {
    terminate();
    // Drain any surviving pipe and release the SQLite lock before launchd retries.
    child.stdout.resume();
    child.stderr.resume();
    await Promise.allSettled([stopped, ...streams]);
    throw error;
  } finally {
    process.off("SIGINT", terminate);
    process.off("SIGTERM", terminate);
  }
}

runService().catch(() => {
  console.error(JSON.stringify({ time: new Date().toISOString(), level: "error", event: "service.capture_failed" }));
  process.exitCode = 1;
});
