import test from "node:test";
import { createDevManagerMock } from "../src/dev-manager-mock.ts";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createSessionServer } from "./sessions.mjs";
import { discoverServer } from "./mcp-discovery.mjs";
import { createMcpConnectionManager } from "./mcp-connection-manager.mjs";
import { createMcpRepository } from "./mcp-repository.mjs";
import { createSessionMcpRoutes } from "./session-mcp-connections.mjs";
import { resourceWatchPolicy } from "./mcp-resource-watch-store.mjs";

const uri = "example:documents/one",
  other = "example:documents/two";
// Legacy grant-only deployments opt out of the laboratory default.
const timing = {
  defaultAutomaticWatching: false,
  watchSweepMs: 25,
  watchRetryMs: 25,
  watchReconcileMs: 60000,
  discoveryMs: 1000,
};
async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return "http://127.0.0.1:" + server.address().port;
}
async function until(check) {
  for (let i = 0; i < 200; i++) {
    const value = check();
    if (value) return value;
    await delay(20);
  }
  assert.fail("Expected state was not reached");
}
async function stop(server) {
  const closed = once(server, "close");
  server.close();
  server.closeAllConnections();
  await closed;
}

// A stateful local MCP peer with actual Streamable HTTP POSTs and a standalone
// SSE stream per negotiated session. Only subscribed sessions get updates.
async function peer(
  t,
  caps = { resources: { subscribe: true, listChanged: true } },
  legacy = false,
) {
  const clients = new Map(),
    calls = [];
  const state = {
    caps,
    text: "first",
    resourceText: new Map(),
    listed: [uri, other],
    tools: ["lookup"],
    blocks: [],
    calls,
    clients,
  };
  const server = createServer(async (req, res) => {
    const id =
        req.headers["mcp-session-id"] ??
        new URL(req.url, "http://localhost").searchParams.get("channel"),
      client = clients.get(id);
    if (req.method === "DELETE") {
      client?.stream?.end();
      clients.delete(id);
      res.writeHead(200).end();
      return;
    }
    if (req.method === "GET") {
      if (legacy) {
        const channel = randomUUID();
        clients.set(channel, { stream: res, sub: new Set() });
        res.on("close", () => clients.delete(channel));
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(
          "event: endpoint\ndata: /messages?channel=" + channel + "\n\n",
        );
        return;
      }
      if (!client || state.noStream) {
        res.writeHead(405).end();
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": listening\n\n");
      client.stream = res;
      return;
    }
    let body = "";
    for await (const part of req) body += part;
    const rpc = JSON.parse(body),
      method = rpc.method;
    calls.push({ method, uri: rpc.params?.uri });
    if (state.offline) { res.writeHead(503).end(); return; }
    const headers = { "content-type": "application/json" };
    let result;
    if (method === "initialize") {
      const session = randomUUID();
      if (!legacy) clients.set(session, { sub: new Set() });
      headers["mcp-session-id"] = session;
      result = {
        protocolVersion: rpc.params.protocolVersion,
        capabilities: state.caps,
        serverInfo: { name: "fixture", version: "1" },
      };
    } else if (method === "notifications/initialized") {
      res.writeHead(202).end();
      return;
    } else if (method === "tools/list")
      result = { tools: state.tools.map(name => ({ name, inputSchema: { type: "object", properties:{}, additionalProperties:false } })) };
    else if (method === "resources/list") {
      if (state.badList) {
        res.writeHead(503).end();
        return;
      }
      const index = Number(rpc.params?.cursor ?? 0);
      result = {
        resources: state.listed
          .slice(index, index + 1)
          .map((uri) => ({ uri, name: uri })),
        ...(index + 1 < state.listed.length && {
          nextCursor: String(index + 1),
        }),
      };
    } else if (method === "resources/subscribe") {
      client.sub.add(rpc.params.uri);
      result = {};
    } else if (method === "resources/unsubscribe") {
      client.sub.delete(rpc.params.uri);
      result = {};
    } else if (method === "resources/read") {
      if (state.deny) {
        res.writeHead(403).end();
        return;
      }
      if (state.hold && (!state.holdUri || state.holdUri === rpc.params.uri)) await state.hold;
      result = { contents: [{ uri: rpc.params.uri, text: state.resourceText.get(rpc.params.uri) ?? state.text }] };
    } else if (method === "tools/call") result = state.call ? state.call(rpc.params) : { content: state.blocks };
    else {
      res.writeHead(400).end();
      return;
    }
    const data = JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result });
    if (legacy) {
      res.writeHead(202).end();
      client.stream.write("event: message\ndata: " + data + "\n\n");
    } else res.writeHead(200, headers).end(data);
  });
  const url = await listen(server);
  t.after(() => stop(server));
  state.config = {
    name: "Resource fixture",
    description: "",
    transport: legacy ? "sse" : "streamable-http",
    auth: { type: "none" },
    endpoint: url + "/mcp",
  };
  state.notify = (target = uri) => {
    for (const c of clients.values())
      if (c.sub.has(target))
        c.stream?.write(
          "event: message\ndata: " +
            JSON.stringify({
              jsonrpc: "2.0",
              method: "notifications/resources/updated",
              params: { uri: target },
            }) +
            "\n\n",
        );
  };
  state.count = (m) => calls.filter((c) => c.method === m).length;
  return state;
}

test("tools, resource pages, subscription and catalog-change capabilities negotiate independently", async (t) => {
  const p = await peer(t);
  for (const caps of [
    { tools: { listChanged: true } },
    { resources: {} },
    { resources: { listChanged: true } },
    { resources: { subscribe: true } },
    { tools: {}, resources: { subscribe: true, listChanged: true } },
    {},
  ]) {
    p.caps = caps;
    p.calls.length = 0;
    const result = await discoverServer(p.config, []);
    assert.deepEqual(result.capabilities, {
      tools: !!caps.tools,
      toolsListChanged: !!caps.tools?.listChanged,
      resources: !!caps.resources,
      resourcesListChanged: !!caps.resources?.listChanged,
      subscribe: !!caps.resources?.subscribe,
    });
    assert.equal(result.tools.length, Number(!!caps.tools));
    assert.equal(result.resources.length, caps.resources ? 2 : 0);
    assert.equal(p.count("resources/list"), caps.resources ? 2 : 0);
    assert.equal(p.count("tools/list"), Number(!!caps.tools));
    assert.equal(p.count("resources/subscribe"), 0);
  }
  p.caps = { resources: {}, tools: {} };
  p.badList = true;
  const result = await discoverServer(p.config, []);
  assert.equal(result.tools[0].name, "lookup");
  assert.equal(result.resources, null);
  assert.ok(result.resourceError);
});

test("resource-only backend receives background events, reconciles reconnect and restores SQLite checkpoint on restart", async (t) => {
  const p = await peer(t),
    dir = await mkdtemp(join(tmpdir(), "d18-watches-")),
    path = join(dir, "test.sqlite");
  let backend, db, origin;
  async function boot(watchPolicy) {
    backend = createSessionServer(path, {
      mcpOptions: { ...timing, watchPolicy },
      credentialStore: {},
    });
    origin = await listen(backend);
    db = new DatabaseSync(path);
  }
  async function down() {
    await stop(backend);
    backend = null;
    db.close();
  }
  t.after(async () => {
    if (backend) await down();
    await rm(dir, { recursive: true, force: true });
  });
  await boot([]);
  const api = async (path, method = "GET", body) => {
    const r = await fetch(origin + "/api/mcp-connections" + path, {
      method,
      headers: { "content-type": "application/json" },
      body: body && JSON.stringify(body),
    });
    assert.ok(r.ok);
    return r.json();
  };
  const c = await api("", "POST", p.config);
  await api("/" + c.connectionId + "/refresh", "POST");
  const catalog = await api("/" + c.connectionId);
  assert.equal(catalog.connection.capabilities.subscribe, true);
  assert.equal(catalog.resources.length, 2);
  assert.equal(catalog.connection.sseObserved, true);
  assert.equal(catalog.connection.sseActive, false);
  assert.equal(p.count("resources/subscribe"), 0);
  const inbox = (suffix="",method="GET")=>fetch(origin+"/api/notifications"+suffix,{method,headers:{"X-Day18-UI":"notifications"}});
  assert.equal((await fetch(origin+"/api/notifications")).status,403);
  assert.equal((await inbox("?limit=999")).status,400);
  const grants = [{ connectionId: c.connectionId, revision: 1, uri }];
  await down();
  await boot(grants);
  const events = () =>
    db
      .prepare(
        "SELECT kind,content,sequence FROM mcp_resource_notifications ORDER BY id",
      )
      .all();
  const active = () =>
    db
      .prepare("SELECT * FROM mcp_resource_watches WHERE status='active'")
      .get();
  await until(active);
  assert.equal(events().length, 0);
  p.text = "second";
  p.notify();
  p.notify();
  await until(() => events().length === 1);
  p.notify();
  await delay(60);
  assert.equal(events().length, 1);
  p.text = "first";
  p.notify();
  await until(() => events().length === 2);
  p.text = "offline change";
  for (const c of p.clients.values()) if (c.sub.has(uri)) c.stream.destroy();
  await until(() => events().length === 3);
  assert.equal(events()[2].kind, "reconciled");
  const first = await (await inbox("?limit=1")).json();
  assert.equal(first.unread,3);
  assert.equal(first.items[0].kind,"reconciled");
  const older = await (await inbox("?limit=1&before="+first.next)).json();
  assert.ok(older.items[0].id < first.items[0].id);
  for (let i=0;i<2;i++) assert.equal((await (await inbox("/"+older.items[0].id+"/read","PUT")).json()).unread,2);
  const id = active().id;
  await down();
  p.text = "restart change";
  await boot(grants);
  await until(() => events().length === 4);
  assert.equal(active().id, id);
  assert.equal(events()[3].kind, "reconciled");
  assert.equal(events()[3].sequence, 4);
  assert.equal((await (await inbox("/unread")).json()).unread,3);
  for(let i=0;i<2;i++) assert.equal((await (await inbox("/read-all?through="+first.through,"PUT")).json()).unread,1);
  assert.equal((await (await inbox()).json()).items[0].readAt,null);
  assert.equal((await api("/"+c.connectionId)).connection.sseObserved,true);
  assert.equal((await api("/"+c.connectionId)).connection.sseActive,true);
  assert.equal(p.count("tools/call"), 0);
  assert.equal(db.prepare("SELECT count(*) n FROM week4_runs").get().n, 0);
  // Losing access pauses this listener; the timer must not retry credentials.
  p.deny = true;
  p.notify();
  await until(
    () =>
      db.prepare("SELECT status FROM mcp_resource_watches").get().status ===
      "suspended",
  );
  assert.equal((await (await inbox()).json()).items.length,0);
  assert.equal((await inbox("/"+older.items[0].id+"/read","PUT")).status,404);
  const reads = p.count("resources/read");
  await delay(100);
  assert.equal(p.count("resources/read"), reads);
  const failedPage = await (await inbox()).json();
  assert.equal(failedPage.subscriptions[0].status,"Failed");
  assert.equal(failedPage.subscriptions[0].uri,null);
  assert.equal((await inbox("/subscriptions/"+id,"DELETE")).status,200);
  assert.equal((await (await inbox()).json()).items.length,0);
});

test("typed references require an authorized tool, attached chat and matching connection; detach fences a pending read", async (t) => {
  const p = await peer(t, { tools: {}, resources: { subscribe: true } });
  const db = new DatabaseSync(":memory:");
  db.exec(
    "PRAGMA foreign_keys=ON; CREATE TABLE week3_sessions(id TEXT PRIMARY KEY)",
  );
  const repo = createMcpRepository(db);
  createSessionMcpRoutes(db);
  let manager = createMcpConnectionManager(db, {}, timing);
  t.after(async () => {
    await manager.close();
    db.close();
  });
  const c = await manager.save(undefined, p.config);
  await manager.refresh(c.connectionId);
  const tool = manager.catalog(c.connectionId).tools[0],
    a = randomUUID(),
    b = randomUUID();
  for (const s of [a, b]) {
    db.prepare("INSERT INTO week3_sessions VALUES(?)").run(s);
    db.prepare("INSERT INTO session_mcp_connections VALUES(?,?)").run(
      s,
      c.connectionId,
    );
  }
  await manager.close();
  const grant = {
    connectionId: c.connectionId,
    toolId: tool.toolId,
    sessionId: a,
    revision: c.revision,
  };
  manager = createMcpConnectionManager(
    db,
    {},
    { ...timing, watchPolicy: [grant] },
  );
  const call = async (sessionId, toolCallId) =>
    manager.execute(
      {
        ...grant,
        sessionId,
        toolCallId,
        originalName: "lookup",
        safety: "read-only",
        arguments: {},
        grantId: "fixture",
      },
      new AbortController().signal,
      () => true,
    );
  const watches = () => db.prepare("SELECT * FROM mcp_resource_watches").all();
  p.blocks = [
    {
      type: "text",
      text: '{"taskId":"example:invented","url":"example:wrong"}',
    },
  ];
  assert.ok((await call(a, randomUUID())).ok);
  assert.equal(watches().length, 0);
  p.blocks = [{ type: "resource", resource: {uri, text: "embedded"} }];
  assert.ok((await call(a, randomUUID())).ok);
  assert.equal(watches().length, 0);
  assert.equal(manager.catalog(c.connectionId).tools[0].resourceLinksObserved, false);
  p.blocks = [{ type: "resource_link", name: "ref", uri }];
  assert.equal((await call(b, randomUUID())).output.compatibilityWarning.omitted.resource_link,1);
  assert.equal(manager.catalog(c.connectionId).tools[0].resourceLinksObserved,true);
  assert.equal(watches().length, 0);
  const callId = randomUUID();
  const consumed=await call(a,callId);
  assert.equal(consumed.output.watchedResourceLinks,1);
  assert.equal(consumed.output.compatibilityWarning,undefined);
  assert.equal(consumed.output.evidenceIncomplete,true);
  assert.ok(manager.catalog(c.connectionId).tools[0].watchEnabled);
  await until(() => watches()[0]?.status === "active");
  assert.equal(watches()[0].scope, a);
  assert.equal(watches()[0].uri, uri);
  assert.equal(
    db.prepare("SELECT call_id FROM mcp_watch_origins").get().call_id,
    callId,
  );
  p.blocks.push({type:"image",data:"YQ==",mimeType:"image/png"});
  assert.deepEqual((await call(a,callId)).output.compatibilityWarning.omitted,{image:1});
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM mcp_watch_origins").get().n,
    1,
  );
  p.text = '{"token":"synthetic-hidden","state":"ready"}';
  p.notify();
  await until(() =>
    db.prepare("SELECT content FROM mcp_resource_notifications").get(),
  );
  assert.equal(
    db.prepare("SELECT content FROM mcp_resource_notifications").get().content,
    '{"token":"[redacted]","state":"ready"}',
  );
  db.exec("CREATE TABLE session_invariants(session_id TEXT,enabled INTEGER)");
  db.prepare("INSERT INTO session_invariants VALUES(?,1)").run("week3:" + a);
  p.text = "Protected chat contents";
  p.notify();
  await until(() =>
    db
      .prepare("SELECT id FROM mcp_resource_notifications WHERE sequence=2")
      .get(),
  );
  assert.equal(
    db
      .prepare(
        "SELECT content FROM mcp_resource_notifications WHERE sequence=2",
      )
      .get().content,
    null,
  );
  const gate = Promise.withResolvers();
  p.hold = gate.promise;
  const count = p.count("resources/read");
  p.notify();
  await until(() => p.count("resources/read") > count);
  db.prepare("DELETE FROM session_mcp_connections WHERE session_id=?").run(a);
  manager.updateWatches();
  gate.resolve();
  await delay(70);
  assert.equal(watches().length, 0);
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM mcp_resource_notifications").get().n,
    2,
  );
  assert.equal(
    [...p.clients.values()].some((c) => c.sub.has(uri)),
    false,
  );
  // A saved off overrides even the old chat-specific grant. A saved on
  // still requires an attached chat and a safe typed link.
  db.prepare("INSERT INTO session_mcp_connections VALUES(?,?)").run(a,c.connectionId);
  manager.configureWatching(c.connectionId,tool.toolId,c.revision,false);
  p.blocks = [{type:"resource_link",name:"new",uri:other}];
  assert.equal((await call(a,randomUUID())).output.watchedResourceLinks,undefined);
  manager.configureWatching(c.connectionId,tool.toolId,c.revision,true);
  db.prepare("DELETE FROM session_mcp_connections WHERE session_id=?").run(a);
  assert.equal((await call(a,randomUUID())).output.watchedResourceLinks,undefined);
  p.blocks = [{type:"resource_link",name:"unsafe",uri:"https://demo@example.invalid/private"}];
  assert.equal((await call(b,randomUUID())).output.watchedResourceLinks,undefined);
  assert.equal(watches().length,0);
  assert.throws(() =>
    resourceWatchPolicy([{ ...grant, sessionId: undefined }]),
  );
});

test("two connections advertising the same URI remain isolated; HTTP 405 uses authorized snapshot reconciliation", async (t) => {
  const a = await peer(t),
    b = await peer(t);
  a.noStream = true;
  b.config.name = "Other fixture";
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  let manager = createMcpConnectionManager(db, {}, timing);
  t.after(async () => {
    await manager.close();
    db.close();
  });
  const configs = [];
  for (const p of [a, b]) {
    const c = await manager.save(undefined, p.config);
    await manager.refresh(c.connectionId);
    configs.push(c);
  }
  await manager.close();
  const grants = configs.map((c) => ({
    connectionId: c.connectionId,
    revision: c.revision,
    uri,
  }));
  manager = createMcpConnectionManager(
    db,
    {},
    { ...timing, watchReconcileMs: 60, watchPolicy: grants },
  );
  const status = (id) =>
    db
      .prepare("SELECT status FROM mcp_resource_watches WHERE connection_id=?")
      .get(id)?.status;
  await until(
    () =>
      status(configs[0].connectionId) === "polling" &&
      status(configs[1].connectionId) === "active",
  );
  a.text = "changed with no stream";
  b.text = "changed from push";
  b.notify();
  const events = () =>
    db
      .prepare(
        "SELECT connection_id,content,source_name FROM mcp_resource_notifications",
      )
      .all();
  await until(() => events().length === 2);
  assert.deepEqual(
    events()
      .map((e) => [e.connection_id, e.content])
      .sort(),
    [
      [configs[0].connectionId, a.text],
      [configs[1].connectionId, b.text],
    ].sort(),
  );
  await manager.remove(configs[0].connectionId, 1);
  await until(() => !a.clients.size);
  assert.equal(events().length, 2);
  assert.ok(events().some(e => e.connection_id === configs[0].connectionId));
  b.text = "still connected";
  b.notify();
  await until(() => events().length === 3);
  assert.equal(events()[2].connection_id, configs[1].connectionId);
});

test("a failed tool listing does not hide a working resource catalog", async (t) => {
  const p = await peer(t, { tools: {}, resources: { subscribe: true } });
  const result = await discoverServer(p.config, [], {
    fetcher: async (url, init) => {
      if (init.body && JSON.parse(init.body).method === "tools/list")
        return new Response("", { status: 503 });
      return fetch(url, init);
    },
  });
  assert.equal(result.tools, null);
  assert.ok(result.toolFailure);
  assert.deepEqual(
    result.resources.map((r) => r.uri),
    [uri, other],
  );
  assert.equal(result.resourceError, null);
});

test("legacy SSE watches receive updates and refresh the resource catalog on advertised list changes", async (t) => {
  const p = await peer(
    t,
    { resources: { subscribe: true, listChanged: true } },
    true,
  );
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  let manager = createMcpConnectionManager(db, {}, timing);
  t.after(async () => {
    await manager.close();
    db.close();
  });
  const c = await manager.save(undefined, p.config);
  await manager.refresh(c.connectionId);
  await manager.close();
  const grants = [uri, other].map((uri) => ({
    connectionId: c.connectionId,
    revision: 1,
    uri,
  }));
  manager = createMcpConnectionManager(
    db,
    {},
    { ...timing, watchPolicy: grants },
  );
  await until(
    () =>
      db
        .prepare(
          "SELECT count(*) n FROM mcp_resource_watches WHERE status='active'",
        )
        .get().n === 2,
  );
  p.text = "legacy update";
  p.notify(other);
  await until(
    () =>
      db
        .prepare("SELECT content FROM mcp_resource_notifications WHERE uri=?")
        .get(other)?.content === p.text,
  );
  p.listed = [other];
  for (const c of p.clients.values())
    c.stream.write(
      'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/resources/list_changed"}\n\n',
    );
  await until(() => manager.catalog(c.connectionId).resources.length === 1);
  await until(() => p.count("resources/unsubscribe") === 1);
  assert.equal(
    db.prepare("SELECT status FROM mcp_resource_watches WHERE uri=?").get(uri)
      .status,
    "suspended",
  );
});

test("tool removal fences pending events across chats and preserves other origins through restart", async (t) => {
  const p = await peer(t, {
    tools: { listChanged: true },
    resources: { subscribe: true },
  });
  p.tools.push("second");
  const dir = await mkdtemp(join(tmpdir(), "d18-delete-watches-"));
  const path = join(dir, "watches.sqlite");
  let db, manager, gate;
  function boot(policy) {
    db = new DatabaseSync(path);
    db.exec(
      "PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS week3_sessions(id TEXT PRIMARY KEY)",
    );
    createMcpRepository(db);
    createSessionMcpRoutes(db);
    manager = createMcpConnectionManager(
      db,
      {},
      { ...timing, watchPolicy: policy },
    );
  }
  async function down() {
    await manager.close();
    db.close();
  }
  t.after(async () => {
    gate?.resolve();
    await down();
    await rm(dir, { recursive: true, force: true });
  });
  boot([]);
  const { connectionId, revision } = await manager.save(undefined, p.config);
  await manager.refresh(connectionId);
  const [one, two] = manager.catalog(connectionId).tools;
  const a = randomUUID(),
    b = randomUUID();
  for (const chat of [a, b]) {
    db.prepare("INSERT INTO week3_sessions VALUES(?)").run(chat);
    db.prepare("INSERT INTO session_mcp_connections VALUES(?,?)").run(
      chat,
      connectionId,
    );
  }
  const grant = (tool, sessionId) => ({
    connectionId,
    revision,
    sessionId,
    toolId: tool.toolId,
  });
  const catalogUri = "fixture:listed";
  p.listed.push(catalogUri);
  await manager.refresh(connectionId);
  const policy = [
    grant(one, a),
    grant(one, b),
    grant(two, a),
    { connectionId, revision, sessionId: a, uri: catalogUri },
  ];
  await down();
  boot(policy);
  const call = async (tool, sessionId, uris) => {
    p.blocks = uris.map((uri) => ({
      type: "resource_link",
      uri,
      name: "Resource",
    }));
    return manager.execute(
      {
        ...grant(tool, sessionId),
        originalName: tool.originalName,
        toolCallId: randomUUID(),
        grantId: "fixture",
        safety: "read-only",
        arguments: {},
      },
      new AbortController().signal,
      () => true,
    );
  };
  const liveRows = () =>
    db
      .prepare(
        "SELECT scope,uri,status FROM mcp_resource_watches ORDER BY scope,uri",
      )
      .all();
  const archive = () =>
    db.prepare("SELECT * FROM mcp_resource_notifications ORDER BY id").all();
  const subCount = (target) =>
    [...p.clients.values()].filter((c) => c.sub.has(target)).length;
  assert.equal(
    (await call(one, a, [uri, other, catalogUri])).output.watchedResourceLinks,
    3,
  );
  await call(one, b, [uri]);
  await call(two, a, [uri]);
  await until(
    () => liveRows().filter((w) => w.status === "active").length === 4,
  );
  const sharedWatch = db
    .prepare("SELECT id FROM mcp_resource_watches WHERE scope=? AND uri=?")
    .get(a, uri).id;
  await manager.refresh(connectionId);
  assert.equal(liveRows().length, 4);
  assert.equal(subCount(uri), 1);
  p.resourceText.set(other, "before deletion");
  p.notify(other);
  await until(() => archive().length === 1);
  const history = archive();
  const originalOrigin = db.prepare("SELECT tool_id,call_id FROM mcp_watch_origins WHERE watch_id=?").get(history[0].watch_id);
  assert.equal(originalOrigin.tool_id,one.toolId);
  const readsOfRemovedResource = () =>
    p.calls.filter((c) => c.method === "resources/read" && c.uri === other)
      .length;
  const reads = readsOfRemovedResource();
  p.holdUri = other;
  gate = Promise.withResolvers();
  p.hold = gate.promise;
  p.resourceText.set(other, "late data");
  p.notify(other);
  await until(() => readsOfRemovedResource() > reads);
  // Only a successful tools/list identifying an absent tool revokes its grant.
  p.tools = [two.originalName];
  for (const c of p.clients.values())
    if (c.sub.size)
      c.stream?.write(
        'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n\n',
      );
  await until(() => liveRows().length === 2);
  gate.resolve();
  p.hold = null;
  await until(() => subCount(uri) === 1 && !subCount(other));
  assert.equal(subCount(catalogUri), 1);
  assert.deepEqual(
    db
      .prepare(
        "SELECT DISTINCT tool_id FROM mcp_watch_origins ORDER BY tool_id",
      )
      .all()
      .map((o) => o.tool_id),
    ["", two.toolId],
  );
  assert.deepEqual(
    manager.visibleWatchIds().sort(),
    db
      .prepare("SELECT id FROM mcp_resource_watches ORDER BY id")
      .all()
      .map((w) => w.id),
  );
  assert.ok(manager.visibleWatchIds().includes(sharedWatch));
  assert.deepEqual(
    archive().filter((e) => e.uri === other),
    history,
  );
  assert.equal(
    p.calls.filter(
      (c) => c.method === "resources/unsubscribe" && c.uri === other,
    ).length,
    1,
  );
  assert.equal(
    p.calls.filter((c) => c.method === "resources/unsubscribe" && c.uri === uri)
      .length,
    0,
  );
  p.tools.push(one.originalName);
  await manager.refresh(connectionId);
  const restored = manager
    .catalog(connectionId)
    .tools.find((t) => t.originalName === one.originalName);
  assert.equal(restored.toolId, one.toolId);
  assert.equal(restored.watchEnabled, false);
  assert.equal(
    (await call(one, a, [other])).output.watchedResourceLinks,
    undefined,
  );
  assert.equal(subCount(other), 0);
  await down();
  const subscriptions = p.count("resources/subscribe");
  boot(policy);
  await until(
    () => liveRows().filter((w) => w.status === "active").length === 2,
  );
  assert.equal(p.count("resources/subscribe") - subscriptions, 2);
  assert.ok(manager.visibleWatchIds().includes(sharedWatch));
  assert.equal(
    manager.catalog(connectionId).tools.find((t) => t.toolId === one.toolId)
      .watchEnabled,
    false,
  );
  assert.deepEqual(
    archive().filter((e) => e.uri === other),
    history,
  );
  // Explicit removal does not contact the tool. Offline unsubscribe is best effort.
  p.offline = true;
  const calls = p.count("tools/call");
  await manager.removeTool(connectionId, two.toolId, revision);
  await manager.removeTool(connectionId, two.toolId, revision);
  assert.deepEqual(
    liveRows().map((w) => w.uri),
    [catalogUri],
  );
  await manager.remove(connectionId, revision);
  await manager.remove(connectionId, revision);
  assert.deepEqual(liveRows(), []);
  assert.deepEqual(
    archive().filter((e) => e.uri === other),
    history,
  );
  await delay(150);
  const init = p.count("initialize");
  await down();
  boot(policy);
  await delay(150);
  assert.deepEqual(db.prepare("SELECT tool_id,call_id FROM mcp_notification_retired_origins WHERE notification_id=?").get(history[0].id),originalOrigin);
  assert.equal(p.count("initialize"), init);
  assert.equal(p.count("tools/call"), calls);
  assert.deepEqual(manager.visibleWatchIds(), []);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("local tool DELETE is scoped, revision-checked, repeatable and works with the remote server offline", async (t) => {
  const p = await peer(t, { tools: {}, resources: { subscribe: true } });
  p.tools.push("keep");
  const dir = await mkdtemp(join(tmpdir(), "d18-offline-tool-"));
  const backend = createSessionServer(join(dir, "test.sqlite"), {
    credentialStore: {},
    mcpOptions: { ...timing, watchPolicy: [] },
  });
  const url = await listen(backend);
  t.after(async () => {
    await stop(backend);
    await rm(dir, { recursive: true, force: true });
  });
  const api = (path, method, body, local = true) =>
    fetch(url + "/api/mcp-connections" + path, {
      method,
      headers: {
        "content-type": "application/json",
        ...(local && { "x-day18-ui": "settings" }),
      },
      ...(body && { body: JSON.stringify(body) }),
    });
  const { connectionId, revision } = await (
    await api("", "POST", p.config)
  ).json();
  assert.equal(
    (await api("/" + connectionId + "/refresh", "POST")).status,
    200,
  );
  const { tools } = await (await api("/" + connectionId, "GET")).json();
  const [first, second] = tools;
  const path = "/" + connectionId + "/tools/" + first.toolId;
  p.offline = true;
  const networkCalls = p.calls.length;
  assert.equal((await api(path, "DELETE", { revision }, false)).status, 403);
  assert.equal(
    (await api(path, "DELETE", { revision: revision + 1 })).status,
    409,
  );
  for (let i = 0; i < 2; i++) {
    const response = await api(path, "DELETE", { revision });
    assert.equal(response.status, 200);
    assert.deepEqual(
      (await response.json()).tools.map((t) => t.toolId),
      [second.toolId],
    );
  }
  assert.equal(p.calls.length, networkCalls);
  p.offline = false;
  assert.equal((await api("/"+connectionId+"/refresh","POST")).status,200);
  const afterRefresh = await (await api("/"+connectionId,"GET")).json();
  assert.deepEqual(afterRefresh.tools.map(t=>t.toolId),[second.toolId]);
});

test("authorized tool setting follows new chats; local and remote lifecycles remain independent through restart", async (t) => {
  const p = await peer(t, { tools: {}, resources: { subscribe: true } });
  p.tools = ["plan"];
  const jobs = [],
    due = new Date(Date.now() + 60_000).toISOString();
  p.call = () => {
    const resource = "example:job/" + randomUUID();
    jobs.push(resource);
    p.resourceText.set(
      resource,
      JSON.stringify({ state: "pending", scheduledAt: due }),
    );
    return {
      content: [
        {
          type: "resource_link",
          name: "Design review",
          description: "Review the prototype",
          uri: resource,
        },
      ],
    };
  };
  const dir = await mkdtemp(join(tmpdir(), "d18-resource-lifecycle-"));
  const file = join(dir, "fixture.sqlite");
  const mock = createDevManagerMock("fixture");
  let backend,
    base,
    models = 0;
  async function boot() {
    backend = createSessionServer(file, {
      credentialStore: {},
      mcpOptions: { ...timing, defaultAutomaticWatching: undefined, watchPolicy: [] },
      invariantAdapter: () => ({
        ...mock,
        complete: async (input) => {
          models++;
          if (
            input.memoryProposal ||
            input.messages[0]?.content.startsWith("Review a proposed")
          )
            return mock.complete(input);
          if (input.messages.at(-1)?.role === "tool")
            return { text: "Scheduled the review." };
          const tool = input.tools.find((tool) => tool.kind === "mcp");
          return {
            toolCalls: [
              {
                id: "fixture-plan",
                toolId: tool.id,
                providerName: "mcp_" + tool.toolId.replaceAll("-", ""),
                arguments: {},
              },
            ],
          };
        },
      }),
    });
    base = await listen(backend);
  }
  await boot();
  const db = new DatabaseSync(file);
  t.after(async () => {
    await stop(backend);
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const api = async (path, method = "GET", body, action = "settings") => {
    const response = await fetch(base + "/api/" + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-Day18-UI": action,
        Origin: base,
      },
      body: body && JSON.stringify(body),
    });
    const value = await response.json();
    assert.ok(
      response.ok,
      method + " " + path + " " + response.status + " " + JSON.stringify(value),
    );
    return value;
  };
  const { connectionId, revision } = await api(
    "mcp-connections",
    "POST",
    p.config,
  );
  const conn = "mcp-connections/" + connectionId;
  await api(conn + "/refresh", "POST");
  const [tool] = (await api(conn)).tools;
  await api(
    conn + "/execution-mode",
    "PUT",
    {
      revision: (
        await api(conn + "/execution-mode", "GET", undefined, "execution-mode")
      ).revision,
      mode: "auto",
      toolIds: [tool.toolId],
    },
    "execution-mode",
  );
  assert.equal(tool.watchAttachedChats, true);
  assert.equal((await api(conn)).connection.watchToolCount, 1);
  const setting = conn + "/tools/" + tool.toolId + "/watch-policy";
  const disabled = await api(setting, "PUT", { revision, enabled: false });
  assert.equal(disabled.tools[0].watchAttachedChats, false);
  assert.equal(disabled.connection.watchToolCount, 0);
  await stop(backend);
  await boot();
  await api(conn + "/refresh", "POST");
  assert.equal((await api(conn)).tools[0].watchAttachedChats, false);
  const enabled = await api(setting, "PUT", { revision, enabled: true });
  assert.equal(enabled.tools[0].watchAttachedChats, true);
  assert.equal(enabled.connection.watchToolCount, 1);
  const { id: chat } = await api("week3/sessions", "POST", {});
  await api(
    "week4/sessions/" + chat + "/mcp-connections/" + connectionId,
    "PUT",
  );
  const turn = (session = chat) =>
    api("week4/sessions/" + session + "/invariant-turn", "POST", {
      turnId: randomUUID(),
      execute: true,
      provider: "openai",
      model: "fixture",
      question: "Schedule a design review using the attached service.",
    });
  const inbox = (path = "", method = "GET") =>
    api("notifications" + path, method, undefined, "notifications");
  const watch = (uri) =>
    db.prepare("SELECT * FROM mcp_resource_watches WHERE uri=?").get(uri);
  const gate = Promise.withResolvers();
  p.hold = gate.promise;
  try {
    await turn();
    assert.equal(jobs.length, 1);
    const initial = await inbox();
    assert.equal(initial.unread, 0);
    assert.equal(initial.subscriptions[0].status, "Subscribing");
    assert.ok(initial.subscriptions[0].updatedAt);
    assert.equal(initial.subscriptions[0].title, "Design review");
    assert.deepEqual(initial.subscriptions[0].tools, ["plan"]);
    assert.equal(initial.subscriptions[0].chat, "New session");
    assert.ok(
      db
        .prepare(
          "SELECT 1 FROM mcp_watch_origins o JOIN week4_operations op ON op.id=o.call_id WHERE o.watch_id=? AND tool_id=?",
        )
        .get(initial.subscriptions[0].id, tool.toolId),
    );
  } finally {
    gate.resolve();
    p.hold = null;
  }
  await until(() => watch(jobs[0])?.remote_status === "Pending");
  const pending = (await inbox()).subscriptions[0];
  assert.equal(pending.status, "Subscribed");
  assert.equal(pending.remoteStatus, "Pending");
  assert.equal(pending.scheduledAt, due);
  assert.ok(pending.updatedAt);
  assert.equal(pending.description, "Review the prototype");
  const reads = p.count("resources/read");
  p.resourceText.set(
    jobs[0],
    JSON.stringify({ scheduledAt: due, state: "pending" }, null, 2),
  );
  p.notify(jobs[0]);
  await until(() => p.count("resources/read") > reads);
  const calls = models;
  p.resourceText.set(
    jobs[0],
    JSON.stringify({
      state: "completed",
      message: "The design review is ready.",
    }),
  );
  p.notify(jobs[0]);
  p.notify(jobs[0]);
  await until(() => watch(jobs[0]).status === "unsubscribed");
  const done = await inbox();
  assert.deepEqual(done.subscriptions, []);
  assert.equal(done.unread, 1);
  assert.equal(done.items[0].message, "The design review is ready.");
  await inbox("/" + done.items[0].id + "/read", "PUT");
  const archive = (await inbox()).items;
  const subscribed = p.count("resources/subscribe");
  await stop(backend);
  await boot();
  assert.equal((await inbox()).unread, 0);
  assert.deepEqual((await inbox()).items, archive);
  assert.equal(models, calls);
  assert.equal((await api(conn)).tools[0].watchAttachedChats, true);
  await turn();
  await until(() => watch(jobs[1])?.remote_status === "Pending");
  p.resourceText.set(
    jobs[1],
    JSON.stringify({ state: "running", message: "Review started." }),
  );
  p.notify(jobs[1]);
  await until(() => watch(jobs[1])?.remote_status === "Running");
  const [second] = (await inbox()).subscriptions;
  for (let i = 0; i < 2; i++)
    await inbox("/subscriptions/" + second.id, "DELETE");
  assert.equal(watch(jobs[1]).status, "unsubscribed");
  assert.equal(JSON.parse(p.resourceText.get(jobs[1])).state, "running");
  assert.equal((await inbox()).items[0].message, "Review started.");
  assert.equal((await inbox()).unread, 1);
  await until(() => ![...p.clients.values()].some((c) => c.sub.size));
  await stop(backend);
  await boot();
  assert.equal(p.count("resources/subscribe"), subscribed + 1);
  assert.deepEqual((await inbox()).subscriptions, []);
  await turn();
  await until(() => watch(jobs[2])?.status === "active");
  const { id: another } = await api("week3/sessions", "POST", {});
  await api(
    "week4/sessions/" + another + "/mcp-connections/" + connectionId,
    "PUT",
  );
  p.call = () => ({
    content: [{ type: "resource_link", name: "Shared review", uri: jobs[2] }],
  });
  const subCount = p.count("resources/subscribe");
  const releases = p.count("resources/unsubscribe");
  await turn(another);
  await until(
    () =>
      db
        .prepare(
          "SELECT count(*) n FROM mcp_resource_watches WHERE uri=? AND status='active'",
        )
        .get(jobs[2]).n === 2,
  );
  assert.equal(p.count("resources/subscribe"), subCount);
  await api("week3/sessions/" + chat, "DELETE");
  assert.equal((await inbox()).subscriptions.length, 1);
  assert.equal(p.count("resources/unsubscribe"), releases);
  const historyCount = () =>
    db
      .prepare("SELECT count(*) n FROM week3_history_events WHERE sessionId=?")
      .get(another).n;
  const journalCount = () =>
    db
      .prepare(
        "SELECT count(*) n FROM week4_operations op JOIN week4_runs r ON r.id=op.run_id WHERE r.session_id=?",
      )
      .get(another).n;
  const historyBefore = historyCount(),
    journalBefore = journalCount();
  assert.ok(historyBefore && journalBefore);
  await api(conn + "/tools/" + tool.toolId, "DELETE", { revision });
  await until(() => ![...p.clients.values()].some((c) => c.sub.size));
  assert.equal(p.count("resources/unsubscribe"), releases + 1);
  assert.equal(historyCount(), historyBefore);
  assert.equal(journalCount(), journalBefore);
  assert.deepEqual((await inbox()).subscriptions, []);
  assert.deepEqual((await inbox()).items, []);
  assert.equal(
    db
      .prepare("SELECT read_at FROM mcp_resource_notifications WHERE id=?")
      .get(archive[0].id).read_at,
    archive[0].readAt,
  );
  assert.equal(p.count("tools/call"), 4);
});
