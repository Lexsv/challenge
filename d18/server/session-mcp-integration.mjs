import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createSessionServer } from "./sessions.mjs";

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "week4-mcp-"));
  const file = join(dir, "test.sqlite");
  let server, base;
  async function start() {
    server = createSessionServer(file, {
      credentialStore: { status: async () => false },
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    base = "http://127.0.0.1:" + server.address().port;
  }
  async function stop() {
    const closed = once(server, "close");
    server.close();
    server.closeAllConnections();
    await closed;
  }
  await start();
  const db = new DatabaseSync(file);
  t.after(async () => {
    await stop();
    db.close();
    await rm(dir, { recursive: true });
  });
  async function api(path, method = "GET", body) {
    const response = await fetch(base + path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  }
  async function chat() {
    const r = await api("/api/week3/sessions", "POST", {});
    assert.equal(r.status, 201);
    return r.data.id;
  }
  async function connection(name) {
    const r = await api("/api/mcp-connections", "POST", {
      name,
      description: "",
      transport: "sse",
      endpoint: "https://fixture.invalid/" + name,
      auth: { type: "none" },
    });
    assert.equal(r.status, 201);
    return r.data.connectionId;
  }
  const route = (id) => "/api/week4/sessions/" + id + "/mcp-connections";
  async function selected(id) {
    const result = await api(route(id));
    assert.equal(result.status, 200);
    return result.data
      .filter((option) => option.selected)
      .map((option) => option.name);
  }
  return {
    db,
    api,
    chat,
    connection,
    selected,
    route,
    restart: async () => {
      await stop();
      await start();
    },
  };
}

test("independent session memberships survive restart, duplicate requests and local detachment", async (t) => {
  const f = await fixture(t);
  const a = await f.chat(),
    b = await f.chat(),
    x = await f.connection("Alpha"),
    y = await f.connection("Beta");
  const member = (s, c) => f.route(s) + "/" + c;
  assert.deepEqual(await f.selected(a), []);
  assert.deepEqual(
    (await Promise.all([x, y, x].map((c) => f.api(member(a, c), "PUT")))).map(
      (r) => r.status,
    ),
    [200, 200, 200],
  );
  assert.throws(
    () =>
      f.db.prepare("INSERT INTO session_mcp_connections VALUES(?,?)").run(a, x),
    /UNIQUE/,
  );
  assert.deepEqual(await f.selected(b), []);
  assert.equal((await f.api(member(b, y), "PUT")).status, 200);
  await f.restart();
  assert.deepEqual(await f.selected(a), ["Alpha", "Beta"]);
  assert.deepEqual(await f.selected(b), ["Beta"]);
  for (let i = 0; i < 2; i++)
    assert.equal((await f.api(member(a, y), "DELETE")).status, 200);
  assert.deepEqual(await f.selected(a), ["Alpha"]);
  assert.deepEqual(await f.selected(b), ["Beta"]);
  assert.equal((await f.api("/api/mcp-connections/" + y)).status, 200);
});

test("only existing chat and MCP UUIDs are accepted, and failed writes leave the selection intact", async (t) => {
  const f = await fixture(t),
    s = await f.chat(),
    c = await f.connection("Alpha");
  const legacy = (await f.api("/api/sessions", "POST", {})).data.id;
  for (const [sessionId, connectionId, status] of [
    ["bad", c, 400],
    [s, "bad", 400],
    [legacy, c, 404],
    [randomUUID(), c, 404],
    [s, randomUUID(), 404],
  ])
    assert.equal(
      (await f.api(f.route(sessionId) + "/" + connectionId, "PUT")).status,
      status,
    );
  f.db.exec(
    "CREATE TRIGGER fail_attach BEFORE INSERT ON session_mcp_connections BEGIN SELECT RAISE(ABORT,'fixture failure'); END",
  );
  assert.equal((await f.api(f.route(s) + "/" + c, "PUT")).status, 500);
  assert.deepEqual(await f.selected(s), []);
  f.db.exec("DROP TRIGGER fail_attach");
  assert.equal((await f.api(f.route(s) + "/" + c, "PUT")).status, 200);
  f.db
    .prepare("UPDATE mcp_connections SET deletion_pending=1 WHERE id=?")
    .run(c);
  assert.equal((await f.api(f.route(s) + "/" + c, "PUT")).status, 409);
  assert.equal((await f.api(f.route(s) + "/" + c, "DELETE")).status, 200);
});

test("global deletion and chat deletion cascade only their own associations", async (t) => {
  const f = await fixture(t),
    a = await f.chat(),
    b = await f.chat(),
    x = await f.connection("Alpha"),
    y = await f.connection("Beta");
  for (const s of [a, b])
    for (const c of [x, y])
      assert.equal((await f.api(f.route(s) + "/" + c, "PUT")).status, 200);
  assert.equal(
    (await f.api("/api/mcp-connections/" + x, "DELETE", { revision: 1 }))
      .status,
    200,
  );
  assert.deepEqual(await f.selected(a), ["Beta"]);
  assert.deepEqual(await f.selected(b), ["Beta"]);
  assert.equal((await f.api("/api/week3/sessions/" + b, "DELETE")).status, 200);
  assert.equal(
    f.db.prepare("SELECT count(*) AS n FROM session_mcp_connections").get().n,
    1,
  );
  assert.deepEqual(await f.selected(a), ["Beta"]);
  assert.deepEqual(f.db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("upgrading an existing catalog and chat starts without associations", async (t) => {
  const f = await fixture(t),
    chat = await f.chat(),
    connection = await f.connection("Legacy");
  const tool = randomUUID();
  f.db
    .prepare(
      "INSERT INTO mcp_tools (id,connection_id,original_name,document,present) VALUES(?,?,?, ?,1)",
    )
    .run(
      tool,
      connection,
      "example",
      JSON.stringify({ name: "example", inputSchema: { type: "object" } }),
    );
  const before = await f.api("/api/mcp-connections/" + connection);
  // Reproduce the previous schema in this disposable database.
  f.db.exec("DROP TABLE session_mcp_connections");
  await f.restart();
  assert.deepEqual(await f.api("/api/mcp-connections/" + connection), before);
  assert.deepEqual(await f.selected(chat), []);
  assert.deepEqual(f.db.prepare("PRAGMA foreign_key_check").all(), []);
});
