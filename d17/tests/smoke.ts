import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { verifySubscriptions } from "./subscriptions.js";

// Exercise the compiled composition root and real HTTP stack on an unused loopback port.
const probe = createServer();
probe.listen(0, "127.0.0.1");
await once(probe, "listening");
const { port } = probe.address() as AddressInfo;
await new Promise<void>(resolve => probe.close(() => resolve()));
const origin = "http://127.0.0.1:" + port;
const url = new URL("/mcp", origin);
const token = randomBytes(32).toString("hex");
mkdirSync(".test-data", { recursive: true });
const dir = mkdtempSync(".test-data/smoke-");
const database = join(dir, "tasks.sqlite");
const child = spawn(process.execPath, ["dist/src/service.js"], {
  env: { SERVER_HOST: "127.0.0.1", SERVER_PORT: String(port), DATABASE_PATH: database, LOG_DIR: dir,
    MCP_AUTH_TOKEN: token, LOG_LEVEL: "info", SESSION_IDLE_MS: "500", POLL_INTERVAL_MS: "25" },
  stdio: ["ignore", "ignore", "inherit"]
});
const exited = once(child, "exit");
const client = new Client({ name: "day17-smoke", version: "1" });
const logPath = join(dir, "scheduler.log");
const deadline = setTimeout(() => child.kill("SIGKILL"), 15_000);
try {
  let started = false;
  while (child.exitCode === null && child.signalCode === null) {
    if (existsSync(logPath) && readFileSync(logPath, "utf8").includes('"event":"server.listening"')) {
      started = true;
      break;
    }
    await delay(25);
  }
  assert.ok(started, "Scheduler did not start");
  const headers = { Authorization: "Bearer " + token };
  assert.equal((await fetch(url, { method: "POST" })).status, 401);
  for (const authorization of ["", "Bearer ", "Bearer " + randomBytes(32).toString("hex")]) {
    const denied = await fetch(url, { method: "POST", headers: { Authorization: authorization } });
    assert.equal(denied.status, 401);
  }
  assert.equal((await fetch(url, { method: "POST", headers: { ...headers, Origin: "https://unknown.example" } })).status, 403);
  assert.equal((await fetch(url, { headers })).status, 400);
  const preflight = await fetch(url, { method: "OPTIONS", headers: { Origin: origin, "Access-Control-Request-Method": "POST" } });
  assert.equal(preflight.headers.get("Access-Control-Allow-Origin"), origin);
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } }));
  assert.deepEqual((await client.listTools()).tools.map(t => t.name), ["create_reminder"]);
  const scheduledAt = new Date(Date.now() + 3_600_000).toISOString();
  const response = await client.callTool({ name: "create_reminder", arguments: { message: "smoke reminder", scheduledAt } });
  const data = response.structuredContent;
  assert.ok(data && typeof data === "object" && "id" in data);
  const { id } = data;
  assert.equal(typeof id, "string");
  assert.deepEqual(response.structuredContent, { id, type: "reminder", status: "pending", message: "smoke reminder", scheduledAt });
  await verifySubscriptions(url, token);
  // Leave the original GET open to verify SIGTERM drains persistent streams.
  child.kill("SIGTERM");
  const [code] = await exited;
  await client.close();
  assert.equal(code, 0);
  const captured = readFileSync(logPath, "utf8");
  assert.ok(captured.includes('"event":"task.created"'));
  assert.ok(!captured.includes(token) && !captured.includes("smoke reminder"));
  assert.ok(existsSync(join(dir, "stdout.log")));
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    assert.equal(db.prepare("SELECT status FROM tasks WHERE id=?").get(String(id))?.status, "pending");
  } finally { db.close(); }
  console.log("Streamable HTTP smoke passed: tools, authenticated SSE, subscriptions, isolation, resubscription, expiry, shutdown and SQLite readback.");
} finally {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  await exited;
  clearTimeout(deadline);
  rmSync(dir, { recursive: true });
}
