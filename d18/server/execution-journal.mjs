import { randomUUID } from "node:crypto";
import {
  assertTransition,
  callTransitions,
  runTransitions,
} from "../src/execution-policy.ts";

const enumSql = (variants) =>
  Object.keys(variants)
    .map((name) => "'" + name + "'")
    .join(",");
// No prompt, provider response body, transport configuration or credential is journaled.
export class ExecutionJournal {
  constructor(
    db,
    {
      now = Date.now,
      owner = randomUUID(),
      leaseMs = 30000,
      capacity = 128,
      publish = () => {},
    } = {},
  ) {
    Object.assign(this, { db, now, owner, leaseMs, capacity, publish });
    this.tail = Promise.resolve();
    this.queued = 0;
    this.transaction(() =>
      db.exec(`
      CREATE TABLE IF NOT EXISTS week4_runs (
        id TEXT PRIMARY KEY, task_id TEXT ${db.prepare("SELECT 1 FROM sqlite_schema WHERE name='scheduled_tasks' AND type='table'").get() ? "REFERENCES scheduled_tasks(id) ON DELETE CASCADE" : ""}, session_id TEXT REFERENCES week3_sessions(id) ON DELETE CASCADE,
        request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN (${enumSql(runTransitions)})),
        answer TEXT NOT NULL DEFAULT 'pending', owner TEXT, lease_until INTEGER, created INTEGER NOT NULL,
        updated INTEGER NOT NULL, retry_deadline INTEGER NOT NULL, error TEXT, context_version TEXT, UNIQUE(session_id,request_id),CHECK((session_id IS NULL) <> (task_id IS NULL)));
      CREATE TABLE IF NOT EXISTS week4_operations (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES week4_runs(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK(kind IN ('tool','llm')), provider_call_hash TEXT, parent_llm_id TEXT REFERENCES week4_operations(id),
        logical_key TEXT NOT NULL, target TEXT NOT NULL, connection_key TEXT NOT NULL, safety TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN (${enumSql(callTransitions)})), arguments TEXT, result TEXT, error TEXT,
        created INTEGER NOT NULL, ended INTEGER, deadline INTEGER NOT NULL, next_retry INTEGER, max_attempts INTEGER NOT NULL,
        UNIQUE(run_id,kind,logical_key));
      CREATE TABLE IF NOT EXISTS week4_attempts (
        id TEXT PRIMARY KEY, operation_id TEXT NOT NULL REFERENCES week4_operations(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL, started INTEGER NOT NULL, ended INTEGER, state TEXT NOT NULL, error TEXT,
        UNIQUE(operation_id,ordinal));
      CREATE TABLE IF NOT EXISTS week4_checkpoints (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES week4_runs(id) ON DELETE CASCADE,
        operation_id TEXT, attempt_id TEXT, event TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS week4_recover ON week4_runs(state,lease_until);
      CREATE INDEX IF NOT EXISTS week4_checkpoint_run ON week4_checkpoints(run_id);
      `),
    );
    // Existing operations have no external approval and retain their original recovery behavior.
    this.transaction(()=>{
      if (!db.prepare("PRAGMA table_info(week4_operations)").all().some(r=>r.name==="policy_grant"))
        db.exec("ALTER TABLE week4_operations ADD COLUMN policy_grant TEXT");
      if (!db.prepare("PRAGMA table_info(week4_operations)").all().some(r=>r.name==="display"))
        db.exec("ALTER TABLE week4_operations ADD COLUMN display TEXT");
      if (!db.prepare("PRAGMA table_info(week4_checkpoints)").all().some(r=>r.name==="capture"))
        db.exec("ALTER TABLE week4_checkpoints ADD COLUMN capture TEXT");
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS week4_one_shot_grant ON week4_operations(policy_grant)
        WHERE safety='side-effecting' AND policy_grant IS NOT NULL`);
    });
  }
  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  run(id) {
    return this.db.prepare("SELECT * FROM week4_runs WHERE id=?").get(id);
  }
  op(id) {
    return this.db.prepare("SELECT * FROM week4_operations WHERE id=?").get(id);
  }
  operations(runId) {
    return this.db
      .prepare("SELECT * FROM week4_operations WHERE run_id=? ORDER BY rowid")
      .all(runId);
  }
  attempts(id) {
    return this.db
      .prepare(
        "SELECT * FROM week4_attempts WHERE operation_id=? ORDER BY ordinal",
      )
      .all(id);
  }
  checkpoint(runId, event, op = null, attempt = null, id = randomUUID()) {
    this.db
      .prepare("INSERT INTO week4_checkpoints(id,run_id,operation_id,attempt_id,event,at) VALUES(?,?,?,?,?,?)")
      .run(id, runId, op, attempt, event, this.now());
  }
  begin(session, request, fingerprint, contextVersion, deadline, admit) {
    return this.transaction(() => {
      if (this.run(request)) throw new Error("This execution already exists.");
      admit?.();
      const at = this.now();
      this.db
        .prepare(
          `INSERT INTO week4_runs(id,session_id,task_id,request_id,fingerprint,state,owner,lease_until,created,updated,context_version,retry_deadline)
        VALUES(?,?,?,?,?,'Pending',?,?,?,?,?,?)`,
        )
        .run(
          request,
          session.startsWith("task:") ? null : session,
          session.startsWith("task:") ? session.slice(5) : null,
          request,
          fingerprint,
          this.owner,
          at + this.leaseMs,
          at,
          at,
          contextVersion ?? null,
          deadline,
        );
      this.checkpoint(request, "Pending");
      this.moveRun(request, "Running");
    });
  }
  fence(id) {
    const row = this.run(id);
    if (!row || row.owner !== this.owner || row.lease_until <= this.now())
      throw new Error("Execution ownership expired.");
    return row;
  }
  moveRun(id, state) {
    assertTransition("run", this.fence(id).state, state);
    this.db
      .prepare("UPDATE week4_runs SET state=?,updated=? WHERE id=?")
      .run(state, this.now(), id);
    this.checkpoint(id, state);
  }
  syncRun(id) {
    const state = this.run(id).state;
    if (state !== "Running" && state !== "WaitingForRetry") return;
    const counts = this.db
      .prepare(
        "SELECT sum(state='Running') AS running,sum(state='WaitingForRetry') AS waiting FROM week4_operations WHERE run_id=?",
      )
      .get(id);
    const next =
      counts.waiting && !counts.running ? "WaitingForRetry" : "Running";
    if (next !== state) this.moveRun(id, next);
  }
  moveOp(id, state, error = null, result = null, next = null) {
    const op = this.op(id);
    this.fence(op.run_id);
    assertTransition("call", op.state, state);
    this.db
      .prepare(
        "UPDATE week4_operations SET state=?,error=?,result=?,next_retry=?,ended=? WHERE id=?",
      )
      .run(
        state,
        error && JSON.stringify(error),
        result == null ? null : JSON.stringify(result),
        next,
        callTransitions[state].length ? null : this.now(),
        id,
      );
  }
  // Acknowledgement follows COMMIT. Concurrent producers share one bounded mailbox.
  send(
    { runId, id = randomUUID(), event, operationId = null, attemptId = null },
    apply,
  ) {
    if (this.queued >= this.capacity)
      return Promise.reject(new Error("Execution collector at capacity."));
    this.queued++;
    const task = this.tail
      .then(() => {
        const changed = this.transaction(() => {
          const saved = this.db
            .prepare("SELECT * FROM week4_checkpoints WHERE id=?")
            .get(id);
          if (saved) {
            if (
              saved.run_id !== runId ||
              saved.event !== event ||
              saved.operation_id !== operationId ||
              saved.attempt_id !== attemptId
            )
              throw new Error("Conflicting execution event.");
            return false;
          }
          this.fence(runId);
          apply();
          this.checkpoint(runId, event, operationId, attemptId, id);
          return true;
        });
        if (changed) {
          try {
            this.publish({ runId, id, event, operationId, attemptId });
          } catch {
            /* Already durable. */
          }
        }
        return changed;
      })
      .finally(() => {
        this.queued--;
      });
    this.tail = task.catch(() => {});
    return task;
  }
  claimStale(limit = 16, activeIds = []) {
    return this.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT id FROM week4_runs WHERE state IN
        ('Pending','Running','WaitingForRetry','Interrupted') AND lease_until<=? AND id NOT IN (SELECT value FROM json_each(?)) ORDER BY lease_until LIMIT ?`,
        )
        .all(this.now(), JSON.stringify(activeIds), limit);
      for (const { id } of rows) {
        this.db
          .prepare("UPDATE week4_runs SET owner=?,lease_until=? WHERE id=?")
          .run(this.owner, this.now() + this.leaseMs, id);
        if (this.run(id).state !== "Interrupted")
          this.moveRun(id, "Interrupted");
        this.checkpoint(id, "recovery_claimed");
      }
      return rows.map((row) => row.id);
    });
  }
  renew(id) {
    return (
      this.db
        .prepare(
          "UPDATE week4_runs SET lease_until=? WHERE id=? AND owner=? AND lease_until>?",
        )
        .run(this.now() + this.leaseMs, id, this.owner, this.now()).changes ===
      1
    );
  }
  stats(id) {
    const states = this.db
      .prepare(
        "SELECT state,count(*) AS count FROM week4_operations WHERE run_id=? AND kind='tool' GROUP BY state",
      )
      .all(id);
    const attempts = this.db
      .prepare(
        `SELECT count(*) AS attempts,coalesce(sum(a.ordinal>1),0) AS retries,
      coalesce(sum(a.ended-a.started),0) AS durationMs FROM week4_attempts a JOIN week4_operations o
      ON a.operation_id=o.id WHERE o.run_id=? AND o.kind='tool'`,
      )
      .get(id);
    return {
      tools: Object.fromEntries(states.map((row) => [row.state, row.count])),
      ...attempts,
    };
  }
}
