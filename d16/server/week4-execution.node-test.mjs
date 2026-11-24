import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createMcpRepository } from "./mcp-repository.mjs";
import { McpProblem } from "./mcp-configuration.mjs";
import {
  ExecutionService,
  OperationFailure,
  hasCompleteArguments,
} from "./execution-service.mjs";
import {
  assertTransition,
  executionError,
  retryAfterMs,
  safeToolObservation,
} from "../src/execution-policy.ts";
import { createSessionServer } from "./sessions.mjs";
import { createDevManagerMock } from "../src/dev-manager-mock.ts";

function fixture(t, options = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE week3_sessions(id TEXT PRIMARY KEY); INSERT INTO week3_sessions VALUES('session')",
  );
  let now = 10000;
  const waits = [];
  const service = new ExecutionService(db, {
    now: () => now,
    random: () => 0,
    wait: async (ms) => {
      waits.push(ms);
      now += ms;
    },
    ...options,
  });
  const ctx = service.begin("session", {
    turnId: randomUUID(),
    fingerprint: "fixture",
  });
  t.after(async () => {
    await service.drain();
    db.close();
  });
  const tool = (invoke, extra = {}) =>
    service.tool(ctx, {
      id: randomUUID(),
      call: { id: randomUUID(), toolId: "fixture", arguments: { amount: 2 } },
      safety: "read-only",
      check: () => true,
      allowed: true,
      invoke,
      ...extra,
    });
  return { db, service, ctx, tool, waits, j: service.journal };
}
const success = async () => ({
  ok: true,
  toolId: "fixture",
  output: { total: 4 },
});
const fail = (code) => ({
  ok: false,
  toolId: "fixture",
  error: { code, message: "synthetic-private-value" },
});

test("skips remain informational when the exact operation later succeeds", async t => {
  for (const [amount,connection,expected] of [[2,"first","Completed"],[3,"first","PartialSuccess"],[2,"other","PartialSuccess"]]) {
    const {ctx,service,tool,j} = fixture(t);
    const skipped = await tool(() => assert.fail("Skipped call was dispatched"), {
      connection:"first", skip:true, skipReason:"prerequisite_missing",
    });
    await tool(success,{connection,call:{id:randomUUID(),toolId:"fixture",arguments:{amount}}});
    assert.equal(service.finish(ctx,"delivered"),expected);
    assert.equal(j.stats(ctx.id).attempts,1);
    assert.deepEqual(j.stats(ctx.id).tools,{Success:1,Skipped:1});
    assert.equal(j.attempts(skipped.logicalCallId).length,0);
    assert.equal(JSON.parse(j.op(skipped.logicalCallId).error).skipReason,"prerequisite_missing");
  }
});

test("terminal states cannot dispatch; interrupted and waiting have explicit transitions", () => {
  assertTransition("run", "Interrupted", "Running");
  assertTransition("call", "WaitingForRetry", "Running");
  for (const end of [
    "Completed",
    "PartialSuccess",
    "RequiresReview",
    "Failed",
    "Cancelled",
  ])
    assert.throws(() => assertTransition("run", end, "Running"));
  for (const end of ["Success", "Failed", "Unknown", "Skipped", "Cancelled"])
    assert.throws(() => assertTransition("call", end, "Running"));
  assert.throws(() => assertTransition("call", "Pending", "Success"));
  assert.equal(
    executionError("protocol", "mcp", "response", 7).retryable,
    false,
  );
});

test("intent precedes dispatch; receipts separate attempts and calls and omit sensitive data", async (t) => {
  const { ctx, db, service, tool, waits, j } = fixture(t);
  await service.model(ctx, "fixture", async () => ({
    text: "synthetic-private-value",
  }));
  let calls = 0;
  const args = { amount: 2, authorization: "synthetic-private-value" };
  const call = { id: "p1", toolId: "fixture", arguments: args };
  const invoke = async () => {
    const row = j.operations(ctx.id).at(-1);
    assert.equal(row.state, "Running");
    assert.equal(j.attempts(row.id).at(-1).state, "Running");
    if (++calls === 1)
      return {
        ...fail("rate_limit"),
        error: { code: "rate_limit", retryAfterMs: 6000 },
      };
    return {
      ok: true,
      toolId: "fixture",
      output: { total: 4, notes: "synthetic-private-value" },
    };
  };
  assert.equal((await tool(invoke, { call })).ok, true);
  assert.equal((await tool(invoke, { call: { ...call, id: "p2" } })).ok, true);
  assert.equal(calls, 2);
  assert.deepEqual(waits, [6000]);
  const [model, op] = j.operations(ctx.id);
  assert.equal(op.parent_llm_id, model.id);
  assert.equal(j.run(ctx.id).request_id, ctx.id);
  assert.equal(new Set(j.attempts(op.id).map((a) => a.id)).size, 2);
  assert.equal(j.stats(ctx.id).retries, 1);
  assert.equal(j.stats(ctx.id).tools.Success, 1);
  assert.deepEqual(JSON.parse(op.arguments), { amount: 2 });
  assert.deepEqual(JSON.parse(op.result), { total: 4 });
  for (const table of [
    "week4_runs",
    "week4_attempts",
    "week4_operations",
    "week4_checkpoints",
  ])
    assert.ok(
      !JSON.stringify(db.prepare("SELECT * FROM " + table).all()).includes(
        "synthetic-private-value",
      ),
    );
});

test("exponential backoff exhausts the original budget; repeating a model call cannot replenish it", async (t) => {
  const { ctx, service, waits, j } = fixture(t);
  let requests = 0;
  const send = async () => {
    requests++;
    return { status: 503, body: {} };
  };
  for (let i = 0; i < 2; i++)
    assert.equal(
      (await service.transport(ctx, "fixture", { model: "m" }, send)).status,
      503,
    );
  assert.equal(requests, 3);
  assert.deepEqual(waits, [2000, 4000]);
  assert.equal(j.operations(ctx.id).length, 1);
  assert.equal(j.attempts(j.operations(ctx.id)[0].id).length, 3);
  assert.equal(retryAfterMs("7", 0), 7000);
  assert.equal(retryAfterMs("Thu, 01 Jan 1970 00:00:08 GMT", 1000), 7000);
});

test("Retry-After beyond the deadline terminates without another attempt", async (t) => {
  const { ctx, service, waits, j } = fixture(t, {
    policy: { deadlineMs: 5000 },
  });
  const r = await service.transport(ctx, "fixture", {}, async () => ({
    status: 429,
    retryAfterMs: 6000,
    body: {},
  }));
  assert.equal(r.status, 429);
  assert.deepEqual(waits, []);
  assert.equal(j.operations(ctx.id)[0].state, "Failed");
});

test("authorization, validation, unknown tools and provider refusals do not retry", async (t) => {
  const { ctx, service, tool, waits, j } = fixture(t);
  for (const code of [
    "invalid_arguments",
    "authorization",
    "schema",
    "unknown_tool",
    "authentication",
  ]) {
    const result = await tool(async () => fail(code), {
      call: { id: code, toolId: "fixture", arguments: { id: code } },
    });
    assert.equal(result.error.code, code);
    assert.equal(result.error.retryable, false);
  }
  await assert.rejects(
    service.transport(ctx, "fixture", {}, async () => ({
      status: 200,
      body: { choices: [{ message: { refusal: "private" } }] },
    })),
    { code: "refusal" },
  );
  assert.equal(j.operations(ctx.id).at(-1).state, "Failed");
  assert.deepEqual(waits, []);
});

test("timeout after dispatch leaves a potentially mutating operation unknown and releases resources", async (t) => {
  const { ctx, service, tool, j } = fixture(t, { policy: { timeoutMs: 10 } });
  let calls = 0;
  const op = (signal) =>
    new Promise((_, reject) => {
      calls++;
      signal.addEventListener(
        "abort",
        () => reject(new OperationFailure("timeout")),
        { once: true },
      );
    });
  const result = await tool(op, { safety: "side-effecting" });
  assert.equal(result.error.certainty, "unknown");
  assert.equal(j.operations(ctx.id)[0].state, "Unknown");
  await tool(op, { safety: "side-effecting" });
  assert.equal(calls, 1);
  assert.equal(service.permits.size, 0);
  assert.equal(
    j.transaction(() => service.finish(ctx, "failed")),
    "RequiresReview",
  );
});

test("bounded concurrency is shared by distinct operations on one connection; cancellation releases the permit", async (t) => {
  const { ctx, service, tool, j } = fixture(t, { policy: { concurrency: 1 } });
  const ready = Promise.withResolvers();
  const first = tool(
    (signal) =>
      new Promise((_, reject) => {
        ready.resolve();
        signal.addEventListener(
          "abort",
          () => reject(new OperationFailure("cancelled")),
          { once: true },
        );
      }),
    { connection: "shared" },
  );
  await ready.promise;
  const second = await tool(success, {
    connection: "shared",
    call: { id: "other", toolId: "other", arguments: {} },
  });
  assert.equal(second.error.code, "capacity");
  ctx.controller.abort();
  assert.equal((await first).error.code, "cancelled");
  assert.equal(j.stats(ctx.id).attempts, 1);
  assert.equal(service.permits.size, 0);
});

test("collector acknowledges once after commit; rejects overflow, mismatched duplicates and persistence failure", async (t) => {
  const events = [];
  const { ctx, db, tool, j } = fixture(t, {
    capacity: 1,
    publish: (e) => events.push(e),
  });
  const event = { id: "e1", runId: ctx.id, event: "checked" };
  let changes = 0;
  const ack = j.send(event, () => changes++);
  await assert.rejects(
    j.send({ ...event, id: "e2" }, () => {}),
    /capacity/,
  );
  assert.ok(await ack);
  assert.equal(await j.send(event, () => changes++), false);
  assert.equal(events.length, 1);
  assert.equal(changes, 1);
  await assert.rejects(
    j.send({ ...event, event: "other" }, () => {}),
    /Conflicting/,
  );
  db.exec(
    "CREATE TRIGGER unavailable BEFORE INSERT ON week4_attempts BEGIN SELECT RAISE(ABORT,'fixture'); END",
  );
  let dispatched = false;
  await assert.rejects(
    tool(async () => {
      dispatched = true;
      return success();
    }),
  );
  assert.equal(dispatched, false);
  assert.equal(j.operations(ctx.id)[0].state, "Pending");
  assert.equal(
    events.some((e) => e.event === "dispatch"),
    false,
  );
});

test("restart fences prior owners, restores wait and budgets, preserves success, and quarantines uncertain side effects", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "d16-restart-")),
    path = join(dir, "db.sqlite");
  let now = 0;
  const db = new DatabaseSync(path);
  db.exec(
    "CREATE TABLE week3_sessions(id TEXT PRIMARY KEY); INSERT INTO week3_sessions VALUES('s')",
  );
  const options = {
    now: () => now,
    leaseMs: 1000,
    policy: { maxAttempts: 2 },
    random: () => 0,
  };
  const old = new ExecutionService(db, options),
    ctx = old.begin("s", { turnId: "r", fingerprint: "f" });
  const safe = await old.register(ctx, {
    id: "safe",
    kind: "tool",
    target: "t",
    key: "k",
    safety: "read-only",
    args: { amount: 4 },
  });
  const unsafe = await old.register(ctx, {
    id: "unsafe",
    kind: "tool",
    target: "u",
    key: "j",
    safety: "side-effecting",
  });
  const done = await old.register(ctx, {
    id: "done",
    kind: "tool",
    target: "d",
    key: "d",
    safety: "read-only",
  });
  await old.attempt(
    ctx,
    done,
    async () => ({ total: 4 }),
    () => true,
  );
  old.journal.transaction(() => {
    for (const op of [safe, unsafe]) {
      old.journal.moveOp(op.id, "Running");
      db.prepare("INSERT INTO week4_attempts VALUES(?,?,1,0,?,?,NULL)").run(
        op.id + "-1",
        op.id,
        op === safe ? 10 : null,
        op === safe ? "Failed" : "Running",
      );
    }
    old.journal.moveOp("safe", "WaitingForRetry", null, null, 1500);
  });
  await old.drain();
  db.close();
  const next = new DatabaseSync(path),
    other = new DatabaseSync(path);
  const fired = [];
  const recovery = {
    ...options,
    wait: async (ms) => {
      now += ms;
    },
    recoverTool: (run, op) => ({
      authorize: () => run.session_id === "s",
      invoke: async () => {
        fired.push(op.id);
        return { total: 8 };
      },
    }),
  };
  const live = new ExecutionService(next, recovery),
    competitor = new ExecutionService(other, recovery);
  t.after(async () => {
    await live.drain();
    await competitor.drain();
    next.close();
    other.close();
    rmSync(dir, { recursive: true, force: true });
  });
  assert.equal(live.active.size, 0);
  now = 1100;
  live.tick();
  competitor.tick();
  assert.equal(competitor.active.size, 0);
  await live.active.get("r").recovery;
  assert.equal(now, 1500);
  assert.deepEqual(fired, ["safe"]);
  assert.equal(live.journal.attempts("safe").length, 2);
  assert.equal(live.journal.op("done").state, "Success");
  assert.equal(live.journal.op("unsafe").state, "Unknown");
  assert.equal(live.journal.run("r").state, "RequiresReview");
  assert.equal(
    next.prepare("PRAGMA integrity_check").get().integrity_check,
    "ok",
  );
});

test("idempotent transient errors keep one key and each attempt has its own identity", async (t) => {
  const { ctx, tool, j } = fixture(t);
  const keys = [];
  const call = { id: "remote-1", toolId: "fixture", arguments: { amount: 4 } };
  const invoke = async (_signal, key) => {
    keys.push(key);
    return keys.length === 1 ? fail("connection") : success();
  };
  const [a, b] = await Promise.all([
    tool(invoke, { call, safety: "idempotent" }),
    tool(invoke, { call, safety: "idempotent" }),
  ]);
  assert.equal(a.ok, true);
  assert.equal(a.logicalCallId, b.logicalCallId);
  assert.deepEqual(keys, [a.logicalCallId, a.logicalCallId]);
  assert.equal(j.attempts(a.logicalCallId).length, 2);
  assert.equal(hasCompleteArguments(j.op(a.logicalCallId)), true);
  const modified = { ...call, arguments: { amount: 8 } };
  await assert.rejects(tool(invoke, { call: modified, safety: "idempotent" }), {
    code: "protocol",
  });
  assert.equal(j.stats(ctx.id).tools.Success, 1);
});

test("recovery requires an exact safe projection and private turns retain only outcomes", async (t) => {
  const { ctx, tool, j } = fixture(t);
  const a = await tool(success, {
    call: {
      id: "a",
      toolId: "fixture",
      arguments: { amount: 2, secret: "placeholder" },
    },
  });
  assert.equal(hasCompleteArguments(j.op(a.logicalCallId)), false);
  ctx.privatePayloads = true;
  const b = await tool(success, {
    call: { id: "b", toolId: "fixture", arguments: { amount: 3 } },
  });
  assert.equal(hasCompleteArguments(j.op(b.logicalCallId)), false);
  assert.equal(JSON.parse(j.op(b.logicalCallId).arguments), null);
  assert.equal(j.op(b.logicalCallId).result, null);
});

test("invalid tool results fail validation; safe history views scrub credentials before display and model continuation", async (t) => {
  const { tool } = fixture(t);
  const result = await tool(async () => ({
    ok: true,
    output: { total: Infinity },
  }));
  assert.equal(result.error.code, "schema");
  assert.equal(result.outcome, "Failed");
  const view = safeToolObservation({
    amount: 4,
    headers: { Authorization: "synthetic-secret" },
    nested: [
      "Bearer synthetic-secret",
      "https://example.invalid/?userToken=synthetic-secret",
    ],
  });
  assert.ok(!JSON.stringify(view).includes("synthetic-secret"));
  assert.equal(view.amount, 4);
});

test("MCP classifications use the same safe error contract without executing tools", () => {
  for (const [reason, category] of [
    ["authentication", "access"],
    ["permission", "access"],
    ["protocol", "protocol"],
    ["transport", "connection"],
    ["timeout", "timeout"],
  ]) {
    const error = new McpProblem(reason).toExecutionError("dispatch", 42);
    assert.equal(error.source, "mcp");
    assert.equal(error.category, category);
    assert.equal(error.retryable, reason === "timeout");
  }
  assert.equal(
    executionError("execution_error", "mcp", "response", 42).category,
    "execution",
  );
});

test("real Week 4 HTTP turn records independent operations; Week 3 never enters the journal", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "d16-turn-")),
    path = join(dir, "db.sqlite");
  const mock = createDevManagerMock("fixture");
  let answers = 0,
    endWithFailure = false;
  const serverOptions = {
    invariantAdapter: () => ({
      ...mock,
      complete: async (args) => {
        assert.ok((args.tools ?? []).every(tool => tool.kind !== "mcp"));
        if (args.memoryProposal) return mock.complete(args);
        if (args.messages.at(-1)?.role === "tool") {
          if (endWithFailure) throw new OperationFailure("refusal");
          return { text: "Finished." };
        }
        answers++;
        return {
          toolCalls: [1, 2, 3, 4, 5, 6]
            .map((n) => ({
              id: "c" + n,
              toolId: "builtin.tax_calculator",
              arguments: { amount: n, taxRate: n === 2 ? "invalid" : 5 },
            }))
            .concat([
              {
                id: "dependent",
                toolId: "builtin.tax_calculator",
                arguments: { amount: 7, taxRate: 5 },
                dependsOn: ["c2"],
              },
            ]),
        };
      },
    }),
  };
  let server = createSessionServer(path, serverOptions);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const db = new DatabaseSync(path);
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const api = async (path, body) =>
    fetch("http://127.0.0.1:" + server.address().port + "/api/" + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const { id } = await (await api("week3/sessions", {})).json();
  const repo = createMcpRepository(db);
  const plugin = randomUUID();
  repo.save(plugin,{name:"fixture",description:"",endpoint:"https://fixture.invalid/catalog",
    transport:"streamable-http",auth:{kind:"none"}},null,undefined,true);
  repo.synchronize(plugin,1,[{name:"detached_from_manager",inputSchema:{type:"object"}}]);
  db.prepare("INSERT INTO session_mcp_connections VALUES(?,?)").run(id,plugin);
  const input = {
    question: "Calculate totals.",
    model: "fixture",
    provider: "openai",
    turnId: randomUUID(),
    execute: true,
  };
  const turn = (week, value) =>
    api(week + "/sessions/" + id + "/invariant-turn", value);
  assert.equal((await turn("week4", input)).status, 200);
  const state = () =>
    db
      .prepare("SELECT state,answer FROM week4_runs WHERE id=?")
      .get(input.turnId);
  assert.equal(state().state, "PartialSuccess");
  assert.equal(state().answer, "delivered");
  const tools = () =>
    db
      .prepare(
        "SELECT state FROM week4_operations WHERE kind='tool' AND run_id=? ORDER BY rowid",
      )
      .all(input.turnId)
      .map((r) => r.state);
  assert.deepEqual(tools(), [
    "Success",
    "Failed",
    "Success",
    "Success",
    "Success",
    "Success",
    "Skipped",
  ]);
  assert.equal((await turn("week4", input)).status, 200);
  assert.equal(answers, 1);
  assert.equal(
    (await turn("week3", { ...input, turnId: randomUUID() })).status,
    200,
  );
  assert.equal(db.prepare("SELECT count(*) AS n FROM week4_runs").get().n, 1);
  input.turnId = randomUUID();
  endWithFailure = true;
  assert.equal((await turn("week4", input)).status, 503);
  assert.equal(state().state, "PartialSuccess");
  assert.equal(state().answer, "refused");
  assert.equal(tools().filter((state) => state === "Success").length, 5);
  await new Promise((resolve) => server.close(resolve));
  server = createSessionServer(path, serverOptions);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const previousAnswers = answers;
  assert.equal((await turn("week4", input)).status, 409);
  assert.equal(answers, previousAnswers);
  assert.equal(state().answer, "refused");
  assert.equal(tools().filter((s) => s === "Success").length, 5);
  assert.equal(
    db
      .prepare(
        "SELECT count(*) AS n FROM week3_history_events WHERE json_extract(payload,'$.runId')=?",
      )
      .get(input.turnId).n,
    0,
  );
});
