import { policyDigest } from "./mcp-execution-policy.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWeek4Execution } from "./week4-execution.mjs";
import { createMcpRepository } from "./mcp-repository.mjs";
import { createSessionMcpRoutes } from "./session-mcp-connections.mjs";
import { createBuiltInToolRegistry } from "../src/tool-runtime.ts";
import {
  buildManagerRequestBody,
  buildProviderToolNameMap,
  parseOpenAIResponses,
  parseOpenAIChatCompletions,
} from "../src/manager-llm-adapter.ts";

const shared = {
  name: "search/items?",
  description: "Search for an item.",
  inputSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      groups: {
        type: "array",
        minItems: 1,
        maxItems: 2,
        items: {
          type: "object",
          properties: {
            id: { type: "integer", minimum: 1 },
            mode: { enum: ["one", "two"] },
          },
          required: ["id", "mode"],
          additionalProperties: false,
        },
      },
    },
    required: ["groups"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: { items: { type: "array", items: { type: "string" } } },
  },
  annotations: { readOnlyHint: true, idempotentHint: true },
  _meta: { display: "test metadata" },
};
const args = { groups: [{ id: 2, mode: "one" }] };
function fixture(t, path = ":memory:") {
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE IF NOT EXISTS week3_sessions(id TEXT PRIMARY KEY,updatedAt INTEGER);
    CREATE TABLE IF NOT EXISTS week3_session_memory(sessionId TEXT,revision INTEGER);
    CREATE TABLE IF NOT EXISTS week3_history_events(sessionId TEXT,sequence INTEGER);
    CREATE TABLE IF NOT EXISTS invariant_audit_log(session_id TEXT,id INTEGER);`);
  const a = randomUUID(),
    b = randomUUID();
  db.prepare("INSERT INTO week3_sessions VALUES(?,1),(?,1)").run(a, b);
  const now = () => 40000;
  const repo = createMcpRepository(db, now);
  createSessionMcpRoutes(db);
  const foundation = createWeek4Execution(db, { now });
  let closed = false;
  const close = async () => {
    if (!closed) {
      closed = true;
      await foundation.service.drain();
      db.close();
    }
  };
  t.after(close);
  const registry = createBuiltInToolRegistry();
  function connect(docs = [shared]) {
    const id = randomUUID();
    const config = {
      name: id,
      description: "fixture",
      endpoint: "https://fixture.invalid/" + id,
      transport: "streamable-http",
      auth: { kind: "none" },
    };
    repo.save(id, config, null, undefined, true);
    repo.synchronize(id, 1, docs);
    return { id, config, token: repo.catalog(id).tools[0]?.toolId };
  }
  function start(
    session = a,
    provider = "openai",
    memory,
    customCurrent = () => true,
  ) {
    const run = foundation.begin(session, {
      turnId: randomUUID(),
      fingerprint: "fixture",
      provider,
    });
    run.within(() => run.bindTurnTools(registry, memory, customCurrent));
    return run;
  }
  const attach = (session, connection) =>
    db
      .prepare("INSERT INTO session_mcp_connections VALUES(?,?)")
      .run(session, connection);
  return {
    a,
    b,
    db,
    repo,
    registry,
    connect,
    start,
    attach,
    close,
    j: foundation.service.journal,
  };
}

function mcpTools(resolved) {
  return resolved.tools.filter((x) => x.kind === "mcp");
}
function dispatch(
  run,
  resolved,
  alias,
  parameters,
  inspect = () => {},
  before = () => {},
) {
  const intent = resolved.lookup(alias);
  assert.equal(intent.ok, true);
  const { id, connectionId, safety } = intent.data;
  return run.tool(
    {
      id: randomUUID(),
      call: { id: randomUUID(), toolId: id, arguments: parameters },
      connection: connectionId ?? id,
      safety,
      allowed: true,
      check: () => resolved.lookup(alias),
      async invoke(_signal, _key, correlation) {
        before();
        const routed = resolved.route(alias, parameters, correlation);
        inspect(routed, correlation);
        return routed.ok
          ? { ok: true, toolId: id, output: { total: 1 } }
          : { ok: false, toolId: id, error: routed.error };
      },
    },
    () => {},
  );
}

for (const provider of ["openai", "opencode-console", "opencode-go"]) {
  test(
    provider +
      " preserves nested constraints, supports unique aliases and routes the parsed call",
    async (t) => {
      const f = fixture(t),
        first = f.connect(),
        second = f.connect();
      f.attach(f.a, first.id);
      f.attach(f.a, second.id);
      const expected = "mcp_" + first.token.replaceAll("-", "");
      const tax = f.registry.get("builtin.tax_calculator");
      f.registry.register({ ...tax, id: expected });
      f.registry.register({ ...tax, id: "z".repeat(100) });
      const run = f.start(f.a, provider);
      await run.within(async () => {
        const resolved = run.resolveTools().data;
        assert.deepEqual(resolved.errors, []);
        const tools = mcpTools(resolved);
        assert.equal(tools.length, 2);
        assert.notEqual(tools[0].id, tools[1].id);
        const tool = tools.find((x) => x.connectionId === first.id);
        assert.equal(tool.originalName, shared.name);
        assert.equal(tool.source, "mcp");
        assert.deepEqual(tool.inputSchema, shared.inputSchema);
        assert.deepEqual(tool.outputSchema, shared.outputSchema);
        assert.deepEqual(tool.metadata, {
          annotations: shared.annotations,
          _meta: shared._meta,
        });
        assert.equal(resolved.providerNames.idToName.get(tool.id), expected);
        assert.notEqual(
          resolved.providerNames.idToName.get(expected),
          expected,
        );
        const map = buildProviderToolNameMap([...resolved.tools].reverse());
        assert.deepEqual(map.idToName, resolved.providerNames.idToName);
        const body = buildManagerRequestBody({
          providerId: provider,
          model: "fixture",
          messages: [],
          tools: resolved.tools,
          outputTokens: 200,
        });
        const wire = body.tools.map((x) => x.function ?? x);
        for (const x of wire) assert.match(x.name, /^[a-zA-Z0-9_-]{1,64}$/);
        assert.equal(new Set(wire.map((x) => x.name)).size, wire.length);
        const advertised = wire.find((x) => x.name === expected);
        assert.deepEqual(advertised.parameters, shared.inputSchema);
        assert.equal(
          advertised.strict,
          provider === "openai" ? false : undefined,
        );
        for (const privateValue of [
          first.id,
          first.config.endpoint,
          "readOnlyHint",
          "test metadata",
          "credential",
          "outputSchema",
          shared.name,
        ])
          assert.ok(!JSON.stringify(body.tools).includes(privateValue));
        const response =
          provider === "openai"
            ? parseOpenAIResponses(
                {
                  output: [
                    {
                      type: "function_call",
                      call_id: "p",
                      name: expected,
                      arguments: JSON.stringify(args),
                    },
                  ],
                },
                map,
              )
            : parseOpenAIChatCompletions(
                {
                  choices: [
                    {
                      message: {
                        tool_calls: [
                          {
                            id: "p",
                            function: {
                              name: expected,
                              arguments: JSON.stringify(args),
                            },
                          },
                        ],
                      },
                    },
                  ],
                },
                map,
              );
        const parsed = response.toolCalls[0];
        assert.equal(parsed.toolId, tool.id);
        assert.equal(
          resolved.lookup({
            ...parsed,
            toolId: tools.find((x) => x !== tool).id,
          }).ok,
          false,
        );
        await run.model(provider, async () => ({ text: "fixture" }));
        const [llm] = f.j.operations(run.ctx.id);
        let destination;
        const result = await dispatch(
          run,
          resolved,
          parsed,
          parsed.arguments,
          (r, c) => {
            assert.equal(r.ok, true);
            destination = r.data;
            assert.equal(destination.toolCallId, c.toolCallId);
            assert.equal(destination.attemptId, c.attemptId);
            assert.equal(destination.llmCallId, llm.id);
            assert.equal(resolved.route(expected, { groups: [] }, c).ok, false);
          },
        );
        assert.equal(result.outcome, "Success");
        assert.equal(destination.toolId, first.token);
        assert.equal(destination.connectionId, first.id);
        assert.equal(destination.originalName, shared.name);
        assert.equal(destination.safety, "side-effecting");
        assert.equal(destination.sessionId, f.a);
        assert.equal(destination.runId, run.ctx.id);
        assert.equal(destination.requestId, f.j.run(run.ctx.id).request_id);
        assert.deepEqual(destination.arguments, args);
        assert.equal(resolved.route(expected, args, destination).ok, false); // settled attempt
      });
    },
  );
}

test("partial resolution excludes incompatible, malformed, ambiguous and stale entries independently", (t) => {
  const f = fixture(t);
  const c = f.connect([
    shared,
    {
      ...shared,
      name: "reference",
      inputSchema: {
        type: "object",
        properties: { q: { $ref: "https://fixture.invalid/private" } },
      },
    },
    {
      ...shared,
      name: "pattern",
      inputSchema: {
        type: "object",
        properties: { q: { type: "string", pattern: "^(?=ok)ok$" } },
      },
    },
    { ...shared, name: "invalid", inputSchema: { type: "string" } },
  ]);
  const stale = f.connect();
  f.repo.fail(stale.id, 1, "permission");
  f.attach(f.a, c.id);
  f.attach(f.a, stale.id);
  const broken = f.connect([{ ...shared, name: "conflicting" }]);
  f.attach(f.a, broken.id);
  f.registry.register({
    ...f.registry.get("builtin.tax_calculator"),
    id: "mcp:" + broken.token,
  });
  const run = f.start();
  run.within(() => {
    const resolved = run.resolveTools().data;
    assert.deepEqual(
      mcpTools(resolved).map((x) => x.name),
      [shared.name],
    );
    assert.equal(
      resolved.tools.some((x) => x.id === "builtin.tax_calculator"),
      true,
    );
    assert.equal(
      resolved.tools.some((x) => x.id === "mcp:" + broken.token),
      false,
    );
    const errors = resolved.errors;
    assert.deepEqual(errors.map((e) => e.code).sort(), [
      "ambiguous_tool",
      "authorization",
      "invalid_definition",
      "unsupported_schema",
      "unsupported_schema",
    ]);
    assert.equal(
      errors.every((e) => !e.retryable && e.sessionId === f.a),
      true,
    );
    assert.equal(
      errors
        .filter((e) => e.code === "unsupported_schema")
        .every(
          (e) => e.source === "provider-adapter" && e.stage === "compatibility",
        ),
      true,
    );
    assert.ok(!JSON.stringify(errors).includes("fixture.invalid"));
    assert.equal(
      f.repo.catalog(c.id).tools.find((t) => t.originalName === "reference")
        .document.inputSchema.properties.q.$ref,
      "https://fixture.invalid/private",
    );
  });
});

test("internal eligibility, empty selections, isolated sessions, memory restrictions and expired scopes", async (t) => {
  const f = fixture(t),
    c = f.connect();
  f.attach(f.a, c.id);
  const memory = { usesSelectedRecordsOnly: false };
  const run = f.start(f.a, "openai", memory),
    other = f.start(f.b);
  assert.equal(run.resolveTools().ok, false);
  let snapshot;
  await run.within(async () => {
    snapshot = run.resolveTools().data;
    const alias = snapshot.providerNames.idToName.get("mcp:" + c.token);
    assert.equal(snapshot.lookup("get_fact_history").ok, true);
    assert.equal(snapshot.lookup(c.token).ok, false);
    assert.equal(snapshot.lookup("mcp:" + c.token).ok, false);
    assert.equal(snapshot.lookup(shared.name).ok, false);
    other.within(() => {
      const r = other.resolveTools().data;
      assert.deepEqual(mcpTools(r), []);
      assert.equal(snapshot.lookup(alias).error.code, "authorization");
      assert.equal(r.lookup(alias).error.code, "unknown_tool");
      assert.equal(r.lookup("get_fact_history").ok, false);
    });
    assert.ok(snapshot.tools.every((x) => x.executionType !== "library"));
    assert.equal(
      (
        await dispatch(
          run,
          snapshot,
          "builtin_tax_calculator",
          { amount: 2, taxRate: 5 },
          (r) => {
            assert.equal(r.data.source, "internal");
            assert.deepEqual(r.data.arguments, { amount: 2, taxRate: 5 });
          },
        )
      ).outcome,
      "Success",
    );
    memory.usesSelectedRecordsOnly = true;
    assert.deepEqual(run.resolveTools().data.tools, []);
    assert.equal(snapshot.lookup(alias).error.code, "authorization");
    assert.equal(snapshot.lookup("builtin_tax_calculator").ok, false);
    memory.usesSelectedRecordsOnly = false;
    run.committed();
    assert.equal(snapshot.lookup(alias).ok, false);
  });
});

test("invalid nested arguments produce known, non-retryable router errors in the journal", async (t) => {
  const f = fixture(t),
    c = f.connect();
  f.attach(f.a, c.id);
  const run = f.start();
  await run.within(async () => {
    const r = run.resolveTools().data,
      alias = r.providerNames.idToName.get("mcp:" + c.token);
    // Mutating an exported descriptor or alias table cannot change the private mapping or validator.
    mcpTools(r)[0].inputSchema.properties = {};
    r.providerNames.idToName.set("mcp:" + c.token, "spoof");
    for (const bad of [
      {},
      { groups: [] },
      { groups: [{ id: 0, mode: "one" }] },
      { groups: [{ id: 1, mode: "other" }] },
      { groups: [{ id: 1, mode: "one", extra: 1 }] },
      { groups: [{ id: 1.25, mode: "two" }] },
      { groups: [{ id: 1 }] },
    ]) {
      const result = await dispatch(run, r, alias, bad);
      assert.equal(result.ok, false);
      assert.equal(result.outcome, "Failed");
      const err = JSON.parse(f.j.op(result.logicalCallId).error);
      assert.equal(err.source, "router");
      assert.equal(err.stage, "validation");
      assert.equal(err.code, "invalid_arguments");
      assert.equal(err.retryable, false);
      assert.equal(err.certainty, "known");
      assert.equal(f.j.attempts(result.logicalCallId).length, 1);
    }
    assert.equal(r.lookup("spoof").error.code, "unknown_tool");
  });
});

for (const action of [
  "detach",
  "remove tool",
  "delete connection",
  "start deletion",
  "change definition",
  "invalidate catalog",
]) {
  test(
    "dispatch rechecks authorization and exact discovery document after " +
      action,
    async (t) => {
      const f = fixture(t),
        c = f.connect(),
        d = f.connect();
      f.attach(f.a, c.id);
      f.attach(f.a, d.id);
      const run = f.start();
      await run.within(async () => {
        const r = run.resolveTools().data;
        const result = await dispatch(
          run,
          r,
          r.providerNames.idToName.get("mcp:" + c.token),
          args,
          () => {},
          () => {
            if (action === "detach")
              f.db
                .prepare(
                  "DELETE FROM session_mcp_connections WHERE session_id=? AND connection_id=?",
                )
                .run(f.a, c.id);
            if (action === "remove tool") f.repo.synchronize(c.id, 1, []);
            if (action === "delete connection" || action === "start deletion")
              f.repo.markDeleting(c.id, 1);
            if (action === "delete connection") f.repo.finishDeletion(c.id);
            if (action === "change definition")
              f.repo.synchronize(c.id, 1, [
                { ...shared, description: "Changed." },
              ]);
            if (action === "invalidate catalog")
              f.repo.fail(c.id, 1, "authentication");
          },
        );
        assert.equal(result.ok, false);
        assert.equal(
          result.error.code,
          action === "invalidate catalog"
            ? "authentication"
            : action === "change definition"
              ? "route_changed"
              : "authorization",
        );
        assert.equal(result.error.stage, "routing");
        assert.equal(result.error.source, "router");
        assert.equal(
          r.lookup(r.providerNames.idToName.get("mcp:" + d.token)).ok,
          true,
        );
      });
    },
  );
}

test("connection rename, catalog rediscovery and SQLite reopen preserve UUID mappings", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "day18-routing-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "fixture.sqlite");
  const f = fixture(t, path),
    c = f.connect();
  f.attach(f.a, c.id);
  const run = f.start();
  const original = run.within(
    () => run.resolveTools().data.providerNames.idToName,
  );
  f.repo.save(c.id, { ...c.config, name: "Renamed" }, null, 1, false);
  f.repo.synchronize(c.id, 2, [shared]);
  run.within(() => run.committed());
  await f.close();
  const fresh = fixture(t, path),
    next = fresh.start(f.a);
  next.within(() => {
    const snapshot = next.resolveTools().data;
    assert.deepEqual(original, snapshot.providerNames.idToName);
    assert.equal(mcpTools(snapshot)[0].connectionId, c.id);
    assert.equal(mcpTools(snapshot)[0].toolId, c.token);
  });
});

test("the pre-dispatch and cached authorization gates preserve structured access errors", async (t) => {
  const f = fixture(t),
    c = f.connect();
  f.attach(f.a, c.id);
  const run = f.start();
  await run.within(async () => {
    const r = run.resolveTools().data;
    const alias = r.providerNames.idToName.get("mcp:" + c.token);
    const send = (parameters) =>
      run.tool(
        {
          id: randomUUID(),
          call: {
            id: randomUUID(),
            toolId: "mcp:" + c.token,
            arguments: parameters,
          },
          safety: "side-effecting",
          allowed: true,
          connection: c.id,
          check: () => r.lookup(alias),
          invoke: async () =>
            assert.fail("a revoked route must never reach the destination"),
        },
        () => {},
      );
    assert.equal((await dispatch(run, r, alias, args)).ok, true);
    f.repo.fail(c.id, 1, "permission");
    const replay = await send(args);
    assert.equal(replay.ok, false);
    assert.equal(replay.error.source, "router");
    const fresh = await send({ groups: [{ id: 3, mode: "one" }] });
    assert.equal(fresh.error.source, "router");
    assert.equal(fresh.error.code, "authorization");
    assert.equal(f.j.attempts(fresh.logicalCallId).length, 0);
  });
});

test("an MCP annotation cannot authorize an operation journaled as read-only", async (t) => {
  const f = fixture(t),
    c = f.connect();
  f.attach(f.a, c.id);
  const run = f.start();
  await run.within(async () => {
    const registry = run.resolveTools().data,
      id = "mcp:" + c.token;
    const alias = registry.providerNames.idToName.get(id);
    const result = await run.tool(
      {
        id: randomUUID(),
        call: { id: randomUUID(), toolId: id, arguments: args },
        connection: c.id,
        safety: "read-only",
        allowed: true,
        check: () => registry.lookup(alias),
        async invoke(_signal, _key, correlation) {
          const denied = registry.route(alias, args, correlation);
          assert.equal(denied.ok, false);
          return { ok: false, toolId: id, error: denied.error };
        },
      },
      () => {},
    );
    assert.equal(result.error.code, "authorization");
    assert.equal(f.j.attempts(result.logicalCallId).length, 1);
  });
});

test("scoped internal-only provider parsing preserves the authorized alias and rechecks custom eligibility", (t) => {
  const f = fixture(t),
    tax = f.registry.get("builtin.tax_calculator");
  let enabled = true;
  f.registry.replaceCustomTools([{ ...tax, id: "custom.test" }]);
  const run = f.start(f.b, "openai", undefined, () => enabled);
  run.within(() => {
    const r = run.resolveTools().data;
    const parse = (name) =>
      parseOpenAIResponses(
        {
          output: [
            { type: "function_call", call_id: "one", name, arguments: "{}" },
          ],
        },
        r.providerNames,
      ).toolCalls[0];
    assert.equal(r.lookup(parse("custom_test")).data.id, "custom.test");
    assert.equal(r.lookup(parse("custom.test")).error.code, "unknown_tool");
    enabled = false;
    assert.equal(r.lookup(parse("custom_test")).error.code, "authorization");
    assert.equal(
      run.resolveTools().data.tools.some((tool) => tool.id === "custom.test"),
      false,
    );
  });
});

test("MCP recovery rechecks the pinned tuple and authorization after restart and preserves consumed attempts", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "d18-mcp-recovery-")),
    path = join(dir, "recovery.sqlite");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const f = fixture(t, path),
    peer = f.connect();
  f.db.exec("CREATE TABLE session_invariants(session_id TEXT,enabled INTEGER)");
  f.attach(f.a, peer.id);
  const policy = [],
    ops = [];
  const target = "mcp:" + peer.token;
  let now = 40000;
  const recorded = [];
  const manager = {
    execute: async (dest, _signal, current) => {
      assert.ok(current());
      recorded.push([
        dest.toolCallId,
        dest.attemptId,
        dest.arguments.groups[0].id,
      ]);
      return {
        ok: true,
        output: { content: [{ type: "text", text: "read" }] },
      };
    },
  };
  const options = {
    now: () => now,
    leaseMs: 1000,
    wait: async (ms) => {
      now += ms;
    },
    random: () => 0,
    readMcpPolicy: () => policy,
    mcpManager: manager,
  };
  const original = createWeek4Execution(f.db, options);
  const id = randomUUID(),
    { ctx } = original.begin(f.a, {
      turnId: id,
      fingerprint: "fixture",
      provider: "openai",
    });
  for (const [idx, state] of [
    "WaitingForRetry",
    "Running",
    "Running",
    "Success",
    "Running",
  ].entries()) {
    const params = { groups: [{ id: idx + 1, mode: "one" }] },
      safety = idx === 4 ? "side-effecting" : "read-only";
    const grant = {
      sessionId: f.a,
      connectionId: peer.id,
      toolId: peer.token,
      definition: policyDigest(shared),
      revision: 1,
      safety,
      arguments: params,
    };
    policy.push(grant);
    const op = await original.service.register(ctx, {
      id: randomUUID(),
      kind: "tool",
      target,
      key: policyDigest([target, params]),
      safety,
      connection: peer.id,
      args: params,
      grantId: policyDigest(grant),
    });
    ops.push(op.id);
    original.service.journal.transaction(() => {
      original.service.journal.moveOp(op.id, "Running");
      f.db
        .prepare("INSERT INTO week4_attempts VALUES(?,?,1,?,?,?,NULL)")
        .run(
          randomUUID(),
          op.id,
          now,
          state === "Running" ? null : now,
          state === "WaitingForRetry" ? "Failed" : state,
        );
      if (state !== "Running")
        original.service.journal.moveOp(
          op.id,
          state,
          null,
          null,
          state === "WaitingForRetry" ? 42000 : null,
        );
    });
  }
  policy.splice(2, 1); // authorization revoked during downtime
  await original.service.drain();
  await f.close();
  now = 41500;
  const next = new DatabaseSync(path);
  const recovered = createWeek4Execution(next, options).service;
  try {
    await recovered.active.get(id)?.recovery;
    assert.deepEqual(
      ops.map((op) => recovered.journal.op(op).state),
      ["Success", "Success", "Failed", "Success", "Unknown"],
    );
    assert.deepEqual(
      recorded.map(([op, , value]) => [op, value]),
      [
        [ops[0], 1],
        [ops[1], 2],
      ],
    );
    assert.equal(now, 42000);
    for (const [op, attempt] of recorded) {
      const tries = recovered.journal.attempts(op);
      assert.equal(tries.length, 2);
      assert.equal(tries[1].id, attempt);
    }
    assert.equal(recovered.journal.run(id).state, "RequiresReview");
    assert.equal(
      next.prepare("PRAGMA integrity_check").get().integrity_check,
      "ok",
    );
  } finally {
    await recovered.drain();
    next.close();
  }
});

test("restart resumes a dependent read only with its recorded successful call in the same run", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "d18-parent-call-"));
  const path = join(dir, "fixture.sqlite");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const f = fixture(t, path);
  f.db.exec("CREATE TABLE session_invariants(session_id TEXT,enabled INTEGER)");
  const peer = f.connect();
  f.attach(f.a, peer.id);
  const policy = [];
  function grant(value, requires = []) {
    const entry = {
      sessionId: f.a, connectionId: peer.id, toolId: peer.token,
      definition: policyDigest(shared), revision: 1, safety: "read-only",
      arguments: { groups: [{ id: value, mode: "one" }] }, requires,
    };
    policy.push(entry);
    return entry;
  }
  let now = 40000;
  const dispatched = [];
  const options = {
    now: () => now, leaseMs: 1000, readMcpPolicy: () => policy,
    mcpManager: { async execute(dest, _signal, check) {
      assert.ok(check());
      dispatched.push(dest.toolCallId);
      return { ok: true, output: { content: [] } };
    } },
  };
  const original = createWeek4Execution(f.db, options);
  const begin = () => original.begin(f.a, {
    turnId: randomUUID(), fingerprint: "fixture", provider: "openai",
  });
  const register = async (run, entry, prerequisites) => {
    const target = "mcp:" + peer.token;
    const op = await original.service.register(run.ctx, {
      id: randomUUID(), kind: "tool", target, key: policyDigest([target, entry.arguments]),
      safety: entry.safety, connection: peer.id, args: entry.arguments, grantId: policyDigest(entry),
      display: { prerequisites },
    });
    return op.id;
  };
  const verification = grant(1);
  const verify = async (run) => {
    const id = await register(run, verification, []);
    original.service.journal.moveOp(id, "Running");
    original.service.journal.moveOp(id, "Success");
    return id;
  };
  const prior = begin();
  const staleId = await verify(prior);
  prior.committed();
  const current = begin();
  const currentId = await verify(current);
  const requires = [policyDigest(verification)];
  // Legacy rows may point outside this run or lack a binding. Neither may
  // substitute the successful verification that also exists in this run.
  const stale = await register(current, grant(2, requires), [staleId]);
  const missing = await register(current, grant(3, requires), []);
  const valid = await register(current, grant(4, requires), [currentId]);
  await original.service.drain();
  await f.close();
  now += 1500;
  const reopened = new DatabaseSync(path);
  const recovered = createWeek4Execution(reopened, options).service;
  try {
    await recovered.active.get(current.ctx.id)?.recovery;
    assert.deepEqual([stale, missing, valid].map((id) => recovered.journal.op(id).state),
      ["Skipped", "Skipped", "Success"]);
    assert.deepEqual(dispatched, [valid]);
  } finally {
    await recovered.drain();
    reopened.close();
  }
});
