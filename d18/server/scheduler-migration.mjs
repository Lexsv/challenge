// Keep occurrences and journal children in place. Rebuild only the run header
// whose old NOT NULL chat foreign key cannot represent an autonomous execution.
export function migrateTaskOwnership(db, store) {
  const columns = (table) =>
    db
      .prepare("SELECT name FROM pragma_table_info(?)")
      .all(table)
      .map((c) => c.name);
  const needsMigration = () =>
    columns("scheduled_tasks").includes("session_id") ||
    (columns("week4_runs").length && !columns("week4_runs").includes("task_id"));
  if (!needsMigration()) return;
  db.exec("PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE");
  try {
    const legacyTasks = columns("scheduled_tasks").includes("session_id"),
      runs = columns("week4_runs");
    if (
      runs.length &&
      !runs.includes("task_id") &&
      db
        .prepare("SELECT 1 FROM week4_runs WHERE owner IS NOT NULL AND lease_until>? LIMIT 1")
        .get(Date.now())
    )
      throw Error("Wait for active executions to finish before upgrading the scheduler.");
    if (legacyTasks) {
      db.exec("DROP TRIGGER IF EXISTS scheduled_attachment_removed");
      db.exec(
        "ALTER TABLE scheduled_occurrences ADD COLUMN response TEXT; ALTER TABLE scheduled_occurrences ADD COLUMN result_format TEXT; ALTER TABLE scheduled_occurrences ADD COLUMN private_payloads INTEGER NOT NULL DEFAULT 0",
      );
      const message = db.prepare(`SELECT * FROM week3_history_events WHERE sessionId=? AND type='message'
        AND json_extract(payload,'$.role')='assistant' AND json_extract(payload,'$.runId')=? ORDER BY sequence DESC LIMIT 1`);
      const save = db.prepare(
        "UPDATE scheduled_occurrences SET response=?,private_payloads=? WHERE id=?",
      );
      for (const t of db.prepare("SELECT id,session_id FROM scheduled_tasks").all()) {
        const scope = store.scope(true, t.session_id);
        const view = store.historyView(scope);
        const restricted = !!db
          .prepare("SELECT 1 FROM invariant_audit_log WHERE session_id=? LIMIT 1")
          .get(scope.key);
        for (const o of db.prepare("SELECT id FROM scheduled_occurrences WHERE task_id=?").all(t.id)) {
          const event = message.get(t.session_id, o.id);
          save.run(
            event
              ? (view({ ...event, payload: JSON.parse(event.payload) }).payload?.text ?? null)
              : null,
            +restricted,
            o.id,
          );
        }
      }
      db.exec(`ALTER TABLE scheduled_tasks DROP COLUMN session_id;
        ALTER TABLE scheduled_tasks ADD COLUMN review_definition INTEGER NOT NULL DEFAULT 0;
        UPDATE scheduled_tasks SET enabled=0,review_definition=1,revision=revision+1;
        ALTER TABLE scheduled_task_tools ADD COLUMN policy_mode TEXT NOT NULL DEFAULT 'review'; ALTER TABLE scheduled_task_tools ADD COLUMN approved_grants TEXT`);
    }
    if (runs.length && !runs.includes("task_id")) {
      const schema = db
        .prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='week4_runs'")
        .get().sql;
      if (db.prepare("SELECT 1 FROM sqlite_schema WHERE tbl_name='week4_runs' AND type='trigger'").get())
        throw Error("Unsupported execution journal trigger.");
      const indices = db
        .prepare(
          "SELECT sql FROM sqlite_schema WHERE tbl_name='week4_runs' AND type='index' AND sql IS NOT NULL",
        )
        .all();
      if (!/session_id TEXT NOT NULL REFERENCES week3_sessions/i.test(schema))
        throw Error("Unsupported execution journal layout.");
      db.exec(
        schema
          .replace(/CREATE TABLE (?:IF NOT EXISTS )?week4_runs/i, "CREATE TABLE migrated_runs")
          .replace(
            /session_id TEXT NOT NULL REFERENCES/i,
            "task_id TEXT REFERENCES scheduled_tasks(id) ON DELETE CASCADE, session_id TEXT REFERENCES",
          )
          .replace(/\)\s*$/, ",CHECK((session_id IS NULL) <> (task_id IS NULL)))"),
      );
      const cols = runs.join(",");
      db.exec(`INSERT INTO migrated_runs(${cols}) SELECT ${cols} FROM week4_runs`);
      if (legacyTasks)
        db.exec(`UPDATE migrated_runs SET session_id=NULL,task_id=(SELECT task_id FROM scheduled_occurrences WHERE id=migrated_runs.id)
        WHERE EXISTS(SELECT 1 FROM scheduled_occurrences WHERE id=migrated_runs.id)`);
      db.exec("DROP TABLE week4_runs; ALTER TABLE migrated_runs RENAME TO week4_runs");
      for (const index of indices) db.exec(index.sql);
    }
    if (db.prepare("PRAGMA foreign_key_check").get())
      throw Error("Scheduler migration failed referential integrity check.");
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  } finally {
    db.exec("PRAGMA foreign_keys=ON");
  }
}
