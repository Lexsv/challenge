// Trusted, in-process task repository shared by manual submissions and the scheduling loop.
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { InvariantError } from "./invariant-turn.mjs";
import { catalogRows } from "./mcp-repository.mjs";
import {
  policyDigest,
  readGrants,
  readMcpPolicy,
} from "./mcp-execution-policy.mjs";
import { catalogIssue } from "./week4-tool-routing.mjs";

const deny = () => {
  throw new InvariantError(
    403,
    "Scheduled task authorization is unavailable or revoked.",
  );
};
const invalid = () => {
  throw new InvariantError(400, "Invalid scheduled task configuration.");
};
const instant = (n) =>
  Number.isSafeInteger(n) && n >= 0 && n <= 8640000000000000;
const keys = (value, allowed) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).every((key) => allowed.includes(key));

function scheduleValue(value) {
  if (
    value?.kind === "once" &&
    keys(value, ["kind", "at"]) &&
    instant(value.at)
  )
    return { kind: "once", at: value.at };
  if (
    value?.kind === "interval" &&
    keys(value, ["kind", "startAt", "everyMs"]) &&
    instant(value.startAt) &&
    Number.isSafeInteger(value.everyMs) &&
    value.everyMs > 0
  )
    return { kind: "interval", startAt: value.startAt, everyMs: value.everyMs };
  invalid();
}

export function createScheduledTasks(
  db,
  { now = Date.now, readMcpPolicy: policy = readMcpPolicy, providerAvailable, log },
) {
  transaction(() => {
    db.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY, review_definition INTEGER NOT NULL DEFAULT 0,
      instructions TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, schedule TEXT NOT NULL CHECK(json_valid(schedule)),
      timezone TEXT NOT NULL, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), revision INTEGER NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS mcp_scheduled_tool_owner ON mcp_tools(connection_id,id);
    CREATE TABLE IF NOT EXISTS scheduled_task_tools (
      task_id TEXT NOT NULL REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
      connection_id TEXT NOT NULL REFERENCES mcp_connections(id) ON DELETE CASCADE,
      tool_id TEXT NOT NULL, connection_revision INTEGER NOT NULL, definition TEXT NOT NULL, policy_mode TEXT NOT NULL, approved_grants TEXT,
      PRIMARY KEY(task_id, tool_id),
      FOREIGN KEY(connection_id,tool_id) REFERENCES mcp_tools(connection_id,id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS scheduled_occurrences (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
      task_revision INTEGER NOT NULL, due_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
      started_at INTEGER, rejected_at INTEGER, rejection TEXT,response TEXT,result_format TEXT, private_payloads INTEGER NOT NULL DEFAULT 0, UNIQUE(task_id,due_at));
    CREATE TRIGGER IF NOT EXISTS scheduled_grant_removed AFTER DELETE ON scheduled_task_tools BEGIN
      UPDATE scheduled_tasks SET enabled=0,revision=revision+1,updated_at=CAST(unixepoch('subsec')*1000 AS INTEGER) WHERE id=OLD.task_id;
    END;
    CREATE TRIGGER IF NOT EXISTS scheduled_tool_withdrawn AFTER UPDATE OF present ON mcp_tools
      WHEN OLD.present=1 AND NEW.present=0 BEGIN
      DELETE FROM scheduled_task_tools WHERE tool_id=NEW.id;
    END;`);
    if (!db.prepare("SELECT 1 FROM pragma_table_info('scheduled_occurrences') WHERE name='reviewed_at'").get())
      db.exec("ALTER TABLE scheduled_occurrences ADD COLUMN reviewed_at INTEGER");
    const columns = db.prepare("PRAGMA table_info(scheduled_tasks)").all();
    if (!columns.some((c) => c.name === "next_due_at")) {
      db.exec(`ALTER TABLE scheduled_tasks ADD COLUMN next_due_at INTEGER;
        ALTER TABLE scheduled_tasks ADD COLUMN stopped INTEGER NOT NULL DEFAULT 0 CHECK(stopped IN (0,1));
        UPDATE scheduled_tasks SET next_due_at=coalesce(json_extract(schedule,'$.at'),json_extract(schedule,'$.startAt'));`);
    }
    // Existing disabled schedules retain their paused/stopped lifecycle on upgrade.
    if (!columns.some(c => c.name === "pending_start"))
      db.exec("ALTER TABLE scheduled_tasks ADD COLUMN pending_start INTEGER NOT NULL DEFAULT 0 CHECK(pending_start IN (0,1))");
    if (!columns.some(c => c.name === "deletion_state")) {
      db.exec("ALTER TABLE scheduled_tasks ADD COLUMN deletion_state INTEGER NOT NULL DEFAULT 0 CHECK(deletion_state IN (0,1,2))");
    }
    db.exec("CREATE INDEX IF NOT EXISTS scheduled_deleting ON scheduled_tasks(id) WHERE deletion_state=1");
    if (!columns.some((c) => c.name === "name")) {
      db.exec(
        "ALTER TABLE scheduled_tasks ADD COLUMN name TEXT; UPDATE scheduled_tasks SET name=substr(trim(instructions),1,80)",
      );
    }
    db.exec(
      "CREATE INDEX IF NOT EXISTS scheduled_due ON scheduled_tasks(next_due_at) WHERE enabled=1",
    );
  });

  const taskRow = db.prepare("SELECT * FROM scheduled_tasks WHERE id=?");
  const grants = db.prepare(
    "SELECT * FROM scheduled_task_tools WHERE task_id=? ORDER BY connection_id,tool_id",
  );
  const occurrence = db.prepare(
    "SELECT * FROM scheduled_occurrences WHERE id=?",
  );
  function transaction(fn) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  function task(id, includeDeleting = false) {
    const row = taskRow.get(id);
    if (!row || row.deletion_state === 2) throw new InvariantError(404, "Scheduled task not found.");
    if (row.deletion_state && !includeDeleting) throw new InvariantError(409, "Task deletion is in progress.");
    return row;
  }
  function getTask(id, archived = false) {
    const row = archived ? taskRow.get(id) : task(id, true);
    if (!row) throw new InvariantError(404,"Scheduled task not found.");
    const permissions = grants
      .all(id)
      .map((p) => ({ connectionId: p.connection_id, toolId: p.tool_id }));
    return {
      ...row,
      schedulingState: row.pending_start || row.stopped || row.deletion_state ? "Stopped" : row.enabled ? "Running" : "Paused",
      stopped: !!row.stopped,
      enabled: !!row.enabled,
      schedule: JSON.parse(row.schedule),
      permissions,
    };
  }
  // A task grant can narrow deployment policy but cannot import another owner's grants.
  function grantPolicy(row, owner, mode, approved) {
    const rules = policy();
    if (
      !Array.isArray(rules) ||
      (row.autoApprove &&
        row.approvedDefinition !== policyDigest(JSON.parse(row.document)))
    )
      return [];
    if (
      mode === "managed" ||
      rules.length ||
      process.env.DAY18_MCP_EXECUTION_POLICY_FILE
    )
      return rules.filter(
        (g) =>
          g?.schedulerScope === true &&
          g.sessionId === undefined &&
          (!approved || approved.includes(policyDigest(g))),
      );
    if (mode !== "task") return [];
    return [
      {
        sessionId: owner,
        connectionId: row.connectionId,
        toolId: row.toolId,
        revision: row.revision,
        definition: policyDigest(JSON.parse(row.document)),
        catalogScope: true,
        attachedCatalog: true,
        safety: "side-effecting",
      },
    ];
  }
  function policyMode() {
    const rules = policy();
    return !Array.isArray(rules) ||
      rules.length ||
      process.env.DAY18_MCP_EXECUTION_POLICY_FILE
      ? "managed"
      : "task";
  }
  function currentTool(owner, permission) {
    const [row] = catalogRows(db, permission.tool_id);
    if (
      !row ||
      row.connectionId !== permission.connection_id ||
      catalogIssue(row, now()) ||
      !readGrants(
        row,
        () =>
          grantPolicy(
            row,
            owner,
            permission.policy_mode,
            JSON.parse(permission.approved_grants ?? "null"),
          ),
        owner,
      ).length
    )
      deny();
    return row;
  }
  function saveGrants(id, permissions, previous = new Map()) {
    if (!Array.isArray(permissions) || permissions.length > 512) invalid();
    const selected = new Set();
    for (const p of permissions) {
      if (
        !keys(p, ["connectionId", "toolId", "definition", "revision"]) ||
        typeof p.toolId !== "string" ||
        typeof p.connectionId !== "string" ||
        selected.has(p.toolId)
      )
        invalid();
      selected.add(p.toolId);
      const mode = policyMode();
      const row = currentTool("task:" + id, {
        connection_id: p.connectionId,
        tool_id: p.toolId,
        policy_mode: mode,
      });
      const digest = policyDigest(JSON.parse(row.document));
      if (
        p.definition !== undefined &&
        (p.definition !== digest || row.revision !== p.revision)
      )
        throw new InvariantError(
          409,
          "The tool definition changed. Reopen configuration to review its current scope.",
        );
      // Editing a task must not broaden an existing operator-limited action scope.
      const saved = previous.get(row.toolId);
      const keepScope = saved?.policy_mode === "managed" &&
        saved.connection_revision === row.revision && saved.definition === digest;
      if (keepScope) currentTool("task:" + id, saved);
      db.prepare(
        "INSERT INTO scheduled_task_tools(task_id,connection_id,tool_id,connection_revision,definition,policy_mode,approved_grants) VALUES(?,?,?,?,?,?,?)",
      ).run(
        id,
        row.connectionId,
        row.toolId,
        row.revision,
        digest,
        keepScope ? saved.policy_mode : mode,
        keepScope ? saved.approved_grants : mode === "managed"
          ? JSON.stringify(
              readGrants(
                row,
                () => grantPolicy(row, "task:" + id, mode),
                "task:" + id,
              ).map(policyDigest),
            )
          : null,
      );
    }
  }
  function validateDefinition(def) {
    if (
      !keys(def, [
        "instructions",
        "name",
        "provider",
        "model",
        "schedule",
        "timezone",
        "enabled",
        "permissions",
      ]) ||
      (def.name !== undefined &&
        (typeof def.name !== "string" ||
          !def.name.trim() ||
          def.name.length > 120)) ||
      typeof def.instructions !== "string" ||
      !def.instructions.trim() ||
      def.instructions.length > 32000 ||
      !providerAvailable(def.provider) ||
      typeof def.model !== "string" ||
      !def.model.trim() ||
      def.model.length > 200 ||
      typeof def.timezone !== "string" ||
      !def.timezone ||
      /^[+-]/.test(def.timezone) ||
      typeof def.enabled !== "boolean"
    )
      invalid();
    const schedule = scheduleValue(def.schedule);
    try {
      new Intl.DateTimeFormat("en", { timeZone: def.timezone });
    } catch {
      invalid();
    }
    return schedule;
  }
  function createTask(def) {
    const schedule = validateDefinition(def);
    if (def.enabled) throw new InvariantError(400, "Create the task before starting it.");
    const created = transaction(() => {
      const id = randomUUID(),
        at = now();
      db.prepare(
        `INSERT INTO scheduled_tasks(id,instructions,provider,model,schedule,timezone,enabled,pending_start,revision,created_at,updated_at,next_due_at,name)
        VALUES(?,?,?,?,?,?,0,1,1,?,?,NULL,?)`,
      ).run(
        id,
        def.instructions,
        def.provider,
        def.model,
        JSON.stringify(schedule),
        def.timezone,
        at,
        at,
        def.name?.trim() ?? def.instructions.trim().slice(0, 80),
      );
      saveGrants(id, def.permissions === undefined ? [] : def.permissions);
      return getTask(id);
    });
    log?.("task_created", {taskId:created.id, state:"Pending"});
    return created;
  }
  function editDefinition(id, revision, def) {
    const schedule = validateDefinition(def);
    return transaction(() => {
      const current = task(id);
      if (
        current.revision !== revision ||
        (current.enabled && !["Failed","Finished","Requires review"].includes(lifecycle(current))) ||
        running(id)
      )
        throw new InvariantError(
          409,
          "Pause the task and wait for active executions or review before editing.",
        );
      const encoded = JSON.stringify(schedule);
      // Reconcile only undispatched slots. Receipts for admitted runs remain immutable.
      const aligned =
        schedule.kind === "once"
          ? "due_at=?"
          : "(due_at>=? AND (due_at-?) % ?=0)";
      const args =
        schedule.kind === "once"
          ? [schedule.at]
          : [schedule.startAt, schedule.startAt, schedule.everyMs];
      db.prepare(
        `UPDATE scheduled_occurrences SET rejected_at=?,rejection='missed_slot'
        WHERE task_id=? AND started_at IS NULL AND rejection IS NULL AND NOT (${aligned})`,
      ).run(now(), id, ...args);
      db.prepare(
        "UPDATE scheduled_occurrences SET task_revision=? WHERE task_id=? AND started_at IS NULL AND rejection IS NULL",
      ).run(revision + 1, id);
      const previous = new Map(grants.all(id).map(grant => [grant.tool_id, grant]));
      db.prepare("DELETE FROM scheduled_task_tools WHERE task_id=?").run(id);
      saveGrants(id, def.permissions, previous);
      db.prepare(
        `UPDATE scheduled_tasks SET enabled=0,stopped=CASE WHEN enabled=1 THEN 1 ELSE stopped END,review_definition=0,name=?,instructions=?,provider=?,model=?,timezone=?,schedule=?,
        next_due_at=?,revision=?,updated_at=? WHERE id=?`,
      ).run(
        def.name.trim(),
        def.instructions,
        def.provider,
        def.model,
        def.timezone,
        encoded,
        current.pending_start || encoded === current.schedule
          ? current.next_due_at
          : (schedule.at ?? schedule.startAt),
        revision + 1,
        now(),
        id,
      );
      return getTask(id);
    });
  }
  function toolChoices() {
    const owner = "task:configuration",
      mode = policyMode();
    return catalogRows(db).map((row) => ({
      connectionId: row.connectionId,
      server: row.connectionName,
      toolId: row.toolId,
      name: row.originalName,
      eligible:
        !!row.toolId &&
        !catalogIssue(row, now()) &&
        readGrants(row, () => grantPolicy(row, owner, mode), owner).length > 0,
      definition: row.toolId ? policyDigest(JSON.parse(row.document)) : null,
      revision: row.revision,
    }));
  }
  function rows(id, toolId) {
    const selected = new Set(grants.all(id).map((p) => p.tool_id));
    return catalogRows(db, toolId).filter((tool) => selected.has(tool.toolId));
  }
  function configure(id, expectedRevision, changes) {
    if (
      !keys(changes, ["enabled", "permissions"]) ||
      !Object.keys(changes).length ||
      ("enabled" in changes && typeof changes.enabled !== "boolean")
    )
      invalid();
    return transaction(() => {
      const current = task(id);
      if (current.revision !== expectedRevision)
        throw new InvariantError(409, "Scheduled task changed.");
      if ("permissions" in changes) {
        db.prepare("DELETE FROM scheduled_task_tools WHERE task_id=?").run(id);
        saveGrants(id, changes.permissions);
      }
      if (changes.enabled && current.review_definition) deny();
      if (changes.enabled && (current.stopped || current.pending_start))
        throw new InvariantError(
          409,
          "Use Start to activate this schedule.",
        );
      db.prepare(
        "UPDATE scheduled_tasks SET enabled=?,revision=?,updated_at=? WHERE id=?",
      ).run(
        +(changes.enabled ?? current.enabled),
        expectedRevision + 1,
        now(),
        id,
      );
      return getTask(id);
    });
  }
  function materialize(taskId, dueAt) {
    if (!instant(dueAt)) invalid();
    return transaction(() => {
      const current = task(taskId),
        schedule = JSON.parse(current.schedule);
      if (
        schedule.kind === "once"
          ? dueAt !== schedule.at
          : dueAt < schedule.startAt ||
            (dueAt - schedule.startAt) % schedule.everyMs !== 0
      )
        invalid();
      return slot(current, dueAt).id;
    });
  }
  // All callers hold BEGIN IMMEDIATE.
  function slot(current, dueAt) {
    const existing = db
      .prepare(
        "SELECT * FROM scheduled_occurrences WHERE task_id=? AND due_at=?",
      )
      .get(current.id, dueAt);
    if (existing) return existing;
    if (!current.enabled) deny();
    const id = randomUUID();
    db.prepare(
      "INSERT INTO scheduled_occurrences(id,task_id,task_revision,due_at,created_at) VALUES(?,?,?,?,?)",
    ).run(id, current.id, current.revision, dueAt, now());
    return occurrence.get(id);
  }
  function skipOlderSlots(id, before, at) {
    db.prepare(
      `UPDATE scheduled_occurrences SET rejected_at=?,rejection='missed_slot'
      WHERE task_id=? AND due_at<? AND started_at IS NULL AND rejection IS NULL`,
    ).run(at, id, before);
  }
  function running(id) {
    return !!db.prepare("SELECT 1 FROM week4_runs WHERE task_id=? AND owner IS NOT NULL LIMIT 1").get(id);
  }
  function reviewIds(id) {
    // Only skip a hold when the durable operation policies establish read-only
    // execution. Missing records or dispatched writes remain conservative.
    return db.prepare(`SELECT o.id FROM scheduled_occurrences o LEFT JOIN week4_runs r ON r.id=o.id
      WHERE o.task_id=? AND o.started_at IS NOT NULL AND o.reviewed_at IS NULL AND
        (r.id IS NULL OR (r.state='RequiresReview' AND (
          NOT EXISTS(SELECT 1 FROM week4_operations p WHERE p.run_id=r.id AND p.kind='tool' AND p.safety='read-only')
          OR EXISTS(SELECT 1 FROM week4_operations p
            WHERE p.run_id=r.id AND p.kind='tool' AND p.safety<>'read-only')))) ORDER BY o.id`).all(id).map(r=>r.id);
  }
  function lifecycle(row) {
    if (row.deletion_state) return row.deletion_state===2 ? "Deleted" : "Deleting";
    if (reviewIds(row.id).length) return "Requires review";
    if (row.stopped) return "Stopped";
    if (row.review_definition) return "Review configuration";
    if (row.pending_start) return "Pending";
    if (!row.enabled) return "Paused";
    if (running(row.id)) return "Running";
    if (row.next_due_at!==null) return "Scheduled";
    const last=db.prepare("SELECT id FROM scheduled_occurrences WHERE task_id=? ORDER BY due_at DESC LIMIT 1").get(row.id);
    return last && ["Failed","PartialSuccess","RequiresReview"].includes(getOccurrence(last.id).state) ? "Failed" : "Finished";
  }
  function acknowledgeReview(id,input) {
    const updated=transaction(()=>{
      const current=task(id), ids=reviewIds(id);
      if (running(id) || !ids.length || input?.confirmed!==true || input.revision!==current.revision ||
          !Array.isArray(input.occurrenceIds) || JSON.stringify(ids)!==JSON.stringify(input.occurrenceIds))
        throw new InvariantError(409,"Refresh and confirm the current executions requiring review.");
      for(const occurrenceId of ids)
        db.prepare("UPDATE scheduled_occurrences SET reviewed_at=? WHERE id=?").run(now(),occurrenceId);
      db.prepare("UPDATE scheduled_tasks SET stopped=1,enabled=0,updated_at=? WHERE id=?").run(now(),id);
      return getTask(id);
    });
    log?.("task_review_confirmed",{taskId:id,previousState:"Requires review",state:"Stopped"});
    return updated;
  }
  function changeLifecycle(id, action, ifMatch) {
    let changed=false, previousState, restart=false, previouslyRun=false;
    const updated=transaction(()=>{
      const current=task(id);
      if (ifMatch !== undefined && ifMatch !== `"${current.revision}-${current.updated_at}"`)
        throw new InvariantError(409,"The schedule changed. Refresh its controls and try again.");
      previousState=lifecycle(current);
      const active=action==="start" || action==="resume", stopped=action==="stop";
      if (!["start","resume","stop","pause"].includes(action)) invalid();
      if (current.pending_start && action !== "start")
        throw new InvariantError(409,"Only Start can activate a pending task.");
      if (active && current.review_definition) deny();
      if (active && previousState==="Requires review")
        throw new InvariantError(409,"Review the uncertain execution before enabling scheduling.");
      // Resume persists the scheduling intention immediately. The admission fence
      // holds the next slot until the existing owner finishes and review is clear.
      if (action==="resume" && ["Scheduled","Running"].includes(previousState)) return getTask(id);
      if (action==="start" && running(id))
        throw new InvariantError(409,"A new Start is unavailable while the previous execution is finishing.");
      if (action==="resume" && previousState!=="Paused" || action==="pause" && !["Scheduled","Running","Paused"].includes(previousState))
        throw new InvariantError(409,"This lifecycle transition is unavailable.");
      previouslyRun=action==="start" && !!db.prepare("SELECT 1 FROM scheduled_occurrences WHERE task_id=? AND (started_at IS NOT NULL OR rejection IS NOT NULL) LIMIT 1").get(id);
      restart=action==="start" && !current.pending_start && current.next_due_at===null;
      if (!restart && !!current.enabled===active && !!current.stopped===stopped) return getTask(id);
      changed=true;
      const at = now(),
        schedule = JSON.parse(current.schedule);
      let next = current.pending_start ? (schedule.at ?? schedule.startAt) : current.next_due_at;
      if (restart && schedule.kind==="once") {
        const last=db.prepare("SELECT max(due_at) AS due FROM scheduled_occurrences WHERE task_id=?").get(id);
        next=Math.max(at,(last.due??0)+1);
        db.prepare("UPDATE scheduled_tasks SET schedule=? WHERE id=?").run(JSON.stringify({kind:"once",at:next}),id);
      }
      if (
        active &&
        schedule.kind === "interval" &&
        next !== null &&
        next < at
      ) {
        next =
          schedule.startAt +
          Math.ceil((at - schedule.startAt) / schedule.everyMs) *
            schedule.everyMs;
        skipOlderSlots(id, next, at);
        if (!instant(next)) next = null;
      }
      // Lifecycle controls stop admission. The existing permission revision still
      // fences actual permission edits, including during an admitted execution.
      db.prepare(
        "UPDATE scheduled_tasks SET enabled=?,stopped=?,pending_start=0,next_due_at=?,updated_at=max(updated_at+1,?) WHERE id=?",
      ).run(+active, +stopped, next, at, id);
      return getTask(id);
    });
    if (changed && previouslyRun) log?.("task_restart_requested",{taskId:id,previousState,state:lifecycle(updated)});
    if (changed) log?.({start:"task_started", pause:"task_paused", resume:"task_resumed", stop:"task_stopped"}[action],
      {taskId:id,previousState,state:lifecycle(updated)});
    return updated;
  }

  // Keep the task identity as the foreign-key parent of immutable history.
  // Admission and retirement share the same SQLite write fence. Already admitted
  // runs retain their exact grants until their journal owner releases the run.
  function finishDeletion(id) {
    const completed = transaction(() => {
      if (taskRow.get(id)?.deletion_state !== 1 ||
          db.prepare("SELECT 1 FROM week4_runs WHERE task_id=? AND owner IS NOT NULL LIMIT 1").get(id)) return false;
      db.prepare("DELETE FROM scheduled_task_tools WHERE task_id=?").run(id);
      db.prepare("UPDATE scheduled_tasks SET deletion_state=2,updated_at=? WHERE id=?").run(now(), id);
      return true;
    });
    if (completed) log?.("task_deleted", {taskId:id,previousState:"Deleting",state:"Deleted"});
  }
  function recoverDeletions() {
    for (const {id} of db.prepare("SELECT id FROM scheduled_tasks WHERE deletion_state=1").all()) finishDeletion(id);
  }
  async function deleteTask(id) {
    try {
      let previousState;
      const requested = transaction(() => {
        const row = taskRow.get(id);
        if (!row) throw new InvariantError(404, "Scheduled task not found.");
        if (row.deletion_state) return false;
        previousState=lifecycle(row);
        db.prepare("UPDATE scheduled_tasks SET deletion_state=1,enabled=0,stopped=1,next_due_at=NULL,updated_at=? WHERE id=?").run(now(),id);
        db.prepare("UPDATE scheduled_occurrences SET rejection='task_deleted',rejected_at=? WHERE task_id=? AND started_at IS NULL AND rejection IS NULL").run(now(),id);
        return true;
      });
      if (requested) log?.("task_delete_requested", {taskId:id,previousState,state:"Deleting"});
      finishDeletion(id);
      while (taskRow.get(id)?.deletion_state === 1) {
        await delay(250);
        finishDeletion(id);
      }
      return {id, deleted:true};
    } catch (error) {
      log?.("task_delete_failed", {taskId:id, state:"Failed", code:error.status===404 ? "unknown_task" : "persistence"});
      if (error instanceof InvariantError) throw error;
      const reason = {5:"Scheduler storage is busy. Retry deletion.", 8:"Scheduler storage is read-only.", 13:"Scheduler storage is full."}[error.errcode & 255];
      throw new InvariantError(503, reason ?? "Scheduler storage could not confirm task deletion. Retry deletion.");
    }
  }
  function blockedByPriorRun(taskId) {
    return running(taskId) || reviewIds(taskId).length>0;
  }
  function advance(current, dueAt) {
    const schedule = JSON.parse(current.schedule);
    const next = schedule.kind === "interval" ? dueAt + schedule.everyMs : null;
    db.prepare(
      "UPDATE scheduled_tasks SET next_due_at=? WHERE id=? AND next_due_at=?",
    ).run(instant(next) ? next : null, current.id, dueAt);
  }
  function dueTasks(afterId, limit) {
    return db
      .prepare(
        `SELECT id FROM scheduled_tasks WHERE enabled=1 AND next_due_at<=?
      AND id>? ORDER BY id LIMIT ?`,
      )
      .all(now(), afterId, limit);
  }
  function prepareDue(id) {
    return transaction(() => {
      const current = task(id),
        at = now();
      if (
        !current.enabled ||
        current.next_due_at === null ||
        current.next_due_at > at ||
        blockedByPriorRun(id)
      )
        return null;
      const schedule = JSON.parse(current.schedule);
      let due = current.next_due_at;
      if (schedule.kind === "interval") {
        const latest = at - ((at - schedule.startAt) % schedule.everyMs);
        // A busy task or a crash before claim can leave an undispatched slot.
        // Supersede it explicitly when coalescing; never abandon a dispatched run.
        if (latest > due) {
          skipOlderSlots(id, latest, at);
          due = latest;
          db.prepare("UPDATE scheduled_tasks SET next_due_at=? WHERE id=?").run(
            due,
            id,
          );
        }
      }
      const item = slot(current, due);
      if (item.started_at !== null || item.rejection !== null) {
        advance(current, due);
        return null;
      }
      return item.id;
    });
  }
  function getOccurrence(id) {
    const row = occurrence.get(id);
    if (!row) throw new InvariantError(404, "Scheduled occurrence not found.");
    const run = db
      .prepare(
        "SELECT session_id,state,answer,error,updated,owner FROM week4_runs WHERE id=?",
      )
      .get(id);
    // A claim and its journal row commit together. Missing evidence for a
    // previously claimed occurrence must never make it eligible again.
    const operationCode = run && ["Failed","PartialSuccess","RequiresReview"].includes(run.state)
      ? db.prepare("SELECT json_extract(error,'$.code') AS code FROM week4_operations WHERE run_id=? AND error IS NOT NULL AND state IN ('Failed','Unknown') ORDER BY rowid LIMIT 1").get(id)?.code : null;
    const missingRun = row.started_at !== null && !run;
    const unclaimedState =
      ["missed_slot","task_deleted"].includes(row.rejection)
        ? "Cancelled"
        : row.rejection
          ? "Failed"
          : "Pending";
    return {
      ...row,
      state: run?.state ?? (missingRun ? "RequiresReview" : unclaimedState),
      finished_at: run && run.owner === null ? run.updated : row.rejected_at,
      ...(run?.error && JSON.parse(run.error)?.resolutionIssues && { resolutionIssues: JSON.parse(run.error).resolutionIssues }),
      result: run ? { answer: run.answer, response: row.response } : null,
      error: missingRun
        ? "recovery"
        : (row.rejection ??
          (run?.error ? (JSON.parse(run.error)?.code ?? operationCode ?? null) : operationCode ?? null)),
    };
  }
  function enabled(id, session) {
    return !!db
      .prepare(
        `SELECT 1 FROM scheduled_occurrences o JOIN scheduled_tasks t ON t.id=o.task_id
      WHERE o.id=? AND t.id=? AND t.review_definition=0 AND t.revision=o.task_revision AND o.rejection IS NULL`,
      )
      .get(id, session.slice(5));
  }
  // Called inside the execution journal's BEGIN IMMEDIATE, before its run INSERT.
  function admit(session, input, scheduled) {
    const row = occurrence.get(input.turnId);
    if (!row && !scheduled) return;
    if (
      !row ||
      !scheduled ||
      session !== "task:" + row.task_id ||
      !enabled(row.id, session)
    )
      deny();
    const current = task(row.task_id);
    if (
      current.instructions !== input.question ||
      current.provider !== input.provider ||
      current.model !== input.model
    )
      deny();
    if (!current.enabled)
      throw new InvariantError(409, "Schedule is paused or stopped.");
    if (blockedByPriorRun(current.id))
      throw new InvariantError(
        409,
        "A previous occurrence is active or requires review.",
      );
    if (row.due_at > now())
      throw new InvariantError(409, "Occurrence is not due.");
    for (const permission of grants.all(current.id)) {
      const tool = currentTool(session, permission);
      if (
        tool.revision !== permission.connection_revision ||
        policyDigest(JSON.parse(tool.document)) !== permission.definition
      )
        deny();
    }
    if (
      !db
        .prepare(
          "UPDATE scheduled_occurrences SET started_at=? WHERE id=? AND started_at IS NULL",
        )
        .run(now(), row.id).changes
    )
      throw new InvariantError(409, "Occurrence already claimed.");
    advance(current, row.due_at);
  }
  function restrict(id, owner) {
    const occurrenceRow = occurrence.get(id);
    return (tool) => {
      if (!occurrenceRow || !enabled(id, owner)) return [];
      const grant = db
        .prepare(
          "SELECT * FROM scheduled_task_tools WHERE task_id=? AND tool_id=? AND connection_id=?",
        )
        .get(occurrenceRow.task_id, tool.toolId, tool.connectionId);
      if (
        !grant ||
        grant.connection_revision !== tool.revision ||
        grant.definition !== policyDigest(JSON.parse(tool.document))
      )
        return [];
      return grantPolicy(
        tool,
        owner,
        grant.policy_mode,
        JSON.parse(grant.approved_grants),
      );
    };
  }
  async function executeOccurrence(id, executeTurn) {
    const item = getOccurrence(id);
    if (item.state !== "Pending") return item;
    const current = task(item.task_id);
    try {
      await executeTurn(current, {
        turnId: id,
        question: current.instructions,
        model: current.model,
        provider: current.provider,
      });
    } catch (error) {
      // Busy, early, or concurrently claimed: leave a pending occurrence eligible.
      if (error.status === 409) {
        const latest = getOccurrence(id);
        if (latest.state !== "Pending") return latest;
        throw error;
      }
      const code =
        error.status === 403
          ? "authorization"
          : error.status === 422
            ? "validation"
            : "execution_error";
      transaction(() => {
        const rejected = db
          .prepare(
            "UPDATE scheduled_occurrences SET rejection=?,rejected_at=? WHERE id=? AND started_at IS NULL AND rejection IS NULL",
          )
          .run(code, now(), id);
        if (rejected.changes) advance(current, item.due_at);
      });
    }
    return getOccurrence(id);
  }
  return {
    createTask,
    editDefinition,
    toolChoices,
    rows,
    lifecycle, running, reviewIds, acknowledgeReview, changeLifecycle,
    deleteTask,
    recoverDeletions,
    dueTasks,
    prepareDue,
    getTask,
    configure,
    materialize,
    getOccurrence,
    executeOccurrence,
    reserved: (id) => !!occurrence.get(id),
    enabled,
    restrict,
    admit,
  };
}
