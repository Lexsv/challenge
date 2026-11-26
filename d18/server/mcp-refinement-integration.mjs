import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { once } from "node:events";
import { createSessionServer } from "./sessions.mjs";
import { createMcpConnectionManager } from "./mcp-connection-manager.mjs";
import { createMcpRepository } from "./mcp-repository.mjs";
import { parseConfiguration } from "./mcp-configuration.mjs";
import { normalizedMcpEndpoint } from "../src/mcp-endpoint.ts";

const base = {
  name: "First",
  description: "test",
  endpoint: "https://example.test/mcp",
  transport: "sse",
  auth: { type: "none" },
};
function fixture(t, options = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  t.after(() => db.close());
  const keys = new Map(),
    store = {
      save: async (k, v) => keys.set(k, v),
      read: async (k) => keys.get(k),
      forget: async (k) => keys.delete(k),
    };
  return {
    db,
    store,
    keys,
    manager: createMcpConnectionManager(db, store, options),
    repo: createMcpRepository(db),
  };
}

test("endpoint identity preserves significant path, query, ordering and safe escaping", () => {
  assert.equal(
    normalizedMcpEndpoint("  HTTPS://EXAMPLE.test:443/mcp?scope=a%20b  "),
    "https://example.test/mcp?scope=a%20b",
  );
  for (const suffix of [
    "/mcp/",
    "/Mcp",
    "/mcp?tokenizer=standard",
    "/mcp?a=1",
    "/mcp?a=2",
    "/mcp?a=1&a=2",
    "/mcp?a=2&a=1",
  ])
    assert.equal(
      normalizedMcpEndpoint("https://example.test" + suffix),
      "https://example.test" + suffix,
    );
  assert.equal(
    normalizedMcpEndpoint("http://LOCALHOST:80"),
    "http://localhost/",
  );
  assert.throws(
    () =>
      parseConfiguration({
        ...base,
        endpoint: base.endpoint + "?tenant=sample%2Fkey",
        auth: { type: "bearer" },
        secretValues: ["sample/key"],
      }),
    { code: "invalid" },
  );
  for (const url of [
    "https://user:test@example.test",
    "https://example.test/?api_key=x",
    "https://example.test/?custom_auth=x",
    "https://example.test/#x",
  ])
    assert.equal(normalizedMcpEndpoint(url, "custom_auth"), undefined);
});
test("concurrent endpoint collision returns HTTP 409 across credentials and transports; edit excludes itself", async (t) => {
  const keys = new Map(),
    store = {
      save: async (k, v) => keys.set(k, v),
      forget: async (k) => keys.delete(k),
      status: async () => false,
    };
  const server = createSessionServer(":memory:", { credentialStore: store });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    const done = once(server, "close");
    server.close();
    server.closeAllConnections();
    await done;
  });
  async function api(method, body, id = "") {
    const res = await fetch(
      "http://127.0.0.1:" + server.address().port + "/api/mcp-connections" + id,
      {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    return { status: res.status, body: await res.json() };
  }
  const alt = {
    ...base,
    name: "Another",
    endpoint: " HTTPS://EXAMPLE.TEST:443/mcp ",
    transport: "streamable-http",
    auth: { type: "query", parameter: "access" },
    secretValues: ["fixture-only-key"],
  };
  const results = await Promise.all([api("POST", base), api("POST", alt)]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
  assert.equal(results.find((r) => r.status === 409).body.code, "endpoint");
  const id = results.find((r) => r.status === 201).body.connectionId;
  const edited = await api(
    "PUT",
    { ...alt, name: "Renamed", revision: 1 },
    "/" + id,
  );
  assert.equal(edited.status, 200);
  assert.equal(edited.body.connectionId, id);
  const other = await api("POST", {
    ...base,
    name: "Distinct",
    endpoint: base.endpoint + "?tenant=2",
  });
  assert.equal(other.status, 201);
  assert.equal(
    (
      await api(
        "PUT",
        { ...base, name: "Distinct", revision: 1 },
        "/" + other.body.connectionId,
      )
    ).status,
    409,
  );
  assert.equal((await api("DELETE", { revision: 99 }, "/" + id)).status, 409);
  assert.equal((await api("DELETE", { revision: 2 }, "/" + id)).status, 200);
  assert.equal(keys.size, 0);
});
test("database constraint rejects a second endpoint even outside the repository", async (t) => {
  const { db, manager } = fixture(t);
  await manager.save(undefined, base);
  assert.throws(
    () =>
      db
        .prepare(
          "INSERT INTO mcp_connections(id,name,description,endpoint,normalized_endpoint,transport,auth) VALUES('second','Two','',?,?,'sse','{}')",
        )
        .run(base.endpoint, base.endpoint),
    /Duplicate|UNIQUE/,
  );
});
test("legacy duplicates are preserved, reported, and can be resolved without losing identities", (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(`CREATE TABLE mcp_connections (id TEXT PRIMARY KEY,name TEXT UNIQUE,description TEXT,endpoint TEXT,transport TEXT,auth TEXT,
    credential_ref TEXT,revision INTEGER DEFAULT 1,last_success INTEGER,needs_refresh INTEGER DEFAULT 0,sync_error TEXT);
    INSERT INTO mcp_connections(id,name,description,endpoint,transport,auth,credential_ref)
    VALUES('one','One','','https://EXAMPLE.test:443/mcp','sse','{"type":"none"}',NULL),
          ('two','Two','','https://example.test/mcp','sse','{"type":"bearer"}','mcp-fixture');`);
  const repo = createMcpRepository(db);
  assert.deepEqual(
    repo.list().map((c) => [c.connectionId, c.endpointConflict]),
    [
      ["one", true],
      ["two", true],
    ],
  );
  assert.equal(repo.row("two").credential_ref, "mcp-fixture");
  assert.deepEqual(createMcpRepository(db).list(), repo.list());
  repo.save(
    "one",
    { ...base, endpoint: base.endpoint + "/other" },
    null,
    1,
    true,
  );
  assert.equal(repo.row("two").normalized_endpoint, base.endpoint);
  assert.equal(repo.get("two").endpointConflict, false);
});
test("local delete cancels an active refresh, drains resources and preserves other catalogs and secrets", async (t) => {
  let startFetch;
  const started = new Promise((resolve) => {
    startFetch = resolve;
  });
  let aborted = false;
  const { db, store, keys, manager, repo } = fixture(t, {
    fetcher: async (_url, { signal }) => {
      startFetch();
      return new Promise((_, reject) =>
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(Error("closed"));
          },
          { once: true },
        ),
      );
    },
  });
  const config = {
    ...base,
    transport: "streamable-http",
    auth: { type: "bearer" },
    secretValues: ["mock-credential-123"],
  };
  const first = await manager.save(undefined, config),
    other = await manager.save(undefined, {
      ...config,
      endpoint: base.endpoint + "/second",
      name: "Other",
    });
  const tools = [{ name: "shared", inputSchema: { type: "object" } }];
  repo.synchronize(first.connectionId, 1, tools);
  repo.synchronize(other.connectionId, 1, tools);
  const old = repo.catalog(first.connectionId);
  const kept = repo.catalog(other.connectionId);
  const renamed = await manager.save(first.connectionId, {
    ...config,
    name: "New name",
    revision: 1,
  });
  assert.equal(renamed.connectionId, first.connectionId);
  assert.deepEqual(repo.catalog(first.connectionId).tools, old.tools);
  const active = assert.rejects(manager.refresh(first.connectionId), {
    code: "cancelled",
  });
  await started;
  await manager.remove(first.connectionId, 2);
  await active;
  assert.ok(aborted);
  assert.equal(keys.size, 1);
  assert.ok(await store.read(repo.row(other.connectionId).credential_ref));
  assert.equal(db.prepare("SELECT count(*) AS n FROM mcp_tools").get().n, 1);
  assert.deepEqual(repo.catalog(other.connectionId), kept);
  assert.throws(() => repo.row(first.connectionId), { code: "missing" });
});
test("credential or SQLite deletion failures remain visible and retryable after restart", async (t) => {
  const { db, store, manager, repo } = fixture(t);
  const c = await manager.save(undefined, {
    ...base,
    auth: { type: "bearer" },
    secretValues: ["mock-credential-123"],
  });
  repo.synchronize(c.connectionId, 1, [{ name: "a", inputSchema: {} }]);
  const forget = store.forget;
  store.forget = async () => {
    throw Error("private store detail");
  };
  await assert.rejects(manager.remove(c.connectionId, 1), { code: "cleanup" });
  assert.equal(repo.get(c.connectionId).deletionPending, true);
  assert.equal(repo.get(c.connectionId).toolCount, 1);
  await assert.rejects(manager.refresh(c.connectionId), { code: "deleting" });
  store.forget = forget;
  db.exec(
    "CREATE TRIGGER injected_failure BEFORE DELETE ON mcp_connections BEGIN SELECT RAISE(ABORT,'test failure'); END",
  );
  await assert.rejects(manager.remove(c.connectionId, 1), {
    code: "delete_failed",
  });
  assert.equal(repo.get(c.connectionId).toolCount, 1);
  db.exec("DROP TRIGGER injected_failure");
  await createMcpConnectionManager(db, store).remove(c.connectionId, 1);
  assert.equal(repo.list().length, 0);
});

test("settings restore regular parameters and retain masked credentials by key; reveal is local and revision-bound", async (t) => {
  const f = fixture(t);
  const app = createSessionServer(":memory:", { credentialStore: f.store });
  app.listen(0, "127.0.0.1");
  await once(app, "listening");
  t.after(async () => {
    const closed = once(app, "close");
    app.close();
    app.closeAllConnections();
    await closed;
  });
  const origin = "http://127.0.0.1:" + app.address().port;
  const request = (url, method, body, headers = {}) =>
    fetch(origin + "/api/mcp-connections" + url, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: body && JSON.stringify(body),
    });
  for (const type of ["headers", "query"]) {
    const key = type === "headers" ? "X-Auth-Token" : "userToken";
    const rows = [
      { key, secret: true, enabled: true },
      { key: "locale", secret: false, value: "fr", enabled: true },
      { key: "debug", secret: false, value: "1", enabled: false },
    ];
    const config = {
      ...base,
      endpoint: base.endpoint + "/" + type,
      name: type,
      auth: { type, rows },
    };
    const secret = "fixture-private-value-7824";
    const created = await request("", "POST", {
      ...config,
      secretValues: [secret],
    });
    assert.equal(created.status, 201);
    const saved = await created.json(),
      url = "/" + saved.connectionId;
    const catalog = await (await request(url, "GET")).json();
    assert.ok(!JSON.stringify(catalog).includes(secret));
    assert.deepEqual(catalog.connection.auth.rows, rows);
    const updated = await request(url, "PUT", {
      ...config,
      revision: saved.revision,
      auth: { type, rows: [rows[1], rows[0], rows[2]] },
      secretValues: [null],
    });
    assert.equal(updated.status, 200);
    const { revision } = await updated.json();
    const body = { key, revision };
    const headers = { origin, "sec-fetch-site": "same-origin" };
    assert.equal((await request(url + "/reveal", "POST", body)).status, 403);
    assert.equal(
      (
        await request(url + "/reveal", "POST", body, {
          ...headers,
          origin: "https://fixture.invalid",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await request(
          url + "/reveal",
          "POST",
          { key, revision: saved.revision },
          headers,
        )
      ).status,
      409,
    );
    const withoutMetadata = await request(url + "/reveal","POST",body,{origin,"x-day18-ui":"settings"});
    assert.equal(withoutMetadata.status,200);
    assert.equal((await withoutMetadata.json()).value,secret);
    assert.equal((await request(url+"/reveal","POST",body,{origin,"x-day18-ui":"settings","sec-fetch-site":"cross-site"})).status,403);
    const revealed = await request(url + "/reveal", "POST", body, headers);
    assert.equal(revealed.status, 200);
    assert.equal(revealed.headers.get("cache-control"), "no-store");
    assert.equal((await revealed.json()).value, secret);
    const { authenticatedFetch } = await import("./mcp-configuration.mjs");
    const send = authenticatedFetch(
      config,
      [secret],
      new AbortController().signal,
      async (url, init) => {
        const params = type === "query" ? url.searchParams : init.headers;
        assert.equal(params.get(key), secret);
        assert.equal(params.get("locale"), "fr");
        assert.equal(params.has("debug"), false);
        return new Response("");
      },
    );
    await send(config.endpoint);
    assert.equal(
      (
        await request(url, "PUT", {
          ...config,
          endpoint: config.endpoint + "/other",
          revision,
          secretValues: [null],
        })
      ).status,
      400,
    );
  }
});
