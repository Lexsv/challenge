import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { newReminder, parseSchedule, ValidationError, type DomainEvent } from "../src/domain/task.js";
import { CreateReminder } from "../src/application/use-cases/create-reminder.js";
import { Scheduler, TaskExecution } from "../src/application/scheduler.js";
import type { ITaskExecutor } from "../src/application/ports/index.js";
import { SqliteTasks } from "../src/infrastructure/sqlite-tasks.js";
import { LocalEventPublisher, ReminderExecutor } from "../src/infrastructure/runtime.js";
import { Logger, logTaskEvent } from "../src/infrastructure/logger.js";
import { createMcpServer, logMcpMessage } from "../src/presentation/mcp/server.js";
import { loadConfig } from "../src/config/config.js";

const epoch = Date.parse("2028-02-29T12:00:00Z");
const later = "2028-02-29T09:01:00-03:00";

function fixture(path = ":memory:") {
  const db = new DatabaseSync(path);
  const clock = { time: epoch, now() { return this.time; } };
  const observed: DomainEvent[] = [];
  const events = new LocalEventPublisher(e => observed.push(e));
  const tasks = new SqliteTasks(db, events);
  const create = new CreateReminder(tasks, clock, events, randomUUID);
  const row = (id: string) => db.prepare("SELECT * FROM tasks WHERE id=?").get(id)!;
  const scheduler = (executors: ITaskExecutor[]) =>
    new Scheduler(tasks, clock, new TaskExecution(executors), events);
  return { db, tasks, clock, events, observed, create, row, scheduler };
}

test("schedule normalizes offsets and rejects impossible, ambiguous and expired times", () => {
  assert.equal(parseSchedule(later, epoch).scheduledAt, epoch + 60_000);
  for (const invalid of ["2029-02-29T18:00Z", "2028-02-30T18:00Z", "2028-02-29T23:00",
    "2028-02-29T12:00Z", "2028-02-28T12:00Z", "2028-02-29T25:15Z", "2028-03-01T09:00+24:00", ""]) {
    assert.throws(() => parseSchedule(invalid, epoch), ValidationError);
  }
  assert.throws(() => newReminder("id", "  ", later, epoch), ValidationError);
});

test("create persists the normalized pending task before publishing", t => {
  const f = fixture();
  t.after(() => f.db.close());
  const task = f.create.execute("  lunch  ", later);
  assert.equal(task.type, "reminder");
  assert.equal(f.row(task.id).status, "pending");
  assert.equal(f.row(task.id).message, "lunch");
  assert.equal(f.row(task.id).scheduled_at, epoch + 60_000);
  assert.deepEqual(f.observed, [{ kind: "task.created", taskId: task.id }]);
  assert.throws(() => f.create.execute("bad", "yesterday"), ValidationError);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM tasks").get()?.n, 1);
});

test("overlapping polls claim once, persist the result, and leave future tasks pending", async t => {
  const f = fixture();
  t.after(() => f.db.close());
  const due = f.create.execute("lunch", later);
  const future = f.create.execute("dinner", "2028-02-29T18:00Z");
  const gate = Promise.withResolvers<void>();
  let calls = 0;
  const runner = f.scheduler([{ type: "reminder", async execute(task) {
    calls++;
    await gate.promise;
    return "executed " + task.message;
  } }]);
  await runner.runDue();
  assert.equal(calls, 0);
  f.clock.time += 60_000;
  const first = runner.runDue();
  assert.equal(f.row(due.id).status, "running");
  await runner.runDue();
  gate.resolve();
  await first;
  assert.equal(calls, 1);
  assert.equal(f.row(due.id).status, "completed");
  assert.equal(f.row(due.id).result, "executed lunch");
  assert.equal(f.row(future.id).status, "pending");
  assert.equal(f.observed.at(-1)?.kind, "task.finished");
  assert.throws(() => f.tasks.finish(due.id, { status: "failed", error: "late" }));
});

test("selects reminder executor by type and reports missing or duplicate registrations", async () => {
  const emitted: string[] = [];
  const executor = new ReminderExecutor(message => emitted.push(message));
  const task = newReminder("a", "hello", later, epoch);
  assert.deepEqual(await new TaskExecution([executor]).run(task), { status: "completed", result: "hello" });
  assert.deepEqual(emitted, ["hello"]);
  assert.deepEqual(await new TaskExecution([]).run(task), { status: "failed", error: "No executor for reminder" });
  assert.throws(() => new TaskExecution([executor, executor]), /Duplicate executor/);
});

test("executor failure is persisted and does not prevent the next execution", async t => {
  const f = fixture();
  t.after(() => f.db.close());
  const bad = f.create.execute("bad", later);
  const good = f.create.execute("good", later);
  f.clock.time += 60_000;
  await f.scheduler([new ReminderExecutor(message => {
    if (message === "bad") throw new Error("delivery failed");
  })]).runDue();
  assert.equal(f.row(bad.id).status, "failed");
  assert.equal(f.row(bad.id).error, "delivery failed");
  assert.equal(f.row(good.id).status, "completed");
});

test("exclusive owner, restart recovery, and overdue pending tasks on disk", async t => {
  mkdirSync(".test-data", { recursive: true });
  const dir = mkdtempSync(".test-data/restart-");
  t.after(() => rmSync(dir, { recursive: true }));
  const path = join(dir, "tasks.sqlite");
  const first = fixture(path);
  let interrupted, pending;
  try {
    interrupted = first.create.execute("in flight", later);
    first.tasks.claimDue(epoch + 60_000);
    pending = first.create.execute("waiting", later);
    const other = new DatabaseSync(path);
    try { assert.throws(() => new SqliteTasks(other, first.events), /locked|busy/i); }
    finally { other.close(); }
  } finally { first.db.close(); }
  const next = fixture(path);
  t.after(() => next.db.close());
  assert.equal(next.tasks.recoverInterrupted(), 1);
  assert.equal(next.tasks.recoverInterrupted(), 0);
  assert.equal(next.row(interrupted.id).status, "failed");
  assert.match(String(next.row(interrupted.id).error), /unknown/);
  next.clock.time += 61_000;
  const emitted: string[] = [];
  await next.scheduler([new ReminderExecutor(s => emitted.push(s))]).runDue();
  assert.deepEqual(emitted, ["waiting"]);
  assert.equal(next.row(pending.id).status, "completed");
});

test("MCP advertises the tool, invokes the use case, rejects invalid input", async t => {
  const f = fixture();
  const lines: string[] = [];
  const logger = new Logger("info", "UTC", line => lines.push(line));
  const server = createMcpServer(f.create, logger);
  const client = new Client({ name: "test", version: "1" });
  const [a,b] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); f.db.close(); });
  a.onmessage = message => logMcpMessage(logger, message);
  await server.connect(a);
  await client.connect(b);
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ["create_reminder"]);
  const call = (args: Record<string, unknown>) => client.callTool({ name: "create_reminder", arguments: args });
  const reply = await call({ message: "tea", scheduledAt: later });
  const data = reply.structuredContent;
  assert.ok(data && typeof data === "object" && "id" in data);
  const { id } = data;
  assert.equal(typeof id, "string");
  assert.deepEqual(reply.structuredContent, { id, type: "reminder", status: "pending",
    message: "tea", scheduledAt: "2028-02-29T12:01:00.000Z" });
  assert.deepEqual(reply.content, [
    { type: "text", text: JSON.stringify(data) },
    { type: "resource_link", uri: "scheduler://tasks/" + id, name: "task-status", mimeType: "application/json" }
  ]);
  for (const args of [{ message: "  ", scheduledAt: later }, { message: 3, scheduledAt: later },
    { message: "tea" }, { message: "tea", scheduledAt: "2028-02-29T10:00:00Z" }]) {
    assert.equal((await call(args)).isError, true);
  }
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM tasks").get()?.n, 1);
  const entries = lines.map(line => JSON.parse(line));
  assert.equal(entries.filter(e => e.event === "tool.invoked" && e.tool === "create_reminder").length, 5);
  assert.deepEqual(entries.filter(e => e.event === "tool.validation").map(e => e.outcome),
    ["accepted", "rejected", "rejected", "rejected", "rejected"]);
  assert.ok(entries.some(e => e.reason === "invalid_arguments"));
  assert.ok(entries.some(e => e.reason === "invalid_reminder"));
  assert.ok(!lines.join("").includes("tea"));
});

test("configuration validates ranges, timezone, paths and LAN prerequisites", () => {
  const auth = { MCP_AUTH_TOKEN: randomUUID() };
  assert.throws(() => loadConfig({}), /MCP_AUTH_TOKEN/);
  const defaults = loadConfig(auth);
  assert.equal(defaults.host, "127.0.0.1");
  assert.equal(defaults.timezone, "UTC");
  for (const env of [{ SERVER_PORT: "65536" }, { POLL_INTERVAL_MS: "-1" },
    { DATABASE_PATH: "" }, { DEFAULT_TIMEZONE: "invalid" }, { LOG_LEVEL: "verbose" },
    { SERVER_HOST: "192.168.1.2" }, { MCP_AUTH_TOKEN: "short" }, { ALLOWED_ORIGINS: "*" }]) {
    assert.throws(() => loadConfig({ ...auth, ...env }));
  }
  const lan = { SERVER_HOST: "192.168.1.2", ...auth,
    TLS_CERT_PATH: "cert", TLS_KEY_PATH: "key", ALLOWED_ORIGINS: "https://client.example" };
  assert.equal(loadConfig(lan).host, lan.SERVER_HOST);
  for (const key of ["MCP_AUTH_TOKEN", "TLS_CERT_PATH", "TLS_KEY_PATH", "ALLOWED_ORIGINS"]) {
    assert.throws(() => loadConfig({ ...lan, [key]: "" }));
  }
});


test("only pending tasks can be cancelled and cancelled tasks cannot be claimed", t => {
  const f = fixture();
  t.after(() => f.db.close());
  const pending = f.create.execute("cancel this", later);
  assert.equal(f.tasks.cancelPending(pending.id), true);
  assert.equal(f.tasks.cancelPending(pending.id), false);
  assert.equal(f.row(pending.id).status, "cancelled");
  assert.equal(f.tasks.claimDue(epoch + 60_000), undefined);
  const running = f.create.execute("in progress", later);
  f.tasks.claimDue(epoch + 60_000);
  assert.equal(f.tasks.cancelPending(running.id), false);
});

test("logs link creation to its request and allowlist lifecycle metadata", async () => {
  const lines: string[] = [];
  const logger = new Logger("info", "America/Toronto", line => lines.push(line));
  const secret = "private-credential-or-payload";
  const taskId = randomUUID();
  const requestId = randomUUID();
  await logger.withRequest(requestId, async () => {
    await Promise.resolve();
    logMcpMessage(logger, { jsonrpc: "2.0", id: secret, method: "tools/call",
      params: { name: secret, arguments: { message: secret } } });
    logTaskEvent(logger, { kind: "task.created", taskId });
  });
  logTaskEvent(logger, { kind: "task.started", taskId });
  logTaskEvent(logger, { kind: "task.finished", taskId, outcome: { status: "completed", result: secret } });
  logTaskEvent(logger, { kind: "task.finished", taskId, outcome: { status: "failed", error: secret } });
  logTaskEvent(logger, { kind: "task.cancelled", taskId });
  logTaskEvent(logger, { kind: "task.interrupted", taskId });
  assert.ok(!lines.join("").includes(secret));
  const events = lines.map(line => JSON.parse(line));
  for (const event of events) assert.equal(new Date(event.time).toISOString(), event.time);
  const tasks = events.filter(e => e.taskId === taskId);
  assert.deepEqual(tasks.map(e => e.to), ["pending", "running", "completed", "failed", "cancelled", "failed"]);
  assert.equal(tasks[0].requestId, requestId);
  assert.ok(tasks.slice(1).every(e => e.requestId === undefined));
  assert.equal(tasks[3].level, "error");
  assert.equal(tasks[3].reason, "execution_failed");
});
