import { randomUUID } from "node:crypto";
import { invocationGrantId, policyDigest, readGrants } from "./mcp-execution-policy.mjs";
import { createDevManagerMock } from "../src/dev-manager-mock.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { remote, start, stop, token, tool } from "./test-fixtures/mcp-peer.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createSessionServer } from "./sessions.mjs";
import { discoverCatalog } from "./mcp-discovery.mjs";
import { authenticatedFetch, endpointUrl } from "./mcp-configuration.mjs";

const opts = { connectMs: 2000, discoveryMs: 2000 };
for (const transport of ["streamable-http", "sse"]) {
  for (const auth of [
    { type: "none" },
    { type: "bearer" },
    { type: "query", parameter: "access" },
    { type: "headers", headers: ["X-First", "X-Second"] },
  ]) {
    test(
      transport +
        " " +
        auth.type +
        " initializes and retrieves every page without running tools",
      async (t) => {
        const { state, config } = await remote(t, transport, auth);
        const values =
          auth.type === "none"
            ? []
            : auth.type === "headers"
              ? [token, "fixture-second"]
              : [token];
        assert.deepEqual(
          await discoverCatalog(config, values, opts),
          state.pages.flat(),
        );
        assert.deepEqual(state.calls, [
          "initialize",
          "notifications/initialized",
          "tools/list",
          "tools/list",
        ]);
      },
    );
  }
}
for (const status of [401, 403, 500])
  test(
    "classifies HTTP " + status + " independently of remote error text",
    async (t) => {
      const { state, config } = await remote(t, "sse");
      state.status = status;
      await assert.rejects(
        discoverCatalog(config, [], opts),
        (err) =>
          err.code ===
            { 401: "authentication", 403: "permission", 500: "unknown" }[
              status
            ] && !err.message.includes(token),
      );
    },
  );
for (const method of ["initialize", "tools/list"])
  test("bounds " + method + " wait", async (t) => {
    const { state, config } = await remote(t);
    state.hang = method;
    await assert.rejects(
      discoverCatalog(config, [], { connectMs: 200, discoveryMs: 200 }),
      { code: "timeout" },
    );
  });
test("unsafe destinations and redirects never receive credentials", async () => {
  for (const url of [
    "file:///invalid",
    "http://public.example/mcp",
    "https://user:password@example.org",
    "https://example.org/mcp?secret=abc",
  ])
    assert.throws(() => endpointUrl(url));
  const privateHost = [192, 168, 1, 20].join(".");
  const localEndpoint = `http://${privateHost}:8000/mcp`;
  assert.equal(endpointUrl(localEndpoint), localEndpoint);
  let requests = 0;
  const send = authenticatedFetch(
    { endpoint: "https://a.example", auth: { type: "bearer" } },
    [token],
    new AbortController().signal,
    async (_, init) => {
      requests++;
      assert.equal(init.redirect, "manual");
      return new Response("", {
        status: 302,
        headers: { Location: "https://b.example" },
      });
    },
  );
  await assert.rejects(send("https://b.example"), { code: "redirect" });
  assert.equal(requests, 0);
  await assert.rejects(send("https://a.example"), { code: "redirect" });
  assert.equal(requests, 1);
});
test("unavailable transport, invalid protocol, repeated cursor and credential echoes produce safe errors", async (t) => {
  const { config, state } = await remote(t);
  await assert.rejects(
    discoverCatalog(config, [], {
      ...opts,
      fetcher: async () => {
        throw Error(token);
      },
    }),
    { code: "transport" },
  );
  await assert.rejects(
    discoverCatalog(config, [], {
      ...opts,
      fetcher: async () =>
        new Response("{}", { headers: { "Content-Type": "application/json" } }),
    }),
    { code: "protocol" },
  );
  state.repeat = true;
  await assert.rejects(discoverCatalog(config, [], opts), {
    code: "discovery",
  });
  state.repeat = false;
  state.pages = [[{ ...tool("x"), description: "echo " + token }]];
  await assert.rejects(
    discoverCatalog(config, [token], opts),
    (err) => err.code === "sensitive" && !err.message.includes(token),
  );
});

test("SQLite synchronization, isolation, uniqueness, restart and Function compatibility", async (t) => {
  const first = await remote(t, "streamable-http", {
      type: "query",
      parameter: "access",
    }),
    second = await remote(t);
  const directory = await mkdtemp(join(tmpdir(), "day18-discovery-")),
    file = join(directory, "test.sqlite");
  const secrets = new Map();
  const store = {
    save: async (k, v) => secrets.set(k, v),
    read: async (k) => secrets.get(k),
    forget: async (k) => secrets.delete(k),
  };
  const app = () =>
    createSessionServer(file, { credentialStore: store, mcpOptions: opts });
  let server = app(),
    base = await start(server);
  t.after(async () => {
    await stop(server);
    await rm(directory, { recursive: true, force: true });
  });
  async function api(
    path = "",
    method = "GET",
    body,
    root = "/api/mcp-connections",
  ) {
    const res = await fetch(base + root + path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await res.text();
    assert.ok(!raw.includes(token));
    return { status: res.status, data: JSON.parse(raw) };
  }
  const formula = {
    id: "test-formula",
    name: "Sum",
    description: "Test",
    pseudocode: "Inputs:\na: number\nFormula:\nr = a + 1\nOutput:\nr: number",
  };
  assert.equal((await api("", "POST", formula, "/api/functions")).status, 201);
  const create = await api("", "POST", {
    ...first.config,
    secretValues: [token],
  });
  assert.equal(create.status, 201);
  const a = "/" + create.data.connectionId;
  assert.equal(
    (await api("", "POST", { ...second.config, name: "fixture" })).status,
    409,
  );
  const b =
    "/" +
    (await api("", "POST", { ...second.config, name: "Second" })).data
      .connectionId;
  for (const id of [a, b])
    assert.equal((await api(id + "/refresh", "POST")).status, 200);
  const before = (await api(a)).data,
    independent = (await api(b)).data;
  assert.notEqual(before.tools[0].toolId, independent.tools[0].toolId);
  assert.deepEqual(
    before.tools.map((x) => x.document),
    [first.state.pages[1][0], first.state.pages[0][0]],
  );
  assert.ok(before.connection.lastSuccess);
  assert.ok(!before.connection.stale);
  assert.equal(
    (await api(a, "PUT", { ...first.config, name: "Renamed", revision: 1 }))
      .status,
    200,
  );
  first.state.breakPage = true;
  assert.equal((await api(a + "/refresh", "POST")).status, 502);
  const failed = (await api(a)).data;
  assert.equal(failed.connection.stale, true);
  assert.equal(failed.connection.lastSuccess, before.connection.lastSuccess);
  assert.deepEqual(failed.tools, before.tools);
  assert.deepEqual((await api(b)).data, independent);
  first.state.breakPage = false;
  first.state.pages = [[tool("search_items")]];
  await api(a + "/refresh", "POST");
  await api(a + "/refresh", "POST");
  const reduced = (await api(a)).data;
  assert.equal(reduced.tools.length, 1);
  assert.equal(reduced.tools[0].toolId, before.tools[1].toolId);
  first.state.pages = [[tool("other"), tool("search_items")]];
  await api(a + "/refresh", "POST");
  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys=ON");
  assert.throws(
    () =>
      db.exec(
        "INSERT INTO mcp_tools SELECT 'duplicate',connection_id,original_name,document,1 FROM mcp_tools LIMIT 1",
      ),
    /UNIQUE/,
  );
  assert.throws(
    () => db.exec("INSERT INTO mcp_tools VALUES ('bad','missing','a','{}',1)"),
    /FOREIGN KEY/,
  );
  assert.ok(
    !JSON.stringify(db.prepare("SELECT * FROM mcp_connections").all()).includes(
      token,
    ),
  );
  assert.ok([...secrets.keys()].every((k) => k.startsWith("mcp-")));
  assert.throws(
    () => db.exec("UPDATE mcp_connections SET id='replacement'"),
    /Immutable connection identity/,
  );
  assert.throws(
    () => db.exec("UPDATE mcp_tools SET original_name='renamed'"),
    /Immutable tool identity/,
  );
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  db.close();
  await stop(server);
  server = app();
  base = await start(server);
  const restored = (await api(a)).data;
  assert.equal(restored.connection.name, "Renamed");
  // The removed tool retains its identity when rediscovered, but its old
  // watch permission stays revoked. The continuously present tool keeps its setting.
  assert.deepEqual(restored.tools, before.tools.map(tool =>
    tool.originalName === "other" ? {...tool, watchAttachedChats:false} : tool));
  assert.equal((await api(a + "/refresh", "POST")).status, 200);
  assert.equal((await api()).data.length, 2);
  assert.deepEqual((await api("", "GET", undefined, "/api/functions")).data, [
    formula,
  ]);
});

test("credential storage identities, rotation and protected connection settings", async (t) => {
  const { createMcpConnectionManager } =
    await import("./mcp-connection-manager.mjs");
  const { FileCredentialStore } = await import("./file-credential-store.mjs");
  const directory = await mkdtemp(join(tmpdir(), "day18-mcp-store-"));
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  t.after(async () => {
    db.close();
    await rm(directory, { recursive: true, force: true });
  });
  const store = new FileCredentialStore(directory),
    manager = createMcpConnectionManager(db, store);
  const config = {
    name: "Local",
    description: "",
    endpoint: "https://fixture.example/mcp",
    transport: "sse",
    auth: { type: "bearer" },
  };
  await store.save("openai", "synthetic-model-only");
  const saved = await manager.save(undefined, {
    ...config,
    secretValues: [token],
  });
  const ref = () =>
    db.prepare("SELECT credential_ref FROM mcp_connections").get()
      .credential_ref;
  const original = ref();
  await assert.rejects(
    manager.save(saved.connectionId, {
      ...config,
      revision: 1,
      endpoint: "https://different.example/mcp",
    }),
    { code: "invalid" },
  );
  await assert.rejects(
    manager.save(saved.connectionId, {
      ...config,
      revision: 77,
      secretValues: ["fixture-new"],
    }),
    { code: "conflict" },
  );
  await manager.save(saved.connectionId, {
    ...config,
    revision: 1,
    secretValues: ["fixture-new"],
  });
  assert.notEqual(ref(), original);
  assert.equal(await store.status(original), false);
  assert.equal(await store.read("openai"), "synthetic-model-only");
  assert.equal(
    await new FileCredentialStore(directory).read(ref()),
    JSON.stringify(["fixture-new"]),
  );
  assert.ok(!JSON.stringify(manager.list()).includes("fixture-new"));
});

test("sanitized discovery failures do not log remote error bodies or credentials", async (t) => {
  const { config, state } = await remote(t, "streamable-http", {
    type: "query",
    parameter: "access",
  });
  state.status = 403;
  const output = [];
  for (const name of ["log", "debug", "warn", "error"])
    t.mock.method(console, name, (...args) => output.push(...args.map(String)));
  await assert.rejects(
    discoverCatalog(config, [token], opts),
    (error) => error.code === "permission" && !error.message.includes(token),
  );
  assert.ok(!output.join("\n").includes(token));
});

test("Week 4 Manager executes only pinned operations on the selected servers and journals each independent result", async (t) => {
  const a = await remote(t),
    b = await remote(t, "sse");
  const dir = await mkdtemp(join(tmpdir(), "d18-executor-")),
    path = join(dir, "fixture.sqlite");
  const policy = [];
  let plan, workflowStep,
    generatedReference = "",
    responseFailure = false,
    observations = [],
    seen = [];
  const mock = createDevManagerMock("fixture");
  const waits = [];
  const server = createSessionServer(path, {
    executionOptions: {
      readMcpPolicy: () => policy,
      wait: async (ms) => {
        waits.push(ms);
        await new Promise((r) => setTimeout(r, ms));
      },
      random: () => 0,
      policy: { delayMs: 1, timeoutMs: 2000, deadlineMs: 15000 },
    },
    invariantAdapter: () => ({
      ...mock,
      complete: async (input) => {
        if (
          input.memoryProposal ||
          input.messages[0]?.content.startsWith("Review a proposed")
        )
          return mock.complete(input);
        if (workflowStep) return workflowStep(input);
        if (input.messages.at(-1).role === "tool") {
          observations = input.messages
            .filter((m) => m.role === "tool")
            .map((m) => [m.toolCallId, JSON.parse(m.content)]);
          if (responseFailure) throw Error("Synthetic final model failure.");
          return {
            text:
              "Reported separately: " +
              observations.map(([id, r]) => id + " " + r.outcome).join(", ") + generatedReference,
          };
        }
        seen = input.tools.filter((t) => t.kind === "mcp");
        const ids = plan(seen, input);
        return ids.length
          ? { toolCalls: ids }
          : { text: "No external tools available." };
      },
    }),
  });
  const base = await start(server);
  const db = new DatabaseSync(path);
  t.after(async () => {
    await stop(server);
    db.close();
    await rm(dir, { recursive: true });
  });
  const api = async (path, body, method) => {
    const r = await fetch(base + "/api/" + path, {
      method: method ?? (body ? "POST" : "GET"),
      headers: { "content-type": "application/json" },
      body: body && JSON.stringify(body),
    });
    return { s: r.status, d: await r.json() };
  };
  const chat = async () => (await api("week3/sessions", {})).d.id;
  const [both, one, none] = await Promise.all([chat(), chat(), chat()]);
  const catalogs = [];
  for (const [index, peer] of [a, b].entries()) {
    peer.state.pages = [[tool("same")]];
    peer.state.execute = () => ({
      content: [
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ],
      structuredContent: {},
      _meta: { fixture: index },
    });
    const id = (
      await api("mcp-connections", { ...peer.config, name: "peer" + index })
    ).d.connectionId;
    assert.equal((await api("mcp-connections/" + id + "/refresh", {})).s, 200);
    const cat = (await api("mcp-connections/" + id)).d;
    catalogs.push(cat);
    for (const session of index === 1 ? [both, one] : [both])
      assert.equal(
        (
          await api(
            "week4/sessions/" + session + "/mcp-connections/" + id,
            undefined,
            "PUT",
          )
        ).s,
        200,
      );
  }
  const allow = (session, index, args, safety = "read-only", requires = [], policyFields = {}) => {
    const {
      tools: [tool],
      connection,
    } = catalogs[index];
    const rule = {
      sessionId: session,
      connectionId: tool.connectionId,
      toolId: tool.toolId,
      definition: policyDigest(tool.document),
      revision: connection.revision,
      arguments: args,
      safety,
      independentInputs: !requires.length,
      requires,
      ...policyFields,
    };
    policy.push(rule);
    return policyDigest(rule);
  };
  const read = { operation: "read" },
    write = { operation: "create", label: "fixture" };
  for (const [s, i] of [
    [both, 0],
    [both, 1],
    [one, 1],
  ])
    allow(s, i, read);
  const writeGrant = allow(both, 0, write, "side-effecting");
  const later = { operation: "followup" };
  allow(both, 1, later, "side-effecting", [writeGrant]);
  let last;
  const turn = async (s = both, week = "week4", question = "Inspect approved fixture operations.") => {
    last = randomUUID();
    return api(week + "/sessions/" + s + "/invariant-turn", {
      turnId: last,
      execute: true,
      model: "fixture",
      provider: "openai",
      question,
    });
  };
  const operations = () =>
    db
      .prepare(
        "SELECT * FROM week4_operations WHERE run_id=? AND kind='tool' ORDER BY rowid",
      )
      .all(last);
  const call = (i, args, id, extra = {}) => ({
    id,
    toolId: "mcp:" + catalogs[i].tools[0].toolId,
    providerName: "mcp_" + catalogs[i].tools[0].toolId.replaceAll("-", ""),
    arguments: args,
    ...extra,
  });
  plan = () => [call(0, read, "a"), call(1, read, "b")];
  assert.equal((await turn()).s, 200);
  assert.deepEqual(
    new Set(seen.map((x) => x.toolId)),
    new Set(catalogs.map((c) => c.tools[0].toolId)),
  );
  assert.deepEqual(
    observations.map(([id, r]) => [id, r.output._meta.fixture]),
    [
      ["a", 0],
      ["b", 1],
    ],
  );
  const first = operations();
  for (const o of first) {
    assert.equal(o.state, "Success");
    assert.ok(o.parent_llm_id);
    assert.ok(o.policy_grant);
    assert.equal(JSON.parse(o.result).content.length, 2);
  }
  // Cheap second read reuses the initialized, session-partitioned lease.
  const handshakes = b.state.calls.filter((x) => x === "initialize").length;
  a.state.execute = () => ({
    content: [{ type: "text", text: "not a successful result" }],
    isError: true,
  });
  assert.equal((await turn()).s, 200);
  assert.deepEqual(
    operations().map((x) => x.state),
    ["Failed", "Success"],
  );
  assert.equal(JSON.parse(operations()[0].error).source, "mcp");
  assert.equal(
    b.state.calls.filter((x) => x === "initialize").length,
    handshakes,
  );
  responseFailure = true;
  plan = () => [call(1, read, "ok")];
  assert.equal((await turn()).s, 200);
  assert.equal(operations()[0].state, "Success");
  assert.equal(
    db.prepare("SELECT state FROM week4_runs WHERE id=?").get(last).state,
    "PartialSuccess",
  );
  responseFailure = false;
  for (const [kind, reply, code, n] of [
    ["credentials", { status: 401 }, "authentication", 1],
    ["text error with empty structured result", {content:[{type:"text",text:"Tool execution failed: no document connected"}],structuredContent:{}}, "execution_error", 1],
    ["permission", { status: 403 }, "authorization", 1],
    [
      "unsupported",
      { content: [{ type: "image", mimeType: "image/png", data: "AAAA" }] },
      "schema",
      1,
    ],
    [
      "invalid output",
      { content: [], structuredContent: { extra: true } },
      "schema",
      1,
    ],
    [
      "protocol",
      { rpcError: { code: -32603, message: "fixture" } },
      "protocol",
      1,
    ],
    [
      "rate limit",
      { status: 429, headers: { "retry-after": "0" } },
      "rate_limit",
      3,
    ],
    ["unavailable", { status: 503 }, "unavailable", 3],
  ]) {
    let calls = 0;
    a.state.execute = () => {
      calls++;
      return reply;
    };
    plan = () => [call(0, read, kind)];
    assert.equal((await turn()).s, 200);
    assert.equal(calls, n, kind);
    assert.equal(JSON.parse(operations()[0].error).code, code, kind);
    if (code === "authentication" || code === "unavailable") {
      const message = db.prepare("SELECT json_extract(payload,'$.text') AS text FROM week3_history_events WHERE sessionId=? AND type='message' AND json_extract(payload,'$.role')='assistant' ORDER BY sequence DESC LIMIT 1").get(both);
      assert.match(message.text, code === "authentication" ? /Authentication failed/ : /temporarily unavailable/);
    }
  }
  plan = () => [call(0, { operation: "delete" }, "denied")];
  const before = a.state.calls.filter((x) => x === "tools/call").length;
  const deniedTurn = await turn();
  assert.equal(
    deniedTurn.s,
    200,
    JSON.stringify({
      error: deniedTurn.d.error,
      states: db
        .prepare("SELECT kind,state,error FROM week4_operations WHERE run_id=?")
        .all(last),
      run: db
        .prepare("SELECT state,error FROM week4_runs WHERE id=?")
        .get(last),
    }),
  );
  assert.equal(a.state.calls.filter((x) => x === "tools/call").length, before);
  assert.equal(operations()[0].state, "Failed");
  a.state.execute = () => ({ drop: true });
  plan = () => [
    call(0, write, "uncertain"),
    call(1, later, "dependent", { dependsOn: ["uncertain"] }),
    call(1, read, "independent"),
  ];
  assert.equal((await turn()).s, 200);
  assert.deepEqual(
    operations().map((o) => o.state),
    ["Unknown", "Skipped", "Success"],
  );
  assert.equal(
    db.prepare("SELECT state FROM week4_runs WHERE id=?").get(last).state,
    "RequiresReview",
  );
  const journalPath = "week4/sessions/" + both + "/execution-journal";
  const uncertainOps = operations();
  const observed = (await api(journalPath)).d.filter(
    (row) => row.runId === last,
  );
  assert.deepEqual(
    observed.map((row) => row.status),
    ["Unknown", "Skipped", "Success"],
  );
  assert.ok(observed.every((row) => row.runState === "RequiresReview"));
  assert.deepEqual(
    (await api(journalPath + "/" + uncertainOps[1].id)).d.dependencies,
    [uncertainOps[0].id],
  );
  policy.find((g) => policyDigest(g) === writeGrant).independentInputs = false;
  plan = () => [call(0, write, "again")];
  assert.equal((await turn()).s, 200);
  assert.equal(
    a.state.calls.filter((x) => x === "tools/call").length,
    before + 1,
  );
  // Application-level success proof for a server that returns unflagged text errors.
  const proof = { operation: "proof" };
  allow(both, 0, proof);
  policy.at(-1).resultSchema = {
    type: "object",
    properties: { saved: { const: true } },
    required: ["saved"],
  };
  a.state.execute = () => ({
    content: [
      { type: "text", text: "Remote returned an operational failure." },
    ],
    structuredContent: {},
  });
  plan = () => [call(0, proof, "proof")];
  assert.equal((await turn()).s, 200);
  assert.equal(JSON.parse(operations()[0].error).code, "schema");

  const failedProof = (await api(journalPath + "/" + operations()[0].id)).d;
  assert.equal(JSON.parse(failedProof.attempts[0].returned).content[0].text, "Remote returned an operational failure.");
  assert.equal(failedProof.result,null);

  const artifact = { operation: "create", label: "MCP_TEST_D16_fixture" };
  const verify = { operation: "inspect", label: artifact.label };
  const ticket = { operation: "create", reference: artifact.label };
  const created = allow(both, 0, artifact, "side-effecting");
  const inspected = allow(both, 0, verify, "read-only", [created]);
  allow(both, 1, ticket, "side-effecting", [inspected]);
  const remoteArtifacts = new Set(),
    remoteTickets = [];
  const success = (text) => ({
    content: [{ type: "text", text }],
    structuredContent: {},
  });
  a.state.execute = ({ arguments: args }) => {
    if (args.operation === "create") remoteArtifacts.add(args.label);
    return remoteArtifacts.has(args.label)
      ? success(args.label)
      : { isError: true, content: [] };
  };
  b.state.execute = ({ arguments: args }) => {
    remoteTickets.push(args.reference);
    return success("Saved reference");
  };
  plan = () => [
    call(0, artifact, "create"),
    call(0, verify, "inspect"),
    call(1, ticket, "ticket"),
  ];
  assert.equal((await turn()).s, 200);
  assert.deepEqual(
    operations().map((o) => o.state),
    ["Success", "Success", "Success"],
  );
  assert.deepEqual(remoteTickets, [artifact.label]);
  assert.deepEqual([...remoteArtifacts], [artifact.label]);

  await t.test("a partial landing page is inspected, repaired, verified, then linked to one implementation ticket", async () => {
    const page = {sections: [], title: null};
    const tickets = [];
    const inspect = {operation:"inspect",page:"landing"};
    const shell = {operation:"create",section:"hero"};
    const broken = {operation:"text",value:1204};
    const repair = {operation:"set-title",value:"Welcome"};
    const verify = {operation:"verify",page:"landing"};
    const url = "https://design.fixture.invalid/landing";
    const ticketUrl = "https://tracker.fixture.invalid/items/landing";
    const task = {operation:"create",design:url};
    const checked = allow(both,0,inspect);
    allow(both,0,shell,"side-effecting");
    allow(both,0,broken,"side-effecting",[checked]);
    allow(both,0,repair,"side-effecting",[checked]);
    const proof = allow(both,0,verify);
    allow(both,1,task,"side-effecting",[proof]);
    const calls = [];
    a.state.execute = ({arguments: args}) => {
      calls.push(args.operation);
      if (args.operation === "create") page.sections.push(args.section);
      if (args.operation === "text") {
        page.sections.push("heading");
        return success("Tool execution failed: [DESIGN PLUGIN] Value not valid: 1204. Code: :createText");
      }
      if (args.operation === "set-title") page.title = args.value;
      if (args.operation === "verify" && page.title !== "Welcome") return {isError:true,content:[]};
      return success(JSON.stringify({...page, ...(args.operation === "verify" && {url})}));
    };
    b.state.execute = ({arguments: args}) => {
      assert.equal(args.design,url);
      calls.push("ticket");
      tickets.push({ design: args.design, url: ticketUrl });
      return success(ticketUrl);
    };
    workflowStep = ({messages}) => {
      const replies = messages.filter(m=>m.role==="tool").map(m=>JSON.parse(m.content));
      const last = replies.at(-1);
      const invoke = (i,args) => ({toolCalls:[call(i,args,"step-"+replies.length)]});
      switch (replies.length) {
        case 0: return invoke(0,shell);
        case 1: return invoke(0,inspect);
        case 2: return invoke(0,broken);
        case 3:
          assert.equal(last.outcome,"Unknown");
          assert.match(last.error.diagnostic,/Value not valid: 1204.*createText/);
          // An old inspection cannot authorize a correction after the partial write.
          return invoke(0,repair);
        case 4: return invoke(0,inspect);
        case 5: {
          const actual=JSON.parse(last.output.content[0].text);
          assert.deepEqual(actual.sections,["hero","heading"]);
          assert.equal(actual.title,null);
          return invoke(0,repair);
        }
        case 6: assert.ok(last.ok); return invoke(0,verify);
        case 7: {
          const actual=JSON.parse(last.output.content[0].text);
          assert.deepEqual(actual,{sections:["hero","heading"],title:"Welcome",url});
          return invoke(1,{operation:"create",design:actual.url});
        }
        default: return {text:"Verified landing page and implementation task: "+url+" "+ticketUrl};
      }
    };
    try {
      const question="Build and verify a landing page, then file its implementation task.";
      assert.equal((await turn(both,"week4",question)).s,200);
      assert.deepEqual(calls,["create","inspect","text","inspect","set-title","verify","ticket"]);
      assert.deepEqual(tickets,[{design:url,url:ticketUrl}]);
      const rows=operations();
      assert.deepEqual(rows.map(o=>o.state),["Success","Success","Unknown","Skipped","Success","Success","Success","Success"]);
      assert.deepEqual(JSON.parse(rows[5].display).prerequisites,[rows[4].id]);
      assert.match(JSON.parse(rows[2].error).diagnostic,/Value not valid: 1204/);
      const detail = (await api(journalPath + "/" + rows[2].id)).d;
      assert.equal(detail.error.diagnostic, detail.attempts[0].error.diagnostic);
      assert.match(detail.error.diagnostic, /Value not valid: 1204.*createText/);
      const answer=db.prepare("SELECT json_extract(payload,'$.text') AS text FROM week3_history_events WHERE sessionId=? AND type='message' AND json_extract(payload,'$.role')='assistant' ORDER BY sequence DESC LIMIT 1").get(both).text;
      assert.ok(answer.includes(url) && answer.includes(ticketUrl));
      assert.equal(db.prepare("SELECT state FROM week4_runs WHERE id=?").get(last).state,"RequiresReview");
    } finally { workflowStep=undefined; }
  });

  await t.test("an uncertain optional export preserves independent reads and verified writes", async () => {
    const design = {operation:"create", label:"design-optional-export"};
    const inspect = {operation:"inspect", label:design.label};
    const exportArgs = {operation:"export", label:design.label};
    const project = {operation:"lookup", key:"project"};
    const status = {operation:"lookup", key:"status"};
    const ticket = {operation:"create", design:design.label, project:"p1", status:"s1"};
    const attached = {...ticket, attachment:"from-export"};
    const unclassified = {operation:"other", label:"unclassified"};
    const created = allow(both, 0, design, "side-effecting");
    const verified = allow(both, 0, inspect, "read-only", [created], {stateScope:"document"});
    const exported = allow(both, 0, exportArgs, "side-effecting", [verified], {stateScope:"export-storage"});
    // Both lookup argument tuples are pinned by the operator. No remote hint,
    // provider dependency, or blanket independentInputs grant is needed.
    const exactRead = {independentInputs:undefined};
    const p = allow(both, 1, project, "read-only", [], exactRead);
    const s = allow(both, 1, status, "read-only", [], exactRead);
    allow(both, 1, ticket, "side-effecting", [verified, p, s]);
    allow(both, 1, attached, "side-effecting", [exported]);
    allow(both, 1, unclassified, "side-effecting", [], {independentInputs:false});
    const image = {content:[{type:"image",mimeType:"image/png",data:"U1lOVEhFVElDX0JJTkFSWQ=="}]};
    const dispatched = [];
    a.state.execute = ({arguments:args}) => {
      dispatched.push(args);
      if (args.operation === "export") return image;
      assert.ok(args.operation === "create" || dispatched.some(c => c.operation === "create"));
      return success(JSON.stringify({id:design.label, verified:args.operation === "inspect"}));
    };
    b.state.execute = ({arguments:args}) => {
      dispatched.push(args);
      return success(JSON.stringify({id:args.key === "project" ? "p1" : args.key === "status" ? "s1" : "item-1"}));
    };
    workflowStep = ({messages}) => {
      const receipts = messages.filter(m => m.role === "tool").map(m => JSON.parse(m.content));
      const result = index => JSON.parse(receipts[index].output.content[0].text);
      switch (receipts.length) {
        case 0: return {toolCalls:[call(0, design, "design")]};
        case 1: return {toolCalls:[call(0, {...inspect,label:result(0).id}, "verify")]};
        case 2:
          assert.equal(result(1).verified,true);
          return {toolCalls:[call(0, exportArgs, "export")]};
        case 3:
          assert.equal(receipts[2].outcome,"Unknown");
          return {toolCalls:[call(1, project, "project"), call(1, status, "status")]};
        case 5: {
          const args = {operation:"create",design:result(1).id,project:result(3).id,status:result(4).id};
          return {toolCalls:[call(1, args, "create")]};
        }
        case 6: return {toolCalls:[call(1, attached, "attach"), call(1, unclassified, "other"),
          call(0, exportArgs, "repeat-export"), call(1, ticket, "repeat-create")]};
        default: return {text:"Created work item " + result(5).id + ". The export is unconfirmed."};
      }
    };
    try {
      assert.equal((await turn()).s,200);
    } finally {
      workflowStep = undefined;
    }
    assert.deepEqual(dispatched,[design,inspect,exportArgs,project,status,ticket]);
    const rows = operations();
    assert.deepEqual(rows.map(r=>r.state),["Success","Success","Unknown","Success","Success","Success","Skipped","Skipped"]);
    assert.deepEqual(JSON.parse(rows[5].display).prerequisites,[rows[1].id,rows[3].id,rows[4].id]);
    assert.deepEqual(JSON.parse(rows[6].display).prerequisites,[rows[2].id]);
    assert.equal(JSON.parse(rows[6].error).skipReason,"prerequisite_failed");
    assert.equal(JSON.parse(rows[7].error).skipReason,"independence_after_failure_unproven");
    assert.equal(db.prepare("SELECT state FROM week4_runs WHERE id=?").get(last).state,"RequiresReview");
    const detail = (await api(journalPath + "/" + rows[2].id)).d;
    assert.equal(detail.attempts.length,1);
    assert.equal(detail.error.code,"schema");
    assert.equal(detail.error.diagnostic,detail.attempts[0].error.diagnostic);
    const info = JSON.parse(detail.attempts[0].returned);
    assert.equal(info.reason,"Structured content did not match the declared output schema.");
    assert.equal(info.contentBlocks,1);
    assert.deepEqual(info.contentBlockTypes,{image:1});
    assert.equal(info.responseBytes,Buffer.byteLength(JSON.stringify(image)));
    assert.doesNotMatch(JSON.stringify(detail),/U1lOVEhFVElDX0JJTkFSWQ/);
  });

  await t.test("a completed call with omitted data never supplies missing prerequisite evidence", async () => {
    const preview = {operation:"render", label:"optional"};
    const attach = {operation:"attach", label:"needs-data"};
    const check = allow(both,0,preview,"side-effecting");
    allow(both,1,attach,"side-effecting",[check]);
    a.state.execute = () => ({structuredContent:{},content:[{type:"audio",data:"AA==",mimeType:"audio/wav"}]});
    let writes = 0;
    b.state.execute = () => { writes++; return success("Saved"); };
    plan = () => [call(0,preview,"preview"),call(1,attach,"attach")];
    assert.equal((await turn()).s,200);
    const [completed,skipped] = operations();
    assert.equal(completed.state,"Success");
    assert.deepEqual(JSON.parse(completed.result).compatibilityWarning.omitted,{audio:1});
    assert.equal(skipped.state,"Skipped");
    assert.equal(JSON.parse(skipped.error).skipReason,"prerequisite_missing");
    assert.deepEqual(JSON.parse(skipped.display).prerequisites,[completed.id]);
    assert.equal(writes,0);
  });

  await t.test("overlapping or unclassified uncertainty still invalidates earlier verification", async () => {
    for (const [readScope, writeScope] of [["document","document"], ["document",undefined], [undefined,"exports"]]) {
      const label = randomUUID();
      const proof = {operation:"verify",label};
      const uncertain = {operation:"export",label};
      const dependent = {operation:"publish",label};
      const checked = allow(both, 0, proof, "read-only", [], {stateScope:readScope});
      allow(both, 0, uncertain, "side-effecting", [], {stateScope:writeScope});
      allow(both, 1, dependent, "side-effecting", [checked]);
      const writes = [];
      a.state.execute = ({arguments:args}) => args.operation === "verify"
        ? success("Verified") : {content:[{type:"image",mimeType:"image/png",data:"AA=="}]};
      b.state.execute = ({arguments:args}) => { writes.push(args); return success("Created"); };
      plan = () => [call(0,proof,"proof"),call(0,uncertain,"export"),call(1,dependent,"publish")];
      assert.equal((await turn()).s,200);
      const rows = operations();
      assert.deepEqual(rows.map(row=>row.state),["Success","Unknown","Skipped"]);
      assert.deepEqual(JSON.parse(rows[2].display).prerequisites,[rows[0].id]);
      assert.equal(JSON.parse(rows[2].error).skipReason,"prerequisite_failed");
      assert.deepEqual(writes,[]);
    }
  });

  await t.test("a dependent write uses the verification call in its own run", async () => {
    const verification = { operation: "inspect", label: "current workflow" };
    const dependent = { operation: "create", reference: "current workflow" };
    const required = allow(both, 0, verification);
    allow(both, 1, dependent, "side-effecting", [required]);
    let verified = true;
    const dispatched = [];
    a.state.execute = () =>
      verified ? success("Verified") : { isError: true, content: [] };
    b.state.execute = ({ arguments: args }) => {
      dispatched.push(args);
      return success("Completed");
    };
    plan = () => [call(0, verification, "verify")];
    assert.equal((await turn()).s, 200);
    const [earlier] = operations();
    assert.equal(earlier.state, "Success");

    plan = () => [call(1, dependent, "dependent")];
    assert.equal((await turn()).s, 200);
    const [unverified] = operations();
    assert.equal(unverified.state, "Skipped");
    const missing = (await api(journalPath + "/" + unverified.id)).d;
    assert.deepEqual(missing.dependencies, []);
    assert.equal(missing.error.skipReason, "prerequisite_missing");
    assert.deepEqual(dispatched, []);

    // Native provider calls do not supply dependsOn. The policy binds the write.
    plan = () => [
      call(0, verification, "verify"),
      call(1, dependent, "dependent"),
      call(1, read, "independent"),
    ];
    for (const succeeds of [false, true]) {
      verified = succeeds;
      dispatched.length = 0;
      assert.equal((await turn()).s, 200);
      const rows = (await api(journalPath)).d.filter((row) => row.runId === last);
      assert.deepEqual(rows.map((row) => row.status), verified
        ? ["Success", "Success", "Success"] : ["Failed", "Skipped", "Success"]);
      assert.ok(rows.every((row) => row.runState === (verified ? "Completed" : "PartialSuccess")));
      assert.notEqual(rows[0].id, earlier.id);
      const detail = (await api(journalPath + "/" + rows[1].id)).d;
      assert.deepEqual(detail.dependencies, [rows[0].id]);
      assert.equal(detail.attempts.length, verified ? 1 : 0);
      if (!verified) assert.equal(detail.error.skipReason, "prerequisite_failed");
      assert.deepEqual(dispatched, verified ? [dependent, read] : [read]);
    }
  });

  await t.test(
    "current attachment and a scoped grant permit new search terms, while action and target stay pinned",
    async () => {
      const session = await chat();
      const cat = catalogs[1];
      const schema = {
        type: "object",
        additionalProperties: false,
        properties: {
          action: { type: "string", const: "search" },
          query: { type: "string", minLength: 1, maxLength: 80 },
          project: { type: "string", const: "sample-project" },
        },
        required: ["action", "project", "query"],
      };
      policy.push({
        sessionScope: "attached-read",
        connectionId: cat.connection.connectionId,
        toolId: cat.tools[0].toolId,
        revision: cat.connection.revision,
        definition: policyDigest(cat.tools[0].document),
        argumentSchema: schema,
        safety: "read-only",
        independentInputs: true,
      });
      const selection =
        "week4/sessions/" +
        session +
        "/mcp-connections/" +
        cat.connection.connectionId;
      let project = "sample-project";
      plan = (tools, input) => {
        const catalog = input.messages.find((m) =>
          m.content?.includes("Session catalog:"),
        );
        assert.ok(catalog);
        const selected = tools.find((tool) =>
          tool.description.includes(cat.connection.name),
        );
        const query = input.messages.at(-1).content.split(" about ").at(-1);
        return selected
          ? [
              {
                id: "lookup",
                toolId: selected.id,
                providerName: "mcp_" + selected.toolId.replaceAll("-", ""),
                arguments: { action: "search", project, query },
              },
            ]
          : [];
      };
      const received = [];
      b.state.execute = ({ arguments: value }) => {
        received.push(value);
        return success("https://fixture.invalid/artifacts/123");
      };
      assert.equal((await turn(session)).s, 200);
      assert.equal(seen.length, 0);
      assert.equal((await api(selection, undefined, "PUT")).s, 200);
      generatedReference = " https://fixture.invalid/fabricated";
      for (const query of ["design tickets", "open reviews"]) {
        const question =
          (query === "open reviews"
            ? "Use " + cat.connection.name
            : "Find records") +
          " about " +
          query;
        assert.equal((await turn(session, "week4", question)).s, 200);
        assert.equal(seen.length, 1);
        assert.equal(
          seen[0].inputSchema.properties.project.const,
          "sample-project",
        );
        assert.deepEqual(received.at(-1), { action: "search", project, query });
        assert.equal(
          observations[0][1].output.content[0].text,
          "https://fixture.invalid/artifacts/123",
        );
        const final = db
          .prepare(
            "SELECT json_extract(payload,'$.text') AS text FROM week3_history_events WHERE sessionId=? AND type='message' AND json_extract(payload,'$.role')='assistant' ORDER BY sequence DESC LIMIT 1",
          )
          .get(session);
        assert.match(final.text, /https:\/\/fixture\.invalid\/artifacts\/123/);
        assert.doesNotMatch(final.text, /fabricated/);
      }
      generatedReference = "";
      project = "different-project";
      assert.equal((await turn(session)).s, 200);
      assert.equal(observations[0][1].error.code, "authorization");
      assert.equal(received.length, 2);
      // A dynamic read of another target cannot satisfy a write's prerequisite.
      const { invocationGrantId } = await import("./mcp-execution-policy.mjs");
      const approvedScope = policy.at(-1);
      const wanted = {
        action: "search",
        project: "sample-project",
        query: "requested record",
      };
      const create = { action: "create", reference: "requested record" };
      allow(session, 1, create, "side-effecting", [
        invocationGrantId(approvedScope, wanted),
      ]);
      for (const [query, state] of [
        ["different record", "Skipped"],
        ["requested record", "Success"],
      ]) {
        plan = () => [
          call(1, { ...wanted, query }, "read"),
          call(1, create, "create"),
        ];
        assert.equal((await turn(session)).s, 200);
        assert.deepEqual(
          operations().map((o) => o.state),
          ["Success", state],
        );
      }
      const countBeforeDetach = received.length;
      plan = (tools) => (tools.length ? [call(1, wanted, "lookup")] : []);
      assert.equal((await api(selection, undefined, "DELETE")).s, 200);
      assert.equal((await turn(session)).s, 200);
      assert.equal(seen.length, 0);
      assert.equal(received.length, countBeforeDetach);
    },
  );
  await t.test("reviewed executable body accepts generated data through the Manager and rejects an unapproved program", async () => {
    const session = await chat();
    const connection = catalogs[0].connection.connectionId;
    const codeTool = {name:"execute_code",description:"Inspect a test design",
      inputSchema:{type:"object",properties:{code:{type:"string"}},required:["code"],additionalProperties:false}};
    a.state.pages = [[codeTool]];
    assert.equal((await api("mcp-connections/"+connection+"/refresh",{})).s,200);
    assert.equal((await api("week4/sessions/"+session+"/mcp-connections/"+connection,undefined,"PUT")).s,200);
    const {tools:[entry],connection:info} = (await api("mcp-connections/"+connection)).d;
    const body = "return document.findByName(input.name);";
    const grant = {sessionId:session,connectionId:connection,toolId:entry.toolId,
      revision:info.revision,definition:policyDigest(entry.document),safety:"read-only",
      argumentSchema:codeTool.inputSchema, independentInputs:true,
      codeTemplate:{body,inputSchema:{type:"object",additionalProperties:false,
        properties:{name:{type:"string",maxLength:40}}, required:["name"]}}};
    policy.push(grant);
    const dispatched = [];
    a.state.execute = params => {dispatched.push(params); return success("Verified test object");};
    let extra = "";
    plan = (tools,input) => {
      const selected = tools.find(tool => tool.originalName === codeTool.name);
      assert.ok(selected.description.includes(body));
      const name = input.messages.at(-1).content.split("named ").at(-1);
      return [{id:"inspect",toolId:selected.id,providerName:"mcp_"+entry.toolId.replaceAll("-",""),
        arguments:{code:"const input = "+JSON.stringify({name})+";\n"+body+extra}}];
    };
    assert.equal((await turn(session,"week4","Inspect the object named Receipt")).s,200);
    assert.equal(operations()[0].state,"Success");
    extra = "\nreturn anotherObject;";
    assert.equal((await turn(session,"week4","Inspect the object named Other")).s,200);
    assert.equal(operations()[0].state,"Failed");
    assert.equal(dispatched.length,1);
    assert.equal(dispatched[0].name,"execute_code");
  });
  plan = () => [];
  for (const [session, week, expected] of [
    [one, "week4", 1],
    [none, "week4", 0],
    [both, "week3", 0],
  ]) {
    assert.equal((await turn(session, week)).s, 200);
    assert.equal(seen.length, expected);
  }
});

test("four active MCP leases bound one connection and an aborted call releases its slot", async (t) => {
  const peer = await remote(t);
  const { createMcpConnectionManager } =
    await import("./mcp-connection-manager.mjs");
  const db = new DatabaseSync(":memory:");
  const manager = createMcpConnectionManager(db, {}, opts);
  t.after(async () => {
    await manager.close();
    db.close();
  });
  const connection = await manager.save(undefined, peer.config);
  await manager.refresh(connection.connectionId);
  const tool = manager.catalog(connection.connectionId).tools[0];
  const dest = {
    toolId: tool.toolId,
    connectionId: connection.connectionId,
    revision: connection.revision,
    sessionId: randomUUID(),
    originalName: tool.originalName,
    arguments: {},
    grantId: "fixture",
    safety: "read-only",
  };
  const entered = Promise.withResolvers(),
    finish = Promise.withResolvers();
  let active = 0;
  peer.state.execute = async () => {
    if (++active === 4) entered.resolve();
    await finish.promise;
    return { content: [{ type: "text", text: "ok" }] };
  };
  const controls = Array.from({ length: 4 }, () => new AbortController());
  const pending = controls.map((c) =>
    manager.execute(dest, c.signal, () => true),
  );
  try {
    await entered.promise;
    const overflow = await manager.execute(
      dest,
      new AbortController().signal,
      () => true,
    );
    assert.equal(overflow.error.code, "capacity");
    controls[0].abort();
    assert.equal((await pending[0]).error.code, "cancelled");
  } finally {
    finish.resolve();
    await Promise.all(pending);
  }
  const fresh = await manager.execute(
    dest,
    new AbortController().signal,
    () => true,
  );
  assert.ok(fresh.ok);
});

test("identical search definitions keep isolated aliases, grants, journal captures and routes across Streamable HTTP reconnection", async (t) => {
  const { buildProviderToolNameMap, parseOpenAIResponses } =
    await import("../src/manager-llm-adapter.ts");
  const dir = await mkdtemp(join(tmpdir(), "d18-collision-")),
    file = join(dir, "test.sqlite");
  const peers = [await remote(t), await remote(t)],
    policy = [],
    args = { query: "sample" };
  const definition = {
    name: "search",
    description: "Search for matching records",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
  };
  const mock = createDevManagerMock("fixture");
  let offered = [],
    results = [];
  const app = () =>
    createSessionServer(file, {
      executionOptions: { readMcpPolicy: () => policy },
      invariantAdapter: () => ({
        ...mock,
        complete: async (input) => {
          if (
            input.memoryProposal ||
            input.messages[0]?.content.startsWith("Review a proposed")
          )
            return mock.complete(input);
          if (input.messages.at(-1).role === "tool") {
            results = input.messages
              .filter((m) => m.role === "tool")
              .map(
                (m) => JSON.parse(m.content).output.structuredContent.server,
              );
            return {
              text: "Search completed on " + results.join(" and ") + ".",
            };
          }
          const map = buildProviderToolNameMap(input.tools);
          offered = input.tools
            .filter((t) => t.kind === "mcp")
            .map((t) => map.idToName.get(t.id));
          return parseOpenAIResponses(
            {
              output: offered.map((name, i) => ({
                type: "function_call",
                call_id: "search" + i,
                name,
                arguments: JSON.stringify(args),
              })),
            },
            map,
          );
        },
      }),
    });
  let server = app(),
    base = await start(server);
  t.after(async () => {
    await stop(server);
    await rm(dir, { recursive: true });
  });
  async function api(path, body, method) {
    const r = await fetch(base + "/api/" + path, {
      method: method ?? (body ? "POST" : "GET"),
      headers: { "content-type": "application/json" },
      body: body && JSON.stringify(body),
    });
    return [r.status, await r.json()];
  }
  const make = async (title) => {
    const [status, s] = await api("week3/sessions", {});
    assert.equal(status, 201);
    await api("week3/sessions/" + s.id, { title }, "PATCH");
    return s.id;
  };
  const both = await make("Search verification"),
    single = await make("Isolated search");
  const cats = [];
  for (const [i, peer] of peers.entries()) {
    const name = ["North", "South"][i];
    peer.state.pages = [[definition]];
    peer.state.execute = (params) => {
      assert.deepEqual(params, { name: "search", arguments: args });
      return {
        content: [{ type: "text", text: name }],
        structuredContent: {
          server: name,
          access_token: "synthetic-private-token",
        },
      };
    };
    const [, saved] = await api("mcp-connections", { ...peer.config, name });
    assert.equal(
      (await api("mcp-connections/" + saved.connectionId + "/refresh", {}))[0],
      200,
    );
    const [, cat] = await api("mcp-connections/" + saved.connectionId);
    cats.push(cat);
    for (const s of [both, single]) {
      assert.equal(
        (
          await api(
            "week4/sessions/" + s + "/mcp-connections/" + saved.connectionId,
            undefined,
            "PUT",
          )
        )[0],
        200,
      );
      if (s === single && i === 0) continue; // attached but has no matching execution grant
      policy.push({
        sessionId: s,
        connectionId: saved.connectionId,
        toolId: cat.tools[0].toolId,
        definition: policyDigest(definition),
        revision: saved.revision,
        arguments: args,
        safety: "read-only",
        independentInputs: true,
      });
    }
  }
  assert.notEqual(cats[0].tools[0].toolId, cats[1].tools[0].toolId);
  const turn = async (s) =>
    assert.equal(
      (
        await api("week4/sessions/" + s + "/invariant-turn", {
          turnId: randomUUID(),
          execute: true,
          provider: "openai",
          model: "fixture",
          question: "Search both selected sources for sample records.",
        })
      )[0],
      200,
    );
  const journal = (s) => "week4/sessions/" + s + "/execution-journal";
  await turn(both);
  assert.deepEqual([...results].sort(), ["North", "South"]);
  assert.equal(new Set(offered).size, 2);
  const aliases = [...offered].sort();
  const [, rows] = await api(journal(both));
  assert.equal(rows.length, 2);
  for (const row of rows) {
    const cat = cats.find((c) => c.connection.name === row.server);
    assert.equal(row.toolId, "mcp:" + cat.tools[0].toolId);
    assert.equal(row.connectionId, cat.connection.connectionId);
    assert.equal(row.attempts, 1);
    const [status, d] = await api(journal(both) + "/" + row.id);
    assert.equal(status, 200);
    assert.equal(JSON.parse(d.result).structuredContent.server, row.server);
    assert.deepEqual(JSON.parse(d.attempts[0].request).params, {
      name: "search",
      arguments: args,
    });
    assert.equal(
      JSON.parse(d.attempts[0].response).result.structuredContent.access_token,
      "[redacted]",
    );
    assert.ok(!JSON.stringify(d).includes("synthetic-private-token"));
    assert.equal((await api(journal(single) + "/" + row.id))[0], 404);
  }
  await turn(single);
  assert.deepEqual(results, ["South"]);
  await stop(server);
  server = app();
  base = await start(server);
  assert.deepEqual((await api(journal(both)))[1], rows);
  await turn(both);
  assert.deepEqual([...offered].sort(), aliases);
  assert.deepEqual([...results].sort(), ["North", "South"]);
  for (const peer of peers)
    assert.ok(peer.state.calls.filter((m) => m === "initialize").length >= 3);
  const db = new DatabaseSync(file);
  try {
    const captures = db
      .prepare(
        "SELECT capture FROM week4_checkpoints WHERE capture IS NOT NULL",
      )
      .all();
    assert.equal(captures.length, 5);
    assert.ok(!JSON.stringify(captures).includes("synthetic-private-token"));
    if (process.env.D16_SAVE_JOURNAL_FIXTURE === "1") {
      const { backup } = await import("node:sqlite");
      await backup(db, "work/final-mcp/search-fixture.sqlite");
    }
    assert.equal(
      (
        await api("week3/sessions/" + both + "/invariants", {
          text: "Never mention North.",
        })
      )[0],
      201,
    );
    const [, protectedDetail] = await api(journal(both) + "/" + rows[0].id);
    assert.ok(protectedDetail.restricted);
    assert.equal(protectedDetail.arguments, null);
    assert.equal(protectedDetail.result, null);
    assert.ok(
      protectedDetail.attempts.every(
        (a) => !a.request && !a.response && !a.returned,
      ),
    );
  } finally {
    db.close();
  }
});

test("raw capture preserves JSON spelling and never retains credential echoes or oversized or opaque payloads", async () => {
  const { sanitizedCapture } = await import("./journal-payload.mjs");
  const raw = '{  "query" : "search", "integer": 1.0 }';
  assert.equal(sanitizedCapture(raw), raw);
  assert.equal(
    sanitizedCapture('{"message":"\\u0066ixture-value-7824"}', [token]),
    null,
  );
  assert.equal(sanitizedCapture("unstructured failure"), null);
  assert.equal(
    sanitizedCapture(JSON.stringify({ bulk: "a".repeat(65536) })),
    null,
  );
  const secret = "synthetic-do-not-save";
  for (const v of [
    { headers: { authorization: secret } },
    { value: JSON.stringify({ refresh_token: secret }) },
    { note: "client_secret=" + secret },
    { access_token: secret },
    { text: "Bearer " + secret },
  ]) {
    const captured = sanitizedCapture(JSON.stringify(v));
    assert.ok(captured);
    assert.ok(!captured.includes(secret));
  }
});

test("executable source accepts only JSON data inside an operator-reviewed body", async () => {
  const {compileScope} = await import("./mcp-execution-policy.mjs");
  const {createProviderInputValidator} = await import("./provider-tool-schema.mjs");
  const prepare = createProviderInputValidator("openai");
  const grant = {argumentSchema:{type:"object",additionalProperties:false,
    properties:{code:{type:"string"}}, required:["code"]}};
  assert.equal(compileScope(grant, "execute_code", prepare, 0), undefined);
  const body = "return document.findByName(input.name);";
  grant.codeTemplate = {body,inputSchema:{type:"object",additionalProperties:false,
    properties:{name:{type:"string",maxLength:40}},required:["name"]}};
  const check = compileScope(grant, "execute_code", prepare, 0);
  const script = data => "const input = " + JSON.stringify(data) + ";\n" + body;
  assert.equal(check({code:script({name:"Review"})}),true);
  assert.equal(check({code:script({name:"Second"})}),true);
  assert.equal(check({code:script({name:"Review", other:1})}),false);
  assert.equal(check({code:script({name:"Review"}) + " extra"}),false);
  assert.equal(check({code:"const input = getInput();\n" + body}),false);
});

test("sanitized MCP evidence preserves useful fields and recognizes explicit error envelopes", async () => {
  const {normalizeMcpResult} = await import("./mcp-executor.mjs");
  const result = {content:[{type:"text",text:"Artifact at https://fixture.invalid/a/123?token=private-fixture&view=edit"}],
    structuredContent:{id:"design-123", headerText:"Delete item?",tokenCount:17, note:"owner private-fixture"}};
  const guide = normalizeMcpResult({content:[{type:"text",text:"Create a board.\nExample token: private-fixture\nRead back the board ID."}]},{},["private-fixture"]);
  assert.match(guide.content[0].text,/Create a board/);
  assert.match(guide.content[0].text,/Read back the board ID/);
  assert.ok(!guide.content[0].text.includes("private-fixture"));
  assert.throws(()=>normalizeMcpResult({content:[{type:"text",text:"Tool execution failed: Error: No instance connected."}]},{},[]),{code:"tool"});
  const output = normalizeMcpResult(result,{},["private-fixture"]);
  assert.ok(!JSON.stringify(output).includes("private-fixture"));
  assert.deepEqual(output.structuredContent,{id:"design-123",headerText:"Delete item?",tokenCount:17,note:"owner [redacted]"});
  assert.match(output.content[0].text,/a\/123.*view=edit/);
  assert.throws(()=>normalizeMcpResult({...result,structuredContent:{success:false}}, {}, []),{code:"tool"});
});

test("format warnings retain supported evidence and exclude opaque content", async () => {
  const {normalizeMcpResult} = await import("./mcp-executor.mjs");
  const {mcpResultEvidence} = await import("../src/mcp-result-evidence.ts");
  const binary = "U0VDUkVUX0ZJWFRVUkU=";
  const url = "https://fixture.invalid/design/7";
  const data = {id:"board-7",project:"Fixture project"};
  const mixed = {isError:false, structuredContent:data, content:[
    {type:"text",text:"Verified design."}, {type:"image",data:binary,mimeType:"image/png"},
    {type:"audio",data:binary,mimeType:"audio/wav"},
    {type:"resource_link",name:"Design",uri:url},
    {type:"resource",resource:{uri:"file:///fixture.bin",blob:binary}},
  ]};
  const output = normalizeMcpResult(mixed,{resultProof:value=>value.id === "board-7"},[]);
  assert.deepEqual(output.structuredContent,data);
  assert.equal(output.content[0].text,"Verified design.");
  assert.deepEqual(mcpResultEvidence(output).links,[url]);
  assert.deepEqual(output.compatibilityWarning.omitted,{image:1,audio:1,resource_link:1,resource:1});
  assert.equal(output.compatibilityWarning.evidenceIncomplete,false);
  assert.doesNotMatch(JSON.stringify(output),/U0VDUkVUX0ZJWFRVUkU|file:/);
  for (const error of [{...mixed,isError:true},{...mixed,structuredContent:{ok:false}},
    {...mixed,structuredContent:{},content:[mixed.content[1],{type:"text",text:"Tool execution failed: rejected"}]}])
    assert.throws(()=>normalizeMcpResult(error,{},[]),{code:"tool"});
  for (const invalid of [{content:[{type:"image"}]},{content:[{type:"unknown",data:binary}]},{...mixed,task:{}}])
    assert.throws(()=>normalizeMcpResult(invalid,{},[]),{code:"result"});
  assert.throws(()=>normalizeMcpResult(mixed,{resultProof:()=>false},[]),{code:"result"});
  assert.throws(()=>normalizeMcpResult(mixed,{checkOutput:()=>false},[]),{code:"result"});
});

test("MCP validation diagnostics are bounded, scrubbed, and distinct from outcome certainty", async () => {
  const {mcpFailure,normalizeMcpResult}=await import("./mcp-executor.mjs");
  const diagnostic = (text, credentials = []) => {
    try { normalizeMcpResult({isError:true,content:[{type:"text",text}]},{},credentials); }
    catch (e) { return mcpFailure("fixture",e,undefined,"response").error; }
    assert.fail("Expected a tool error");
  };
  const safe = diagnostic("[PLUGIN] Value not valid: 1204. Code: :createText\nAuthorization: Bearer sensitive-example");
  assert.match(safe.diagnostic,/Value not valid: 1204/);
  assert.doesNotMatch(safe.diagnostic,/sensitive-example|\n/);
  assert.equal(safe.code,"execution_error");
  assert.equal(diagnostic("Invalid input: fixture-secret",["fixture-secret"]).diagnostic,undefined);
  assert.equal(diagnostic("Invalid: "+"x".repeat(900)).diagnostic.length,512);
});

test("attached tools execute automatically and commit journal-backed chat replies after final model failure or the MCP tool-round limit", async t => {
  const design = await remote(t), records = await remote(t);
  const args = {code:'return draw({color:"yellow", shape:"square"});'};
  const received = [], outbound = [], observations = [];
  let nextCall = 0, scenario = "normal";
  design.state.pages = [[{name:"execute_code", description:"Draw shapes by running a design program",
    inputSchema:{type:"object", properties:{code:{type:"string"}}, required:["code"], additionalProperties:false}}]];
  records.state.pages = [[{name:"search",description:"Find work items",
    inputSchema:{type:"object",properties:{query:{type:"string"}}}}]];
  design.state.execute = params => {
    received.push(params);
    const result = scenario === "ack" ? {ok:true} : {result:{created:true, ...(scenario === "link" && {url:"https://fixture.invalid/design/42"})}};
    return {content:[{type:"text",text:JSON.stringify(result)}]};
  };
  const fakeProvider = createServer(async (req,res) => {
    let json = ""; for await (const chunk of req) json += chunk;
    const body = JSON.parse(json);
    const text = content => ({type:"message",content:[{type:"output_text",text:content}]});
    const isAnswer = body.input.some(m => typeof m.content === "string" && m.content.includes("Session catalog:"));
    const tools = (body.tools ?? []).filter(tool=>tool.name.startsWith("mcp_"));
    const returned = body.input.filter(m=>m.type==="function_call_output").at(-1);
    let result;
    if (!isAnswer) result = text('{"version":1,"facts":[],"topic":{"kind":"dialogue"}}');
    else if (returned && scenario !== "cap") {
      if (scenario === "failure" || scenario === "link") {
        res.writeHead(400,{"content-type":"application/json"});res.end('{"error":{"message":"fixture"}}');return;
      }
      observations.push({id:returned.call_id,result:JSON.parse(returned.output)});
      result = text("Design created.");
    } else {
      outbound.push({tools,choice:body.tool_choice});
      const tool = tools.find(tool=>tool.description.includes("Draw shapes"));
      result = tool ? {type:"function_call",call_id:"draw-"+(++nextCall),name:tool.name,arguments:JSON.stringify(scenario === "cap" ? {code:"draw("+nextCall+")"} : args)}
        : text("No connected drawing tool is available.");
    }
    res.writeHead(200,{"content-type":"application/json"});
    res.end(JSON.stringify({model:body.model,output:[result]}));
  });
  const providerUrl=await start(fakeProvider);
  t.after(()=>stop(fakeProvider));
  const app = createSessionServer(":memory:", {
    credentialStore:{status:async()=>true,read:async()=>"fixture-provider-only"},
    fetcher:(_url,init)=>fetch(providerUrl,init),
    catalogFetch:async()=>new Response('{"data":[]}'),
    executionOptions:{readMcpPolicy:()=>[]},
  });
  const base=await start(app);
  t.after(()=>stop(app));
  const api=async(path,body,method,interactive=false)=>{
    const res=await fetch(base+"/api/"+path,{method:method??(body?"POST":"GET"),
      headers:{"content-type":"application/json",...(interactive && {"x-day18-ui":"review",origin:base})},
      body:body && JSON.stringify(body)});
    return {status:res.status,data:await res.json()};
  };
  const session=(await api("week3/sessions",{})).data.id;
  const other=(await api("week3/sessions",{})).data.id;
  const prefix="week4/sessions/"+session;
  const turn=(id,question,interactive=true)=>api(prefix+"/invariant-turn",{turnId:id,execute:true,
    model:"gpt-5.6-terra",provider:"openai",question},undefined,interactive);
  const first=await turn(randomUUID(),"Draw a yellow square");
  assert.equal(first.status,200,JSON.stringify(first.data));
  assert.equal(outbound.at(-1).tools.length,0);
  const attached=[];
  for (const [peer,name] of [[design,"Design studio"],[records,"Work tracker"]]) {
    const saved=await api("mcp-connections",{...peer.config,name});
    const id=saved.data.connectionId;
    assert.equal((await api("mcp-connections/"+id+"/refresh",{})).status,200);
    assert.equal((await api(prefix+"/mcp-connections/"+id,undefined,"PUT")).status,200);
    attached.push(id);
  }
  // The original grant-only path: both catalogs attached, zero MCP declarations on the wire.
  assert.equal((await turn(randomUUID(),"Draw a yellow square",false)).status,200);
  assert.equal(outbound.at(-1).tools.length,0);
  for (scenario of ["normal","ack","failure","link","cap"]) {
    const id=randomUUID(), question="Draw using the attached design service.";
    const before = received.length;
    const completed=await turn(id,question);
    assert.equal(completed.status,200,JSON.stringify(completed.data));
    const rows=(await api(prefix+"/execution-journal")).data.filter(row=>row.runId===id);
    const expected=scenario === "cap" ? 16 : 1;
    assert.equal(rows.length,expected);
    assert.equal(received.length,before+expected);
    assert.ok(rows.every(row=>row.status==="Success" && row.attempts===1));
    const detail=(await api(prefix+"/execution-journal/"+rows[0].id)).data;
    assert.equal(detail.authorization,"connection auto-approve");
    assert.equal(detail.validation,"passed");
    if (scenario !== "cap") assert.deepEqual(JSON.parse(detail.arguments),args);
    const messages=(await api("week3/sessions/"+session+"/events")).data
      .filter(e=>e.type==="message" && e.payload.runId===id).map(e=>e.payload);
    assert.deepEqual(messages.map(m=>m.role),["user","assistant"]);
    assert.equal(messages[0].text,question);
    const reply=messages[1].text;
    if (scenario === "link") assert.match(reply,/https:\/\/fixture\.invalid\/design\/42/);
    else assert.match(reply,/inspect the connected document/i);
    if (scenario === "ack") assert.doesNotMatch(reply,/created|creation/i);
    if (["failure","link","cap"].includes(scenario)) {
      assert.match(reply,/Recorded tool outcomes/);
      assert.match(reply,/confirmed artifact creation/);
      assert.ok(rows.every(row=>row.runState==="PartialSuccess"));
    }
    assert.equal((await turn(id,question)).status,200);
    assert.equal(received.length,before+expected,"a lost chat response must never repeat the write");
  }
  assert.ok(outbound.some(x=>x.choice==="auto" && x.tools.length===2));
  assert.equal((await api(prefix+"/mcp-connections/"+attached[0],undefined,"DELETE")).status,200);
  const before=received.length;
  assert.equal((await turn(randomUUID(),"Draw again")).status,200);
  assert.equal(received.length,before);
  assert.equal(outbound.at(-1).tools.length,1);
  assert.equal((await api("week4/sessions/"+other+"/invariant-turn",{turnId:randomUUID(),execute:true,model:"gpt-5.6-terra",provider:"openai",question:"Draw"},undefined,true)).status,200);
  assert.equal(outbound.at(-1).tools.length,0);
});

test("a connected tracker resolves project and state, then creates a scoped item without memory extraction or per-call review", async t => {
  const tracker = await remote(t);
  const definition = (name, properties) => ({name, description: name.replaceAll("_"," "), inputSchema:{
    type:"object", properties, required:Object.keys(properties), additionalProperties:false}});
  const str = {type:"string"};
  tracker.state.pages = [[{...definition("list_projects",{}),annotations:{readOnlyHint:true}}, definition("list_states",{project:str}),
    definition("work_item",{action:str,project:str,state:str,title:str})]];
  const link = "https://tracker.fixture.invalid/items/456", title = "Verify MCP settings persistence";
  const calls = [], wire = [], returned = [], grants = [];
  tracker.state.execute = ({name,arguments:args}) => {
    calls.push({name,args});
    const result = name==="list_projects" ? {name:"Challenge",id:"project-7"}
      : name==="list_states" ? {name:"To Do",id:"state-9"} : {id:"item-456",url:link};
    return {content:[{type:"text",text:JSON.stringify(result)}],structuredContent:result};
  };
  let proposals = 0, mode = "create";
  const directory = await mkdtemp(join(tmpdir(),"d18-session-policy-"));
  const database = join(directory,"fixture.sqlite");
  const options = {
    credentialStore:{status:async()=>true,read:async()=>"fixture-only"},
    catalogFetch:async()=>Response.json({data:[]}),
    executionOptions:{readMcpPolicy:()=>grants},
    fetcher:async(_url,{body})=>{
      const payload = JSON.parse(body);
      const answer = payload.input.some(m=>m.content?.includes?.("Session catalog:"));
      const message = text=>({type:"message",content:[{type:"output_text",text}]});
      let output;
      if (!answer) {
        proposals++;
        output = message(mode === "memory-ok" ? '{"version":1,"facts":[],"topic":{"kind":"dialogue"}}'
          : '{"version":1,"facts":[],"topic":{"kind":"write","updates":[{"field":"imagined"}]}}');
      } else {
        wire.push(payload);
        const results = payload.input.filter(m=>m.type==="function_call_output");
        const observation = results.at(-1) && JSON.parse(results.at(-1).output);
        if (observation) returned.push(observation);
        const data = observation?.output?.structuredContent;
        let name, args;
        if(mode==="memory" || mode==="memory-ok") {name="use_session_memory";args={};}
        else if(mode==="internal" && !observation) {name="builtin_tax_calculator";args={amount:200,taxRate:5};}
        else if(mode==="internal" && results.length===1) {name="builtin_exchange_rate";args={fromCurrency:"USD",toCurrency:"USD"};}
        else if(mode==="internal") { /* Answer with the returned observations. */ }
        else if(mode==="read") {if (!observation) {name="list_projects";args={};}}
        else if(mode==="invalid" || mode==="unauthorized") {
          if(!observation) {name="work_item";args={action:mode==="invalid" ? "create":"delete",project:"project-7",state:"state-9",title:mode==="invalid"?42:title};}
        } else if(!results.length) {name="list_projects";args={};}
        else if(results.length===1) {name="list_states";args={project:data.id};}
        else if(results.length===2) {name="work_item";args={action:"create",project:JSON.parse(results[0].output).output.structuredContent.id,state:data.id,title};}
        const declared=payload.tools.find(t=>t.name===name || t.description.includes(" / "+name+"\n"));
        output = name && declared ? {type:"function_call",call_id:"step-"+results.length,name:declared.name,arguments:JSON.stringify(args)}
          : message(data?.url ?? "No operation completed.");
      }
      return Response.json({model:payload.model,output:[output]});
    },
  };
  let app=createSessionServer(database,options), base=await start(app);
  t.after(async()=>{await stop(app); await rm(directory,{recursive:true,force:true});});
  const api=async(path,body,method)=>{
    const res=await fetch(base+"/api/"+path,{method:method??(body?"POST":"GET"),headers:{"content-type":"application/json",origin:base,"x-day18-ui":"review"},body:body&&JSON.stringify(body)});
    return {status:res.status,data:await res.json()};
  };
  const session=(await api("week3/sessions",{})).data.id, prefix="week4/sessions/"+session;
  const conn=(await api("mcp-connections",{...tracker.config,name:"Plane fixture"})).data.connectionId;
  await api("mcp-connections/"+conn+"/refresh",{});
  await api(prefix+"/mcp-connections/"+conn,undefined,"PUT");
  const {connection,tools}=(await api("mcp-connections/"+conn)).data;
  for(const tool of tools) {
    const write=tool.originalName==="work_item";
    const schema=structuredClone(tool.document.inputSchema);
    for(const [key,value] of Object.entries({action:"create",project:"project-7",state:"state-9"})){
      if(schema.properties[key]) schema.properties[key]={type:"string",const:value};
    }
    grants.push({sessionScope:write?"attached-create":"attached-read",connectionId:conn,revision:connection.revision,
      toolId:tool.toolId,definition:policyDigest(tool.document),argumentSchema:schema,
      safety:write?"side-effecting":"read-only",independentInputs:!write});
  }
  const getGrant = name=>grants.find(g=>g.toolId===tools.find(t=>t.originalName===name).toolId);
  getGrant("work_item").requires=[invocationGrantId(getGrant("list_projects"),{}),invocationGrantId(getGrant("list_states"),{project:"project-7"})];
  const turn=(id,question)=>api(prefix+"/invariant-turn",{turnId:id,execute:true,provider:"openai",model:"gpt-5.6-terra",question});
  const id=randomUUID(),question="Create a task in the Challenge project titled 'Verify MCP settings persistence'. Set its status to To Do and return the link to the created task.";
  const memoryUrl="week3/sessions/"+session+"/memory";
  const beforeMemory=(await api(memoryUrl)).data;
  const done=await turn(id,question);
  assert.equal(done.status,200,JSON.stringify({reply:done.data,proposalRequests:proposals,answerRequests:wire.length,dispatches:calls.length}));
  assert.equal(proposals,0);
  assert.deepEqual((await api(memoryUrl)).data,beforeMemory);
  assert.deepEqual(calls.map(c=>c.name),["list_projects","list_states","work_item"]);
  assert.deepEqual(calls[2].args,{action:"create",project:"project-7",state:"state-9",title});
  assert.equal(wire.length,4); assert.equal(returned.at(-1).output.structuredContent.url,link);
  const history=(await api("week3/sessions/"+session+"/events")).data;
  assert.ok(history.some(event=>event.type==="message" && event.payload.runId===id && event.payload.role==="assistant" && event.payload.text.includes(link)));
  const journal=(await api(prefix+"/execution-journal")).data.filter(r=>r.runId===id);
  assert.deepEqual(journal.map(r=>r.status),["Success","Success","Success"]);
  const detail=(await api(prefix+"/execution-journal/"+journal[2].id)).data;
  assert.deepEqual(detail.dependencies,journal.slice(0,2).map(r=>r.id));
  assert.deepEqual(JSON.parse(detail.arguments),calls[2].args);
  assert.ok(detail.result.includes(link)); assert.equal(detail.authorization,"attached capability");
  assert.equal(detail.validation,"passed");
  for(mode of ["invalid","unauthorized"]){
    const id=randomUUID();
    assert.equal((await turn(id,"Perform the fixture operation.")).status,200);
    const failed=(await api(prefix+"/execution-journal")).data.find(r=>r.runId===id);
    const detail=(await api(prefix+"/execution-journal/"+failed.id)).data;
    assert.equal(failed.name,"work_item");
    assert.equal(failed.server,"Plane fixture");
    assert.equal(detail.error.code,mode==="invalid"?"invalid_arguments":"authorization");
    assert.equal(detail.validation,mode==="invalid"?"failed":"passed");
    assert.equal(detail.authorization,mode==="invalid"?"not evaluated":"denied");
    assert.deepEqual(detail.proposedFields.sort(),["action","project","state","title"]);
    assert.equal(detail.arguments,null);
    assert.equal(detail.attempts.length,0); assert.equal(calls.length,3);
  }
  mode="internal";
  const internalRun=randomUUID();
  assert.equal((await turn(internalRun,"Calculate tax and the exchange rate.")).status,200);
  const internal=(await api(prefix+"/execution-journal")).data.filter(row=>row.runId===internalRun);
  assert.deepEqual(internal.map(row=>[row.type,row.status]),[["function","Success"],["http","Success"]]);
  assert.equal(calls.length,3);
  assert.equal(proposals,0);
  mode="memory";
  assert.equal((await turn(randomUUID(),"Save this as a local topic card.")).status,422);
  assert.ok(proposals>0);
  assert.deepEqual((await api(memoryUrl)).data,beforeMemory);
  mode="memory-ok";
  assert.equal((await turn(randomUUID(),"Continue my local planning.")).status,200);
  assert.equal(calls.length,3);

  // A local attachment is sufficient for discovery reads, including after restart.
  grants.length=0;
  mode="read";
  assert.equal((await turn(randomUUID(),"Which projects can I use?")).status,200);
  await stop(app);
  app=createSessionServer(database,options);
  base=await start(app);
  const second=randomUUID();
  assert.equal((await turn(second,"List the available projects again.")).status,200);
  const savedRead=(await api(prefix+"/execution-journal")).data.find(row=>row.runId===second);
  assert.equal(savedRead.status,"Success",JSON.stringify((await api(prefix+"/execution-journal/"+savedRead.id)).data));
  assert.equal((await api(prefix+"/execution-journal/"+savedRead.id)).data.authorization,"connection auto-approve");
  await api(prefix+"/mcp-connections/"+conn,undefined,"DELETE");
  assert.equal(calls.length,5);
});

test("an attached creation capability requires a pinned action and the reviewed catalog revision", () => {
  const schema = {type:"object", properties:{action:{type:"string"}, title:{type:"string"}},
    required:["action","title"], additionalProperties:false};
  const document = {name:"items", inputSchema:schema};
  const row = {connectionId:randomUUID(), toolId:randomUUID(), revision:2, document:JSON.stringify(document)};
  const grant = {connectionId:row.connectionId, toolId:row.toolId, revision:2, definition:policyDigest(document),
    sessionScope:"attached-create", safety:"side-effecting", argumentSchema:schema};
  const load = proposal => readGrants(row,()=>[proposal],randomUUID());
  assert.deepEqual(load(grant),[]);
  const pinned = {...schema, properties:{...schema.properties, action:{type:"string",const:"create"}}};
  const allowed = {...grant, argumentSchema:pinned};
  assert.deepEqual(load(allowed),[allowed]);
  assert.deepEqual(load({...allowed, revision:1}),[]);
  assert.deepEqual(load({...allowed, argumentSchema:{...pinned,required:["title"]}}),[]);
  assert.deepEqual(load({...allowed, sessionScope:"attached-read"}),[]);
  assert.deepEqual(load({...allowed, codeTemplate:{body:"arbitrary"}}),[]);
});

test("session operation permissions authorize four dynamic calls without review and isolate restricted actions", async t => {
  const tracker = await remote(t);
  const str = {type:"string"};
  const definition = (name, actions, properties) => ({
    name, description:"Synthetic tracker operation",
    inputSchema:{type:"object", required:["action"], additionalProperties:false,
      properties:{action:{type:"string",enum:actions},...properties}}
  });
  tracker.state.pages = [[definition("project",["list"],{}),
    definition("state",["list"],{project_id:str}),
    definition("workitem",["create","retrieve","delete","manage_permissions"],{project_id:str,name:str,state:str,workitem_id:str})]];
  const title = "Тест пройден", link = "https://tracker.fixture.invalid/items/123";
  const calls = [];
  tracker.state.execute = ({name,arguments:args}) => {
    calls.push([name,args]);
    const data = name === "project" ? {name:"Challenge",id:"p-7"} :
      name === "state" ? {name:"To Do",id:"s-9"} :
      args.action === "create" ? {id:"item-123"} : {id:"item-123",url:link};
    return {content:[{type:"text",text:JSON.stringify(data)}],structuredContent:data};
  };
  let restricted;
  const directory = await mkdtemp(join(tmpdir(),"d18-session-operation-"));
  const database = join(directory,"fixture.sqlite");
  const deployment = [];
  const options = {
    credentialStore:{status:async()=>true,read:async()=>"fixture-only"},
    catalogFetch:async()=>Response.json({data:[]}),
    executionOptions:{readMcpPolicy:()=>deployment},
    fetcher:async(_url,{body})=>{
      const payload = JSON.parse(body);
      assert.ok(payload.input.some(m=>m.content?.includes?.("Session catalog:")));
      const observations = payload.input.filter(m=>m.type==="function_call_output").map(m=>JSON.parse(m.output));
      const data = observations.map(o=>o.output?.structuredContent);
      let name, args;
      if(restricted && !observations.length){ name="workitem"; args=restricted; }
      else if(!restricted){
        switch(observations.length){
          case 0: name="project"; args={action:"list"}; break;
          case 1: name="state"; args={action:"list",project_id:data[0].id}; break;
          case 2: name="workitem"; args={action:"create",project_id:data[0].id,state:data[1].id,name:title}; break;
          case 3: name="workitem"; args={action:"retrieve",project_id:data[0].id,workitem_id:data[2].id}; break;
        }
      }
      const output = name ? {type:"function_call",call_id:"step-"+observations.length,
        name:payload.tools.find(t=>t.description.includes(" / "+name+"\n")).name,arguments:JSON.stringify(args)} :
        {type:"message",content:[{type:"output_text",text:data.at(-1)?.url??"No operation completed."}]};
      return Response.json({model:payload.model,output:[output]});
    }
  };
  let app=createSessionServer(database,options), base=await start(app);
  t.after(async()=>{await stop(app);await rm(directory,{recursive:true,force:true});});
  async function api(path,body,method,ui="review"){
    const response=await fetch(base+"/api/"+path,{method:method??(body?"POST":"GET"),
      headers:{origin:base,"x-day18-ui":ui,"content-type":"application/json"},body:body&&JSON.stringify(body)});
    return {status:response.status,data:await response.json()};
  }
  const conn=(await api("mcp-connections",{...tracker.config,name:"Test tracker"})).data.connectionId;
  await api("mcp-connections/"+conn+"/refresh",{});
  async function session(){
    const prefix="week4/sessions/"+(await api("week3/sessions",{})).data.id;
    assert.equal((await api(prefix+"/mcp-connections/"+conn,undefined,"PUT")).status,200);
    return prefix;
  }
  const prefix=await session(), other=await session();
  const permissions=prefix+"/mcp-connections/"+conn+"/permissions";
  const read=()=>api(permissions,undefined,"GET","permissions");
  const initial=(await read()).data;
  assert.deepEqual(initial.selected,[]);
  const fields={ "project:list":[], "state:list":["project_id"], "workitem:create":["project_id","state","name"],
    "workitem:retrieve":["project_id","workitem_id"] };
  const selected=initial.options.map(o=>({toolId:o.toolId,action:o.action,fields:fields[o.name+":"+o.action],
    ...(o.name==="workitem" && o.action==="create" && {fixed:{project_id:"p-7"}})}));
  assert.equal(selected.length,4);
  const save=(items,ui="permissions")=>api(permissions,{revision:initial.revision,selected:items},"PUT",ui);
  assert.equal((await save(selected,"review")).status,403);
  for(const action of ["delete","manage_permissions","invented"])
    assert.equal((await save([{...selected.at(-1),action}])).status,400);
  assert.equal((await save(selected)).status,200);
  assert.equal((await save([])).status,409);
  await stop(app);app=createSessionServer(database,options);base=await start(app);
  assert.equal((await read()).data.selected.length,4);
  async function run(scope){
    const id=randomUUID(), prompts=[];
    const question="Создай в Plane задачу с названием «Тест пройден» в проекте Challenge, установи статус To Do и пришли ссылку на созданную задачу.";
    let done=false;
    const turn=api(scope+"/invariant-turn",{turnId:id,execute:true,provider:"openai",model:"gpt-5.6-terra",question}).finally(()=>{done=true;});
    while(!done){
      const path=scope+"/mcp-review/"+id;
      const review=(await api(path,{})).data.review;
      if(review){prompts.push(review.tool);await api(path,{decision:"deny",id:review.id});}
      if(!done)await new Promise(resolve=>setTimeout(resolve,15));
    }
    assert.equal((await turn).status,200);
    const rows=(await api(scope+"/execution-journal")).data.filter(r=>r.runId===id);
    const details=await Promise.all(rows.map(async r=>(await api(scope+"/execution-journal/"+r.id)).data));
    return {id,prompts,details,rows};
  }
  const success=await run(prefix);
  assert.deepEqual(success.prompts,[]);
  assert.deepEqual(calls,[["project",{action:"list"}],["state",{action:"list",project_id:"p-7"}],
    ["workitem",{action:"create",project_id:"p-7",state:"s-9",name:title}],
    ["workitem",{action:"retrieve",project_id:"p-7",workitem_id:"item-123"}]]);
  assert.equal(success.details.length,4);
  for(const [i,row] of success.details.entries()){
    assert.equal(success.rows[i].status,"Success");assert.equal(row.authorization,"session grant");assert.equal(row.validation,"passed");
    assert.deepEqual(JSON.parse(row.arguments),calls[i][1]);assert.equal(row.attempts.length,1);
  }
  assert.ok(success.details.at(-1).result.includes(link));
  const history=(await api(prefix.replace("week4","week3")+"/events")).data;
  assert.ok(history.some(e=>e.type==="message" && e.payload.runId===success.id && e.payload.role==="assistant" && e.payload.text.includes(link)));
  for(const [scope,args] of [[prefix,{action:"delete",workitem_id:"item-123"}],
    [prefix,{action:"create",project_id:"outside-scope",name:title}]]){
    restricted=args;
    const denied=await run(scope);
    assert.deepEqual(denied.prompts,[]);
    assert.equal(denied.details[0].error.code,"authorization");
    assert.equal(denied.details[0].attempts.length,0);
  }
  restricted={action:"create",project_id:42};
  const invalid=await run(prefix);
  assert.deepEqual(invalid.prompts,[]);assert.equal(invalid.details[0].error.code,"invalid_arguments");
  assert.equal(calls.length,4);
  deployment.push({});assert.equal((await read()).status,403);deployment.pop();
  await api(prefix+"/mcp-connections/"+conn,undefined,"DELETE");
  assert.equal((await read()).status,404);
  await api(prefix+"/mcp-connections/"+conn,undefined,"PUT");
  assert.deepEqual((await read()).data.selected,[]);
});

test("connection Auto-approve runs scoped CRUD and design tools without review across restart", async (t) => {
  const tracker = await remote(t),
    design = await remote(t);
  const text = { type: "string" };
  function definition(name, properties, required) {
    return {
      name,
      description: "Local integration fixture",
      inputSchema: {
        type: "object",
        properties,
        required,
        additionalProperties: false,
      },
    };
  }
  const item = definition(
    "workitem",
    {
      action: { type: "string", enum: ["create", "update", "delete", "projects", "states"] },
      id: text,
      title: text,
    },
    ["action"],
  );
  tracker.state.pages = [[item, definition("workspace_admin", {}, [])]];
  design.state.pages = [[definition("execute_code", { code: text }, ["code"])]];
  const directory = await mkdtemp(join(tmpdir(), "d18-auto-mode-"));
  const db = join(directory, "fixture.sqlite"),
    items = new Map(),
    dispatched = [];
  const link = "https://tracker.fixture.invalid/items/471",
    id = "fixture-471";
  function result(data) {
    return {
      structuredContent: data,
      content: [{ type: "text", text: JSON.stringify(data) }],
    };
  }
  tracker.state.execute = ({ name, arguments: args }) => {
    dispatched.push([name, args]);
    if (args.action === "projects") return result({project:"Fixture project"});
    if (args.action === "states") return result({state:"To Do"});
    if (args.id === "unconfirmed") return { drop: true };
    if (args.action === "create") items.set(id, args.title);
    else if (args.id !== id || !items.has(id))
      return {
        isError: true,
        content: [{ type: "text", text: "Missing fixture item" }],
      };
    else if (args.action === "update") items.set(id, args.title);
    else if (args.action === "delete") items.delete(id);
    return result({
      id,
      url: link,
      title: items.get(id),
      deleted: !items.has(id),
      apiKey: "private-fixture-canary",
    });
  };
  design.state.execute = ({ name, arguments: args }) => {
    dispatched.push([name, args]);
    if (args.code === "export fixture") return {
      content:[{type:"image",mimeType:"image/png",data:"U1lOVEhFVElDX0JJTkFSWQ=="}],
    };
    if (args.code === "verify fixture") return result({reference:"shape-321",url:"https://design.fixture.invalid/321"});
    return result({ reference: "shape-321" });
  };
  let scenario = "workflow",
    beforeCall,
    base;
  const deployment = [],
    declarations = [];
  const options = {
    credentialStore: {
      status: async () => true,
      read: async () => "fixture-only",
    },
    catalogFetch: async () => Response.json({ data: [] }),
    executionOptions: { readMcpPolicy: () => deployment },
    fetcher: async (_url, { body }) => {
      const payload = JSON.parse(body),
        results = payload.input
          .filter((m) => m.type === "function_call_output")
          .map((m) => JSON.parse(m.output));
      if (
        !payload.input.some((m) => m.content?.includes?.("Session catalog:"))
      ) {
        return Response.json({
          model: payload.model,
          output: [
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify({
                    version: 1,
                    facts: [],
                    topic: { kind: "dialogue" },
                  }),
                },
              ],
            },
          ],
        });
      }
      const names = Object.fromEntries(
        (payload.tools ?? [])
          .filter((t) => t.name.startsWith("mcp_"))
          .map((t) => [
            t.description.split("\n")[0].split(" / ").at(-1),
            t.name,
          ]),
      );
      declarations.push(Object.keys(names));
      const data = results.at(-1)?.output?.structuredContent;
      let tool, args;
      if (scenario === "optional-format") {
        switch (results.length) {
          case 0: tool="execute_code"; args={code:"create fixture design"}; break;
          case 1: assert.equal(data.reference,"shape-321"); tool="execute_code"; args={code:"verify fixture"}; break;
          case 2: assert.ok(data.url); tool="execute_code"; args={code:"export fixture"}; break;
          case 3:
            assert.equal(results[2].outcome,"Success");
            assert.equal(results[2].output.compatibilityWarning.code,"unsupported_content");
            assert.deepEqual(results[2].output.content,[]);
            tool="workitem"; args={action:"projects"}; break;
          case 4: assert.equal(data.project,"Fixture project"); tool="workitem"; args={action:"states"}; break;
          case 5:
          case 6: // A repeated model proposal must reuse the first write receipt.
            tool="workitem";
            args={action:"create",title:[results[1].output.structuredContent.url,
              results[3].output.structuredContent.project,results[4].output.structuredContent.state,
              "Preview unavailable"].join(" · ")};
            break;
        }
      } else if (scenario === "resume-probe") {
        if (!results.length) {tool="execute_code";args={code:"inspect fixture"};}
        else if (results.length === 1) {tool="workitem";args={action:"delete",id:"unconfirmed"};}
      } else if (scenario === "probe-only" && !results.length) {
        tool="execute_code";args={code:"inspect fixture"};
      } else if (scenario === "workflow") {
        switch (results.length) {
          case 0:
            tool = "workitem";
            args = { action: "create", title: "Original" };
            break;
          case 1:
            tool = "execute_code";
            args = { code: "draw(" + JSON.stringify(data.id) + ")" };
            break;
          case 2:
            tool = "workitem";
            args = {
              action: "update",
              id: results[0].output.structuredContent.id,
              title: data.reference,
            };
            break;
          case 3:
            tool = "workitem";
            args = { action: "delete", id: data.id };
            break;
        }
      } else if (!results.length && scenario !== "inspect") {
        tool = "workitem";
        args = {
          action: "delete",
          id:
            scenario === "invalid"
              ? 12
              : scenario === "uncertain"
                ? "unconfirmed"
                : id,
        };
      }
      if (beforeCall) {
        const fn = beforeCall;
        beforeCall = undefined;
        await fn();
      }
      const output = tool
        ? {
            type: "function_call",
            call_id: "step-" + results.length,
            name: names[tool],
            arguments: JSON.stringify(args),
          }
        : {
            type: "message",
            content: [
              { type: "output_text", text: data?.url ?? "Fixture finished." },
            ],
          };
      return Response.json({ model: payload.model, output: [output] });
    },
  };
  let app = createSessionServer(db, options);
  base = await start(app);
  t.after(async () => {
    await stop(app);
    await rm(directory, { recursive: true, force: true });
  });
  async function api(path, body, method, ui = "review") {
    const res = await fetch(base + "/api/" + path, {
      method: method ?? (body ? "POST" : "GET"),
      headers: {
        origin: base,
        "x-day18-ui": ui,
        "content-type": "application/json",
      },
      body: body && JSON.stringify(body),
    });
    return { status: res.status, data: await res.json() };
  }
  const prefix = "week4/sessions/" + (await api("week3/sessions", {})).data.id;
  async function configure(fixture, name, tool) {
    const connection = (
      await api("mcp-connections", { ...fixture.config, name })
    ).data.connectionId;
    const path = "mcp-connections/" + connection + "/execution-mode";
    await api("mcp-connections/" + connection + "/refresh", {});
    await api(prefix + "/mcp-connections/" + connection, undefined, "PUT");
    const read = async () =>
      (await api(path, undefined, "GET", "execution-mode")).data;
    const put = (body, ui = "execution-mode") => api(path, body, "PUT", ui);
    const settings = await read();
    assert.equal(settings.mode, "attached");
    const toolId = settings.tools.find((t) => t.name === tool).id;
    const body = {
      revision: settings.revision,
      mode: "auto",
      toolIds: [toolId],
    };
    assert.equal((await put(body, "review")).status, 403);
    assert.equal((await put({ ...body, toolIds: [randomUUID()] })).status, 400);
    assert.equal((await put(body)).status, 200);
    assert.equal((await put(body)).status, 409);
    return { connection, toolId, read, put };
  }
  const trackerConfig = await configure(tracker, "Tracker fixture", "workitem");
  await configure(design, "Design fixture", "execute_code");
  await stop(app);
  app = createSessionServer(db, options);
  base = await start(app);
  assert.deepEqual(
    (await trackerConfig.read()).tools
      .filter((t) => t.approved)
      .map((t) => t.name),
    ["workitem"],
  );
  async function run(session = prefix) {
    declarations.length = 0;
    const turnId = randomUUID();
    let done = false;
    const pending = api(session + "/invariant-turn", {
      turnId,
      execute: true,
      provider: "openai",
      model: "gpt-5.6-terra",
      question: "Use the attached services to process the fixture task.",
    }).finally(() => {
      done = true;
    });
    // Observe the same review endpoint as the UI. Never submit approval decisions.
    while (!done) {
      const poll = await api(session + "/mcp-review/" + turnId, {});
      assert.ok(!poll.data.review, "unexpected per-call approval");
      if (!done) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const turn = await pending;
    assert.equal(turn.status, 200, JSON.stringify(turn.data));
    const rows = (await api(session + "/execution-journal")).data.filter(
      (row) => row.runId === turnId,
    );
    return Promise.all(
      rows.map(async (row) => ({
        ...row,
        ...(await api(session + "/execution-journal/" + row.id)).data,
      })),
    );
  }
  const rows = await run();
  assert.equal(items.size, 0);
  assert.deepEqual(dispatched, [
    ["workitem", { action: "create", title: "Original" }],
    ["execute_code", { code: 'draw("fixture-471")' }],
    ["workitem", { action: "update", id, title: "shape-321" }],
    ["workitem", { action: "delete", id }],
  ]);
  assert.equal(rows.length, 4);
  for (const [index, row] of rows.entries()) {
    assert.equal(row.status, "Success");
    assert.equal(row.authorization, "connection auto-approve");
    assert.equal(row.validation, "passed");
    assert.equal(row.attempts.length, 1);
    assert.deepEqual(JSON.parse(row.arguments), dispatched[index][1]);
  }
  assert.ok(rows[0].result.includes(link));
  assert.ok(rows[1].result.includes("shape-321"));
  assert.ok(!JSON.stringify(rows).includes("private-fixture-canary"));
  assert.ok(declarations.every((names) => !names.includes("workspace_admin")));
  scenario = "invalid";
  const [invalid] = await run();
  assert.equal(invalid.error.code, "invalid_arguments");
  assert.equal(invalid.attempts.length, 0);
  assert.deepEqual(JSON.parse(invalid.proposedArguments), {action:"delete", id:"[withheld]"});
  scenario = "inspect";
  const other = "week4/sessions/" + (await api("week3/sessions", {})).data.id;
  await run(other);
  assert.deepEqual(declarations[0], []);
  deployment.push({});
  await run();
  assert.deepEqual(declarations[0], []);
  deployment.pop();
  const mode = await trackerConfig.read();
  scenario = "revoke";
  beforeCall = async () =>
    assert.equal(
      (
        await trackerConfig.put({
          revision: mode.revision,
          mode: "auto",
          toolIds: [],
        })
      ).status,
      200,
    );
  const [revoked] = await run();
  assert.equal(revoked.error.code, "authorization");
  assert.equal(revoked.attempts.length, 0);
  assert.equal(dispatched.length, 4);

  // A narrower session grant continues to constrain an approved multiplexed tool.
  const current = await trackerConfig.read();
  await trackerConfig.put({
    revision: current.revision,
    mode: "auto",
    toolIds: [trackerConfig.toolId],
  });
  const permissionPath =
    prefix + "/mcp-connections/" + trackerConfig.connection + "/permissions";
  const settings = (await api(permissionPath, undefined, "GET", "permissions"))
    .data;
  const grant = {
    toolId: trackerConfig.toolId,
    action: "create",
    fields: ["title"],
  };
  assert.equal(
    (
      await api(
        permissionPath,
        { revision: settings.revision, selected: [grant] },
        "PUT",
        "permissions",
      )
    ).status,
    200,
  );
  const [denied] = await run();
  assert.equal(denied.error.code, "authorization");
  assert.equal(dispatched.length, 4);

  const connection = (await api("mcp-connections/" + trackerConfig.connection))
    .data.connection;
  deployment.push({
    sessionId: prefix.split("/").at(-1),
    connectionId: connection.connectionId,
    toolId: trackerConfig.toolId,
    revision: connection.revision,
    definition: policyDigest(item),
    safety: "side-effecting",
    arguments: { action: "delete", id },
  });
  const [intersection] = await run();
  assert.equal(intersection.error.code, "authorization");
  assert.equal(intersection.attempts.length, 0);
  deployment.pop();
  const limited = (await api(permissionPath, undefined, "GET", "permissions"))
    .data;
  assert.equal(limited.inherit, false);
  assert.equal(
    (
      await api(
        permissionPath,
        { revision: limited.revision, inherit: true, selected: [] },
        "PUT",
        "permissions",
      )
    ).status,
    200,
  );
  assert.equal(
    (await api(permissionPath, undefined, "GET", "permissions")).data.inherit,
    true,
  );
  // The remote fixture now rejects deletion of the already deleted item.
  const [missing] = await run();
  assert.equal(missing.error.code, "execution_error");
  assert.equal(missing.status,"Failed");
  assert.equal(missing.error.reportedFailure,true);
  assert.equal(missing.error.certainty,"unknown");
  assert.equal(missing.runState,"RequiresReview");
  assert.equal(missing.attempts.length, 1);
  assert.equal(missing.authorization, "connection auto-approve");
  assert.equal(dispatched.length, 5);

  scenario = "resume-probe";
  const [probe,lost] = await run();
  assert.equal(probe.status,"Success");
  assert.equal(probe.runState,"RequiresReview");
  scenario = "probe-only";
  const [revisited] = await run();
  assert.equal(revisited.status,"Success");
  assert.equal(revisited.authorization,"connection auto-approve");
  scenario = "uncertain";
  assert.equal(lost.status, "Unknown");
  assert.equal(lost.attempts.length, 1);
  const [repeat] = await run();
  assert.equal(repeat.status, "Failed");
  assert.equal(repeat.attempts.length, 0);
  assert.equal(dispatched.length, 8);

  await t.test("an optional image allows an ordinary two-service workflow to finish once", async () => {
    scenario = "optional-format";
    const offset = dispatched.length;
    const entries = await run();
    assert.deepEqual(dispatched.slice(offset).map(([,args]) => args.code ?? args.action),
      ["create fixture design","verify fixture","export fixture","projects","states","create"]);
    assert.equal(items.size,1);
    assert.equal(items.get(id),"https://design.fixture.invalid/321 · Fixture project · To Do · Preview unavailable");
    assert.equal(entries.length,6);
    assert.ok(entries.every(row => row.status === "Success" && row.runState === "Completed" &&
      row.authorization === "connection auto-approve" && row.attempts.length === 1));
    assert.deepEqual(entries.map(entry=>entry.hasWarning),[false,false,true,false,false,false]);
    const preview = JSON.parse(entries[2].result);
    assert.deepEqual(preview.compatibilityWarning.omitted,{image:1});
    assert.doesNotMatch(JSON.stringify(entries),/U1lOVEhFVElDX0JJTkFSWQ/);
  });
  tracker.state.pages[0][0] = { ...item, description: "Changed contract" };
  await api("mcp-connections/" + trackerConfig.connection + "/refresh", {});
  assert.ok((await trackerConfig.read()).tools.every((t) => !t.approved));
  tracker.state.pages[0][0] = item;
  await api("mcp-connections/" + trackerConfig.connection + "/refresh", {});
  assert.ok((await trackerConfig.read()).tools.every((t) => !t.approved));
});

test("restored memory grounds an MCP workflow through consolidation and sequential re-proposals", async t => {
  const directory = await mkdtemp(join(tmpdir(), "d18-recall-action-"));
  const database = join(directory, "fixture.sqlite");
  const saved = "The original design is named Cedar.";
  const analysis = "Use the horizontal layout.";
  const preference = "High contrast";
  const recent = "Use the review queue.";
  const question = "Use the earlier horizontal-layout analysis to verify the document and file its task.";
  const final = "Created the implementation task for Cedar.";
  const wire = [], dispatched = [], maintenance = [];
  const peers = [];
  for (const name of ["Design", "Tracker"]) {
    const peer = await remote(t);
    peer.state.pages = [[{name:"submit", description:name, inputSchema:{
      type:"object", properties:{note:{type:"string"}}, required:["note"],
    }}]];
    peer.state.execute = ({arguments:args}) => {
      dispatched.push([name,args.note]);
      return {content:[{type:"text",text:name+" verified"}]};
    };
    peers.push(peer);
  }
  let phase = "setup";
  const options = {
    credentialStore:{status:async()=>true, read:async()=>"fixture-only"},
    catalogFetch:async()=>Response.json({data:[]}),
    executionOptions:{readMcpPolicy:()=>[]},
    fetcher:async (_url,{body}) => {
      const payload = JSON.parse(body);
      const inputs = payload.input;
      const text = content=>({type:"message",content:[{type:"output_text",text:content}]});
      let output;
      if (phase === "setup") {
        output = [text(inputs.at(-1).content === "Analyze the mockup" ? analysis + " detail".repeat(1800) : recent)];
      } else if (!inputs.some(m=>m.content?.includes?.("Session catalog:"))) {
        maintenance.push(inputs);
        output = [text(inputs[0].content.startsWith("Summarize") ? saved+" "+analysis :
          inputs[0].content.startsWith("Review") ? '{"preserved":true}' : '{"facts":[]}')];
      } else {
        wire.push(payload);
        const call = (name, call_id, args) => ({type:"function_call",name,call_id,arguments:JSON.stringify(args)});
        const service = (name,id) => call(payload.tools.find(t=>t.description.startsWith(name+" / ")).name,id,{note:analysis});
        switch (wire.length) {
          case 1: output = [call("use_session_memory","memory",{continue_with_services:true})]; break;
          case 2: output = [service("Design","batch-design"),service("Tracker","batch-task")]; break;
          case 3: output = [service("Design","verify")]; break;
          case 4: output = [service("Tracker","create")]; break;
          default: output = [text(final)];
        }
      }
      return Response.json({model:payload.model,output});
    },
  };
  let app = createSessionServer(database,options), base = await start(app);
  t.after(async()=>{await stop(app); await rm(directory,{recursive:true,force:true});});
  async function api(path,body,method) {
    const res=await fetch(base+"/api/"+path,{method:method??(body?"POST":"GET"),
      headers:{"content-type":"application/json",origin:base,"x-day18-ui":"execute"},body:body && JSON.stringify(body)});
    const data=await res.json(); assert.equal(res.ok,true,JSON.stringify(data)); return data;
  }
  const {id:session} = await api("week3/sessions",{});
  const prefix = "week4/sessions/"+session;
  for (const [i,name] of ["Design","Tracker"].entries()) {
    const {connectionId} = await api("mcp-connections",{...peers[i].config,name});
    await api("mcp-connections/"+connectionId+"/refresh",{});
    await api(prefix+"/mcp-connections/"+connectionId,undefined,"PUT");
  }
  const turn = (question,id=randomUUID())=>api(prefix+"/invariant-turn",{turnId:id,question,model:"gpt-5.6-terra",provider:"openai",execute:true});
  await turn("Analyze the mockup");
  await turn("Where should the task go?");
  await stop(app);
  const db = new DatabaseSync(database);
  try {
    db.prepare("INSERT OR REPLACE INTO week3_session_memory(sessionId,revision,data) VALUES(?,1,?)").run(session,JSON.stringify({
      facts:[{subject:"Interface",attribute:"contrast",value:preference,status:"confirmed",sources:["fixture"]}],
      covered:[],extracted:[],buffer:[],short:[],summary:saved,
    }));
  } finally { db.close(); }
  app=createSessionServer(database,options); base=await start(app);
  phase="continue";
  const id=randomUUID();
  await turn(question,id);
  assert.equal(wire.length,5);
  for (const body of wire) {
    assert.equal(body.input.filter(m=>m.role==="user" && m.content===question).length,1);
    const content=body.input.map(m=>m.content ?? "").join("\n");
    for (const expected of [saved,preference,recent]) assert.ok(content.includes(expected),expected);
    assert.ok(content.includes(analysis));
  }
  assert.ok(maintenance.some(messages=>messages[0].content.startsWith("Review")));
  assert.deepEqual(dispatched,[["Design",analysis],["Tracker",analysis]]);
  const rows=(await api(prefix+"/execution-journal")).filter(r=>r.runId===id);
  assert.deepEqual(rows.map(r=>[r.status,r.attempts]),[["Skipped",0],["Skipped",0],["Success",1],["Success",1]]);
  assert.ok(rows.every(row=>row.runState==="Completed"));
  for (const row of rows.slice(0,2)) {
    const detail=await api(prefix+"/execution-journal/"+row.id);
    assert.equal(detail.error.skipReason,"batch_independence_unproven");
    assert.equal(detail.error.toolCallId,row.id);
    assert.deepEqual(detail.dependencies,[]);
  }
  assert.deepEqual(wire[2].input.filter(m=>m.type==="function_call_output").map(m=>JSON.parse(m.output).error.skipReason),
    ["batch_independence_unproven","batch_independence_unproven"]);
  const events=await api("week3/sessions/"+session+"/events");
  assert.deepEqual(events.filter(e=>e.type==="tool-result" && e.payload.runId===id).map(e=>e.payload.status),
    ["skipped","skipped","completed","completed"]);
  assert.equal(events.filter(e=>e.type==="message" && e.payload.runId===id).at(-1).payload.text,final);
  await turn(question,id);
  assert.equal(dispatched.length,2);
});

test("Week 4 backend commands and disconnected chat clients finish through the same authorized runtime", {timeout: 20000}, async t => {
  const peer = await remote(t);
  const dir = await mkdtemp(join(tmpdir(), "d18-backend-command-"));
  const file = join(dir, "sessions.sqlite");
  const policy = [];
  let gate, detectorCalls = 0;
  const args = {query: "fixture record"};
  const definition = {name: "lookup", description: "Find a fixture record",
    inputSchema: {type: "object", properties: {query: {type: "string"}}, required: ["query"]}};
  peer.state.pages = [[definition]];
  peer.state.execute = async params => {
    assert.deepEqual(params, {name: "lookup", arguments: args});
    if (gate) { gate.entered.resolve(); await gate.release.promise; }
    return {content: [{type: "text", text: "record-42"}]};
  };
  const mock = createDevManagerMock("fixture");
  function application() {
    return createSessionServer(file, {
      executionOptions: {readMcpPolicy: () => policy},
      invariantAdapter: () => ({...mock, async complete(input) {
        if (input.memoryProposal || input.messages[0]?.content.startsWith("Review a proposed")) return mock.complete(input);
        const last = input.messages.at(-1);
        if (last.role === "tool") {
          assert.match(last.content, /record-42/);
          return {text: "Found record-42."};
        }
        const tool = input.tools.find(item => item.kind === "mcp");
        if (!tool) return {text: "No authorized lookup."};
        return {toolCalls: [{id: "lookup-call", toolId: tool.id,
          providerName: "mcp_" + tool.toolId.replaceAll("-", ""), arguments: args}]};
      }}),
      instructionDetector: {providerId: "openai", model: "gpt-5.6-terra"},
      instructionDetectorTransport: async () => {
        detectorCalls++;
        return {status: 200, body: {output: [{type: "message", content: [{type: "output_text", text: '{"operations":[]}'}]}]}};
      },
    });
  }
  let app = application(), base = await start(app);
  const db = new DatabaseSync(file);
  t.after(async () => {
    gate?.release.resolve();
    if (app.listening) await stop(app);
    db.close();
    await rm(dir, {recursive: true});
  });
  async function api(path, body, method) {
    const res = await fetch(base + "/api/" + path, {method: method ?? (body ? "POST" : "GET"),
      headers: {"content-type": "application/json"}, body: body && JSON.stringify(body)});
    assert.ok(res.ok, String(res.status));
    return res.json();
  }
  const profile = await api("users", {name: "Fixture", habits: "* Answer briefly."});
  const chat = (await api("week3/sessions", {profileId: profile.id})).id;
  const other = (await api("week3/sessions", {})).id;
  const conn = await api("mcp-connections", peer.config);
  await api("mcp-connections/" + conn.connectionId + "/refresh", {});
  const [tool] = (await api("mcp-connections/" + conn.connectionId)).tools;
  for (const session of [chat, other])
    await api("week4/sessions/" + session + "/mcp-connections/" + conn.connectionId, undefined, "PUT");
  policy.push({sessionId: chat, connectionId: conn.connectionId, toolId: tool.toolId,
    definition: policyDigest(definition), revision: conn.revision, arguments: args, safety: "read-only"});
  await stop(app);
  app = application(); // This instance has no inbound HTTP listener.
  const command = () => ({turnId: randomUUID(), provider: "openai", model: "fixture", question: "Find the fixture record."});
  const direct = command();
  assert.equal(app.listening, false);
  const receipt = await app.executeWeek4Turn(chat, direct);
  assert.equal(receipt.status, "completed");
  assert.equal(receipt.instructionOutcome.status, "unchanged");
  assert.equal(detectorCalls, 1);
  await app.executeWeek4Turn(chat, direct);
  await assert.rejects(app.executeWeek4Turn(chat, {...direct, question: "Different command"}), {status: 409});
  await assert.rejects(app.executeWeek4Turn(chat, {...command(), interactive: true}), {status: 400});
  await assert.rejects(app.executeWeek4Turn(randomUUID(), command()), {status: 404});
  await app.executeWeek4Turn(other, command());
  const calls = () => peer.state.calls.filter(method => method === "tools/call").length;
  assert.equal(calls(), 1);
  assert.equal(detectorCalls, 1);
  base = await start(app);
  gate = {entered: Promise.withResolvers(), release: Promise.withResolvers()};
  const detached = command(), client = new AbortController();
  const submitted = fetch(base + "/api/week4/sessions/" + chat + "/invariant-turn", {
    method: "POST", headers: {"content-type": "application/json", "x-day18-ui": "execute"},
    body: JSON.stringify({...detached, execute: true}), signal: client.signal,
  });
  try {
    await Promise.race([gate.entered.promise, submitted.then(r => { throw Error("Premature reply: " + r.status); })]);
    client.abort();
    await assert.rejects(submitted, {name: "AbortError"});
    await assert.rejects(app.executeWeek4Turn(chat, command()), {status: 409});
  } finally { gate.release.resolve(); }
  const finished = db.prepare("SELECT answer FROM week4_runs WHERE id=?");
  for (let n = 0; n < 200 && (finished.get(detached.turnId)?.answer !== "delivered" || detectorCalls < 2); n++)
    await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(finished.get(detached.turnId)?.answer, "delivered");
  assert.equal(detectorCalls, 2);
  await stop(app);
  app = application();
  base = await start(app);
  const rows = await api("week4/sessions/" + chat + "/execution-journal");
  const history = await api("week3/sessions/" + chat + "/events");
  const {restoreHistory} = await import("../src/conversation-history.ts");
  const {createManagerConversation} = await import("../src/manager-agent.ts");
  const initial = createManagerConversation("Reopened chat");
  initial.conversation.id = chat;
  const restored = restoreHistory(initial, history);
  for (const {turnId} of [direct, detached]) {
    const operations = rows.filter(row => row.runId === turnId);
    assert.equal(operations.length, 1);
    assert.equal(operations[0].status, "Success");
    assert.equal(operations[0].attempts, 1);
    assert.equal(restored.messages.filter(m => m.runId === turnId && m.role === "user").length, 1);
    assert.equal(restored.messages.filter(m => m.runId === turnId && m.text === "Found record-42.").length, 1);
  }
  await app.executeWeek4Turn(chat, detached);
  assert.equal(calls(), 2);
  assert.equal(detectorCalls, 2);
  await api("week3/sessions/" + chat + "/invariants", {text: "Never mention Instagram.", enabled: true});
  await assert.rejects(app.executeWeek4Turn(chat, {...command(), question: "Напиши Instagram."}), {status: 422});
  assert.equal(calls(), 2);
});

test(
  "scheduled occurrences persist, claim once, narrow dispatch and recover uncertain writes for review",
  { timeout: 20000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "d18-occurrence-"));
    const file = join(dir, "main.sqlite"),
      crashFile = join(dir, "interrupted.sqlite");
    const peer = await remote(t);
    const definition = (name) => ({
      name,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    });
    peer.state.pages = [[definition("record"), definition("other")]];
    let dispatches = 0,
      gate,
      modelGate;
    peer.state.execute = async ({ name }) => {
      assert.equal(name, "record");
      dispatches++;
      if (gate) {
        gate.enter.resolve();
        await gate.release.promise;
      }
      return { content: [{ type: "text", text: "Recorded fixture 42." }] };
    };
    const policy = [],
      offered = [];
    const mock = createDevManagerMock("fixture");
    const open = (path, offset = 0) =>
      createSessionServer(path, {
        // The original backend exercises manual Step 2 admission. On the crash
        // snapshot the automatic engine must also respect the review hold.
        schedulerOptions: { pollMs: offset ? 10 : 60000 },
        executionOptions: { readMcpPolicy: () => policy, now: () => Date.now() + offset },
        invariantAdapter: () => ({
          ...mock,
          async complete(input) {
            if (input.memoryProposal || input.messages[0]?.content.startsWith("Review a proposed"))
              return mock.complete(input);
            if (input.messages.at(-1).role === "tool") return { text: "Fixture operation finished." };
            const tools = input.tools.filter((t) => t.kind === "mcp");
            offered.push(tools.map((t) => t.toolId));
            if (modelGate) {
              modelGate.enter.resolve();
              await modelGate.release.promise;
            }
            if (!tools.length) return { text: "No external capabilities." };
            const tool = tools[0];
            return {
              toolCalls: [
                {
                  id: "fixture-call",
                  toolId: tool.id,
                  providerName: "mcp_" + tool.toolId.replaceAll("-", ""),
                  arguments: {},
                },
              ],
            };
          },
        }),
      });
    let app = open(file),
      base = await start(app);
    const db = new DatabaseSync(file);
    const instances = [app];
    t.after(async () => {
      gate?.release.resolve();
      modelGate?.release.resolve();
      for (const server of instances) if (server.listening) await stop(server);
      db.close();
      await rm(dir, { recursive: true });
    });
    async function api(path, body, method) {
      const r = await fetch(base + "/api/" + path, {
        method: method ?? (body ? "POST" : "GET"),
        headers: { "content-type": "application/json" },
        body: body && JSON.stringify(body),
      });
      assert.ok(r.ok, String(r.status));
      return r.json();
    }
    const session = (await api("week3/sessions", {})).id,
      other = (await api("week3/sessions", {})).id;
    const conn = await api("mcp-connections", peer.config);
    await api("mcp-connections/" + conn.connectionId + "/refresh", {});
    const tools = (await api("mcp-connections/" + conn.connectionId)).tools;
    for (const s of [session, other])
      await api("week4/sessions/" + s + "/mcp-connections/" + conn.connectionId, undefined, "PUT");
    for (const tool of tools)
      policy.push({
        schedulerScope:true,
        connectionId: conn.connectionId,
        toolId: tool.toolId,
        definition: policyDigest(tool.document),
        revision: conn.revision,
        arguments: {},
        safety: "side-effecting",
      });
    const due = Date.now() - 10000;
    const permission = {
      connectionId: conn.connectionId,
      toolId: tools.find((t) => t.originalName === "record").toolId,
    };
    const def = {
      instructions: "Record the fixture.",
      provider: "openai",
      model: "fixture",
      timezone: "America/Toronto",
      schedule: { kind: "interval", startAt: due, everyMs: 1000 },
      enabled: false,
      permissions: [permission],
    };
    let tasks = app.scheduledTasks;
    assert.throws(() => tasks.createTask({ ...def, sessionId: other }), { status: 400 });
    assert.throws(() => tasks.createTask({ ...def, timezone: "not/a/zone" }), { status: 400 });
    const task = tasks.start(tasks.createTask(def).id);
    assert.deepEqual(task.permissions, [permission]);
    assert.throws(
      () => tasks.configure(task.id, task.revision, { permissions: [permission, permission] }),
      { status: 400 },
    );
    assert.deepEqual(tasks.getTask(task.id), task);
    const id = tasks.materialize(task.id, due);
    assert.equal(id, tasks.materialize(task.id, due));
    assert.throws(() => tasks.materialize(task.id, due + 1), { status: 400 });
    const future = tasks.materialize(task.id, due + 86400000);
    await assert.rejects(tasks.executeOccurrence(future), { status: 409 });
    assert.equal(tasks.getOccurrence(future).state, "Pending");
    await stop(app);
    app = open(file);
    instances.push(app);
    base = await start(app);
    tasks = app.scheduledTasks;
    assert.deepEqual(tasks.getTask(task.id), task);
    assert.equal(tasks.getOccurrence(id).state, "Pending");
    const command = { turnId: id, provider: def.provider, model: def.model, question: def.instructions };
    await assert.rejects(app.executeWeek4Turn(session, command), { status: 403 });
    await assert.rejects(app.executeWeek4Turn(other, command), { status: 403 });
    const second = open(file);
    instances.push(second);
    await start(second);
    assert.equal(second.scheduledTasks.materialize(task.id, due), id);
    gate = { enter: Promise.withResolvers(), release: Promise.withResolvers() };
    const first = tasks.executeOccurrence(id);
    try {
      await Promise.race([
        gate.enter.promise,
        first.then((r) => {
          throw Error("Unexpected early occurrence: " + r.state);
        }),
      ]);
      assert.deepEqual(offered.at(-1), [permission.toolId]);
      assert.equal((await second.scheduledTasks.executeOccurrence(id)).state, "Running");
      assert.equal(dispatches, 1);
      // Snapshot exactly after remote dispatch, before the response or local result.
      db.prepare("VACUUM INTO ?").run(crashFile);
    } finally {
      gate.release.resolve();
    }
    const result = await first;
    assert.equal(result.state, "Completed");
    assert.ok(result.started_at <= result.finished_at);
    assert.equal(result.result.answer, "delivered");
    assert.deepEqual(await tasks.executeOccurrence(id),result);
    assert.equal(result.response,"Fixture operation finished.");
    const recovered = open(crashFile, 120000);
    instances.push(recovered);
    await start(recovered);
    for (
      let n = 0;
      n < 200 && recovered.scheduledTasks.getOccurrence(id).state !== "RequiresReview";
      n++
    )
      await new Promise((r) => setTimeout(r, 10));
    assert.equal((await recovered.scheduledTasks.executeOccurrence(id)).state, "RequiresReview");
    const crash = new DatabaseSync(crashFile);
    try {
      await new Promise(resolve => setTimeout(resolve, 50));
      assert.equal(crash.prepare("SELECT count(*) AS n FROM week4_runs").get().n, 1);
      assert.equal(
        crash.prepare("SELECT state FROM week4_operations WHERE run_id=? AND kind='tool'").get(id).state,
        "Unknown",
      );
      const svc=recovered.scheduledTasks;
      svc.stop(task.id);
      assert.throws(()=>svc.start(task.id),{status:409});
      const revision=svc.getTask(task.id).revision;
      assert.throws(()=>svc.review(task.id,{confirmed:false,revision,occurrenceIds:[id]}),{status:409});
      svc.review(task.id,{confirmed:true,revision,occurrenceIds:[id]});
      assert.equal(svc.getTask(task.id).stopped,true);
      assert.equal(svc.getOccurrence(id).state,"RequiresReview");
      assert.equal(crash.prepare("SELECT count(*) AS n FROM week4_runs").get().n,1);
    } finally {
      crash.close();
    }
    assert.equal(dispatches, 1);

    const revoked = tasks.materialize(task.id, due + 1000);
    modelGate = { enter: Promise.withResolvers(), release: Promise.withResolvers() };
    const race = tasks.executeOccurrence(revoked);
    try {
      await Promise.race([
        modelGate.enter.promise,
        race.then(() => {
          throw Error("Expected provider call");
        }),
      ]);
      second.scheduledTasks.configure(task.id, task.revision, { permissions: [] });
    } finally {
      modelGate.release.resolve();
    }
    assert.equal((await race).state, "Failed");
    assert.equal(dispatches, 1);
    assert.throws(() => tasks.configure(task.id, task.revision, { enabled: true }), { status: 409 });
    modelGate = null;
    const none = tasks.materialize(task.id, due + 2000);
    assert.equal((await tasks.executeOccurrence(none)).state, "Completed");
    assert.deepEqual(offered.at(-1), []);
    const again = tasks.configure(task.id, tasks.getTask(task.id).revision, {
      permissions: [permission],
    });
    const denied = tasks.materialize(task.id, due + 3000);
    const [removed] = policy.splice(
      policy.findIndex((g) => g.toolId === permission.toolId),
      1,
    );
    assert.equal((await tasks.executeOccurrence(denied)).error, "authorization");
    assert.equal(tasks.getOccurrence(denied).started_at, null);
    policy.push(removed);
    assert.equal((await tasks.executeOccurrence(denied)).state, "Failed");
    assert.equal(dispatches, 1);
    await api(
      "week4/sessions/" + session + "/mcp-connections/" + conn.connectionId,
      undefined,
      "DELETE",
    );
    assert.equal(tasks.getTask(task.id).enabled,true);
    assert.equal(tasks.getTask(task.id).revision,again.revision);
    const once = tasks.createTask({
      ...def,
      instructions: "Напиши Instagram.",
      permissions: [],
      schedule: { kind: "once", at: due },
    });
    await api("week3/sessions/" + session + "/invariants", {
      text: "Never mention Instagram.",
      enabled: true,
    });
    tasks.start(once.id);
    const blocked = await tasks.executeOccurrence(tasks.materialize(once.id, due));
    assert.equal(blocked.state, "Completed");
    assert.equal(dispatches, 1);
    await stop(app);
    app = open(file);
    instances.push(app);
    base = await start(app);
    assert.deepEqual(await app.scheduledTasks.executeOccurrence(id), result);
    assert.equal(app.scheduledTasks.getOccurrence(denied).error, "authorization");
    assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  },
);

test("failed journal admission rolls back the claim and chat and profile deletion preserve independent tasks", async t => {
  const dir = await mkdtemp(join(tmpdir(), "d18-task-admission-"));
  const file = join(dir, "session.sqlite");
  let inferences = 0;
  const server = createSessionServer(file, {
    invariantAdapter: () => { inferences++; throw Error("Unexpected inference"); },
  });
  const base = await start(server);
  const db = new DatabaseSync(file);
  t.after(async () => { await stop(server); db.close(); await rm(dir, {recursive:true}); });
  async function create(path, body) {
    const response = await fetch(base + "/api/" + path, {
      method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify(body),
    });
    assert.ok(response.ok);
    return (await response.json()).id;
  }
  const profileId = await create("users", {name:"Disposable scheduled task owner"});
  const tasks = server.scheduledTasks;
  const definition = {instructions:"Summarize today's activity.", provider:"openai", model:"fixture",
    schedule:{kind:"once", at:0}, timezone:"UTC", enabled:false};
  await create("week3/sessions",{profileId});
  const task=tasks.createTask(definition);
  const survivor = tasks.createTask(definition);
  tasks.start(task.id);
  const occurrence = tasks.materialize(task.id, 0);
  db.exec("CREATE TRIGGER fixture_failed_admission BEFORE INSERT ON week4_runs BEGIN SELECT RAISE(ABORT,'fixture fault'); END");
  const outcome = await tasks.executeOccurrence(occurrence);
  assert.equal(outcome.state, "Failed");
  assert.equal(outcome.started_at, null);
  assert.equal(outcome.error, "execution_error");
  assert.equal(db.prepare("SELECT count(*) AS n FROM week4_runs WHERE id=?").get(occurrence).n, 0);
  assert.equal(inferences, 0);
  db.exec("DROP TRIGGER fixture_failed_admission");
  assert.deepEqual(await tasks.executeOccurrence(occurrence), outcome);
  assert.equal((await fetch(base + "/api/users/" + profileId,{method:"DELETE"})).status, 200);
  assert.deepEqual(tasks.getOccurrence(occurrence),outcome);
  assert.equal(tasks.getTask(task.id).id,task.id);
  assert.deepEqual(tasks.getTask(survivor.id), survivor);
});

test("fresh task consent selects tools across two global servers without a chat or a deployment grant",async t=>{
  const dir=await mkdtemp(join(tmpdir(),"d18-task-catalog-")), file=join(dir,"fixture.sqlite");
  const servers=await Promise.all([remote(t),remote(t)]), called=[];
  for(const [i,peer] of servers.entries()){
    peer.state.pages=[[{name:"lookup",inputSchema:{type:"object",properties:{},additionalProperties:false}}]];
    peer.state.execute=()=>{called.push(i);return {content:[{type:"text",text:"Observation "+i}]};};
  }
  let expected=0;
  const app=createSessionServer(file,{schedulerOptions:{pollMs:60000},executionOptions:{readMcpPolicy:()=>[]},
    invariantAdapter:()=>({complete:async input=>{
      const tools=input.tools.filter(t=>t.kind==="mcp");
      assert.equal(tools.length,expected);
      const calledIds=input.messages.filter(m=>m.role==="tool").map(m=>m.toolCallId);
      const next=tools.find(t=>!calledIds.includes(t.toolId));
      return next?{toolCalls:[{id:next.toolId,toolId:next.id,providerName:"mcp_"+next.toolId.replaceAll("-",""),arguments:{}}]}:{text:"Summary complete."};
    }})});
  const base=await start(app);
  t.after(async()=>{await stop(app);await rm(dir,{recursive:true});});
  const headers={"x-day18-ui":"scheduler",origin:base,"content-type":"application/json"};
  async function api(path,body){const res=await fetch(base+"/api/"+path,{method:body?"POST":"GET",headers,body:body&&JSON.stringify(body)});assert.ok(res.ok,String(res.status));return res.json();}
  for(const [i,peer] of servers.entries()){
    const c=await api("mcp-connections",{...peer.config,name:"Fixture "+i});
    await api("mcp-connections/"+c.connectionId+"/refresh",{});
  }
  const catalog=await api("scheduler/catalog");
  assert.equal(catalog.length,2);assert.ok(catalog.every(t=>t.eligible&&t.name==="lookup"));
  const permissions=catalog.map(({connectionId,toolId,definition,revision})=>({connectionId,toolId,definition,revision}));
  for(expected of [0,1,2]){
    const at=Date.now()-10;
    const task=await api("scheduler/tasks",{name:"Inspect",instructions:"Inspect selected services.",provider:"openai",model:"fixture",timezone:"UTC",schedule:{kind:"once",at},permissions:permissions.slice(0,expected),authorized:expected>0,enabled:false});
    app.scheduledTasks.start(task.id);const id=app.scheduledTasks.materialize(task.id,at);
    assert.equal((await app.scheduledTasks.executeOccurrence(id)).state,"Completed");
    const journal=await api("scheduler/tasks/"+task.id+"/history/"+id+"/journal");
    assert.equal(journal.length,expected);assert.ok(journal.every(t=>t.status==="Success"));
  }
  assert.equal(called.length,3);assert.equal(new Set(called).size,2);
  assert.deepEqual(await api("week3/sessions"),[]);
});
