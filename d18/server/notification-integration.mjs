import { ExecutionJournal } from "./execution-journal.mjs";
import { sessionToolJournal } from "./session-tool-journal.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { createWatchStore } from "./mcp-resource-watch-store.mjs";
import { createMcpRepository } from "./mcp-repository.mjs";
import { createSessionMcpRoutes } from "./session-mcp-connections.mjs";
import { createNotificationRoutes } from "./notification-routes.mjs";

test("history, counts and writes share chat authorization; protected history excludes saved remote content", (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(
    "PRAGMA foreign_keys=ON; CREATE TABLE week3_sessions(id TEXT PRIMARY KEY,title TEXT);CREATE TABLE session_invariants(session_id TEXT,enabled INTEGER)",
  );
  createMcpRepository(db);
  createSessionMcpRoutes(db);
  const id = randomUUID(),
    a = randomUUID(),
    b = randomUUID(),
    uri = "example:shared";
  db.prepare(
    `INSERT INTO mcp_connections(id,name,description,endpoint,normalized_endpoint,transport,auth,capabilities)
    VALUES(?,'Public service','','https://example.invalid','https://example.invalid','sse','{}','{"resources":true,"subscribe":true}')`,
  ).run(id);
  db.prepare("INSERT INTO mcp_resources VALUES(?,?,?)").run(id, uri, "{}");
  for (const s of [a, b]) {
    db.prepare("INSERT INTO week3_sessions(id) VALUES(?)").run(s);
    db.prepare("INSERT INTO session_mcp_connections VALUES(?,?)").run(s, id);
  }
  const grants = [{ connectionId: id, revision: 1, sessionId: a, uri }];
  const store = createWatchStore(db, grants),
    [w] = store.desired();
  const note = db.prepare(
    "INSERT INTO mcp_resource_notifications(watch_id,connection_id,source_name,session_id,uri,sequence,kind,received_at,content) VALUES(?,?,'Fixture',?,?,?,'updated',100,?)",
  );
  const content = JSON.stringify({
    status: "done",
    message: "private historical text",
  });
  note.run(w.id, id, a, uri, 1, content);
  note.run(w.id, id, b, uri, 2, content);
  const route = createNotificationRoutes(db, store.visibleIds);
  function request(path = "", method = "GET") {
    const url = "/api/notifications" + path;
    let result;
    route(
      {
        url,
        method,
        headers: { host: "localhost", "x-day18-ui": "notifications" },
        socket: { remoteAddress: "127.0.0.1" },
      },
      url.split("?")[0],
      (status, body) => {
        result = { status, body };
      },
    );
    return result;
  }
  const first = request().body;
  assert.deepEqual(first.subscriptions.map(w => w.uri), [uri]);
  assert.equal(first.unread, 1);
  assert.equal(first.items[0].sessionId, a);
  assert.equal(first.items[0].status, "done");
  assert.equal(request("/2/read", "PUT").status, 404);
  assert.equal(request("/read-all?through=2", "PUT").body.unread, 0);
  assert.equal(
    db
      .prepare("SELECT read_at FROM mcp_resource_notifications WHERE id=2")
      .get().read_at,
    null,
  );
  db.prepare("INSERT INTO session_invariants VALUES(?,1)").run("week3:" + a);
  assert.equal(request().body.subscriptions[0].uri, null);
  const item = request().body.items[0];
  assert.equal(item.content, null);
  assert.equal(item.status, null);
  assert.equal(item.source, "MCP connection");
  db.prepare("DELETE FROM session_mcp_connections WHERE session_id=?").run(a);
  assert.deepEqual(request().body.items, []);
  assert.deepEqual(request().body.subscriptions, []);
  assert.equal(request("/1/read", "PUT").status, 404);
});

test("historical journal suppresses only a corroborated link-only warning for the same call", (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(
    "CREATE TABLE week3_sessions(id TEXT PRIMARY KEY);CREATE TABLE session_invariants(session_id TEXT,enabled INTEGER);INSERT INTO week3_sessions VALUES('chat')",
  );
  createMcpRepository(db);
  createWatchStore(db, []);
  new ExecutionJournal(db);
  db.exec(`INSERT INTO week4_runs(id,session_id,request_id,fingerprint,state,created,updated,retry_deadline)
    VALUES('r','chat','r','','Completed',0,0,0)`);
  const warning = {
    code: "unsupported_content",
    omitted: { resource_link: 1 },
    evidenceIncomplete: true,
  };
  const insert =
    db.prepare(`INSERT INTO week4_operations(id,run_id,kind,logical_key,target,connection_key,safety,state,result,
    created,deadline,max_attempts,policy_grant,display) VALUES(?,'r','tool',?,'mcp:tool','connection','read-only','Success',?,0,0,1,'policy','{"compatibilityWarning":1}')`);
  for (const id of ["watched", "unwatched", "mixed"]) {
    const flag =
      id === "mixed"
        ? { ...warning, omitted: { image: 1, resource_link: 1 } }
        : warning;
    insert.run(
      id,
      id,
      JSON.stringify({ content: [], compatibilityWarning: flag }),
    );
  }
  db.exec(`INSERT INTO mcp_connections(id,name,description,endpoint,normalized_endpoint,transport,auth) VALUES('connection','Server','','https://example.invalid','https://example.invalid','sse','{}');
    INSERT INTO mcp_resource_watches(id,connection_id,revision,scope,uri,status) VALUES('w','connection',1,'chat','example:item','active');
    INSERT INTO mcp_watch_origins VALUES('w','tool','watched'),('w','tool','mixed')`);
  const route = sessionToolJournal(db);
  function journal(id = "") {
    let result;
    route(
      { method: "GET" },
      "/api/week4/sessions/chat/execution-journal" + id,
      (_, body) => {
        result = body;
      },
    );
    return result;
  }
  assert.deepEqual(
    journal().map((row) => [row.id, row.hasWarning]),
    [
      ["watched", false],
      ["unwatched", true],
      ["mixed", true],
    ],
  );
  assert.equal(JSON.parse(journal("/watched").result).evidenceIncomplete, true);
  assert.equal(
    JSON.parse(journal("/mixed").result).compatibilityWarning.omitted.image,
    1,
  );
});

test("migration preserves historical notification identity, read state and session privacy on connection deletion", (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(
    "PRAGMA foreign_keys=ON; CREATE TABLE week3_sessions(id TEXT PRIMARY KEY)",
  );
  createMcpRepository(db);
  createSessionMcpRoutes(db);
  db.exec(`INSERT INTO mcp_connections(id,name,description,endpoint,normalized_endpoint,transport,auth)
      VALUES('c','Fixture','','https://example.invalid','https://example.invalid','sse','{}');
    INSERT INTO week3_sessions VALUES('chat');
    CREATE TABLE mcp_resource_notifications (
      id INTEGER PRIMARY KEY,watch_id TEXT NOT NULL,connection_id TEXT NOT NULL REFERENCES mcp_connections(id) ON DELETE CASCADE,
      source_name TEXT NOT NULL,session_id TEXT,uri TEXT NOT NULL,sequence INTEGER NOT NULL,kind TEXT NOT NULL,
      received_at INTEGER NOT NULL,content TEXT,read_at INTEGER, UNIQUE(watch_id,sequence));
    CREATE INDEX mcp_notifications_history ON mcp_resource_notifications(received_at DESC,id DESC);
    CREATE TRIGGER mcp_chat_delete_notifications AFTER DELETE ON week3_sessions BEGIN
      DELETE FROM mcp_resource_notifications WHERE session_id=OLD.id; END;
    INSERT INTO mcp_resource_notifications VALUES(54,'w','c','Fixture','chat','fixture:one',3,'updated',500,'historical',531);`);
  const rows = () =>
    db.prepare("SELECT * FROM mcp_resource_notifications").all();
  const original = rows();
  createWatchStore(db, []);
  createWatchStore(db, []);
  db.exec("DELETE FROM mcp_connections WHERE id='c'");
  assert.deepEqual(rows(), original);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  db.exec("DELETE FROM week3_sessions WHERE id='chat'");
  assert.deepEqual(rows(), original);
});
