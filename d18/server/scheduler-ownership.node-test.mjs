import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { migrateTaskOwnership } from "./scheduler-migration.mjs";
import { createInvariantStore } from "./session-invariants.mjs";

test("legacy task history and journal children survive migration, restart and deletion of their original chat", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`PRAGMA foreign_keys=ON;
 CREATE TABLE sessions(id TEXT PRIMARY KEY);
 CREATE TABLE week3_sessions(id TEXT PRIMARY KEY);
 INSERT INTO week3_sessions VALUES('chat'),('other');
 CREATE TABLE week3_history_events(sessionId TEXT,sequence INTEGER,type TEXT,payload TEXT);
 CREATE TABLE scheduled_tasks(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES week3_sessions(id) ON DELETE CASCADE,enabled INTEGER,revision INTEGER);
 INSERT INTO scheduled_tasks VALUES('task','chat',1,3);
 CREATE TABLE scheduled_occurrences(id TEXT PRIMARY KEY,task_id TEXT REFERENCES scheduled_tasks(id));
 INSERT INTO scheduled_occurrences VALUES('run','task');
 CREATE TABLE scheduled_task_tools(task_id TEXT,tool_id TEXT);
 INSERT INTO scheduled_task_tools VALUES('task','tool');
 CREATE TABLE week4_runs(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES week3_sessions(id) ON DELETE CASCADE,owner TEXT,lease_until INTEGER);
 INSERT INTO week4_runs VALUES('run','chat',NULL,NULL),('chat-run','other',NULL,NULL);
 CREATE TABLE week4_operations(id TEXT PRIMARY KEY,run_id TEXT REFERENCES week4_runs(id) ON DELETE CASCADE);
 INSERT INTO week4_operations VALUES('op','run');
 CREATE INDEX old_journal_index ON week4_runs(owner);`);
    const event = {
      id: "answer",
      role: "assistant",
      type: "text",
      text: "Verified receipt",
      runId: "run",
    };
    db.prepare("INSERT INTO week3_history_events VALUES('chat',1,'message',?)").run(
      JSON.stringify(event),
    );
    const store = createInvariantStore(db);
    db.prepare("UPDATE week4_runs SET owner='live', lease_until=? WHERE id='run'").run(
      Date.now() + 30000,
    );
    assert.throws(() => migrateTaskOwnership(db, store), /active execution/);
    assert.equal(db.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
    db.exec("UPDATE week4_runs SET owner=NULL,lease_until=NULL");
    migrateTaskOwnership(db, store);
    migrateTaskOwnership(db, store);
    db.exec("DELETE FROM week3_sessions WHERE id='chat'");
    assert.equal(db.prepare("SELECT response FROM scheduled_occurrences").get().response, event.text);
    assert.deepEqual(
      { ...db.prepare("SELECT enabled,review_definition,revision FROM scheduled_tasks").get() },
      { enabled: 0, review_definition: 1, revision: 4 },
    );
    assert.equal(db.prepare("SELECT policy_mode FROM scheduled_task_tools").get().policy_mode, "review");
    assert.deepEqual(
      { ...db.prepare("SELECT session_id,task_id FROM week4_runs WHERE id='run'").get() },
      { session_id: null, task_id: "task" },
    );
    assert.equal(db.prepare("SELECT run_id FROM week4_operations").get().run_id, "run");
    db.exec("DELETE FROM week3_sessions WHERE id='other'");
    assert.equal(db.prepare("SELECT count(*) AS n FROM week4_runs").get().n, 1);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    db.close();
  }
});


test("unattended execution discovers the selected provider catalog without a browser", async () => {
  const { invariantProvider } = await import("./invariant-provider.mjs");
  let discoveries = 0;
  const provider = invariantProvider(undefined, () => assert.fail("no inference during setup"), async () => {
    discoveries++;
    return Response.json({data: [{id:"fixture-only",limit:{context:8192,output:1024}}]});
  });
  assert.ok(!provider.registry.modelOptionsFor("opencode-go").includes("fixture-only"));
  await provider.scheduledAdapter("opencode-go", "fixture-only", 0);
  await provider.scheduledAdapter("opencode-go", "fixture-only", 0);
  assert.equal(discoveries, 1);
  assert.ok(provider.registry.modelOptionsFor("opencode-go").includes("fixture-only"));
});
