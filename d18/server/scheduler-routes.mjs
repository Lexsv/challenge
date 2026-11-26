import { localUiRequest, readConfig } from "./mcp-routes.mjs";
import { InvariantError } from "./invariant-turn.mjs";
import { sanitizedCapture } from "./journal-payload.mjs";

export function schedulerRoutes(db, tasks, journal) {
  const stats = db.prepare(`SELECT o.task_id,
    count(*) AS occurrences, count(*) FILTER (WHERE o.started_at IS NOT NULL OR o.rejection NOT IN ('missed_slot','task_deleted')) AS total,
    count(*) FILTER (WHERE r.state='Completed') AS success,
    count(*) FILTER (WHERE r.state='Failed' OR o.rejection NOT IN ('missed_slot','task_deleted')) AS failed,
    count(*) FILTER (WHERE o.rejection='authorization' OR json_extract(r.error,'$.code')='authorization'
      OR EXISTS (SELECT 1 FROM week4_operations p WHERE p.run_id=o.id AND json_extract(p.error,'$.code')='authorization')) AS denied,
    count(*) FILTER (WHERE r.state='RequiresReview' OR (o.started_at IS NOT NULL AND r.id IS NULL)) AS review,
    count(*) FILTER (WHERE r.owner IS NOT NULL) AS active, max(o.started_at) AS last
    FROM scheduled_occurrences o LEFT JOIN week4_runs r ON r.id=o.id GROUP BY o.task_id`);
  function list(archived = false) {
    const counts = new Map(stats.all().map((r) => [r.task_id, r]));
    return db
      .prepare("SELECT id FROM scheduled_tasks WHERE (deletion_state=2)=? ORDER BY name COLLATE NOCASE,id")
      .all(+archived)
      .map(({ id }) => {
        const task = tasks.getTask(id, archived);
        const metrics = counts.get(id) ?? {
          total: 0,
          occurrences: 0,
          success: 0,
          failed: 0,
          denied: 0,
          review: 0,
          active: 0,
          last: null,
        };
        const status = tasks.lifecycle(task);
        const reviewIds = tasks.reviewIds(id);
        const tools = db
          .prepare(
            `SELECT c.name AS server,t.original_name AS name FROM scheduled_task_tools p
        JOIN mcp_connections c ON p.connection_id=c.id JOIN mcp_tools t ON t.id=p.tool_id
        WHERE p.task_id=? ORDER BY c.name,t.original_name`,
          )
          .all(id);

        return {
          ...task,
          tools,
          metrics:{...metrics,review:reviewIds.length}, reviewIds, status,
        };
      }).sort((a,b)=>{
        const group=t=>["Scheduled","Running"].includes(t.status)?0:t.status==="Paused"?1:2;
        return group(a)-group(b) || (group(a)===0 ? (a.next_due_at??Infinity)-(b.next_due_at??Infinity) : 0);
      });
  }
  function history(id, offset) {
    if (!db.prepare("SELECT 1 FROM scheduled_tasks WHERE id=?").get(id)) throw new InvariantError(404, "Scheduled task not found.");
    const entries = db
      .prepare(
        "SELECT id FROM scheduled_occurrences WHERE task_id=? ORDER BY due_at DESC,id LIMIT 26 OFFSET ?",
      )
      .all(id, offset);
    const results =
      db.prepare(`SELECT target,json_extract(display,'$.name') AS name,result FROM week4_operations
      WHERE run_id=? AND kind='tool' AND state='Success' AND result IS NOT NULL ORDER BY rowid`);
    const operationError =
      db.prepare(`SELECT json_extract(error,'$.code') AS code FROM week4_operations
      WHERE run_id=? AND state IN ('Failed','Unknown') AND error IS NOT NULL ORDER BY rowid LIMIT 1`);
    return {
      hasMore: entries.length > 25,
      rows: entries.slice(0, 25).map(({ id }) => {
        const entry = tasks.getOccurrence(id);
        const structured = [];
        if (!entry.private_payloads)
          for (const op of results.all(id)) {
            const safe = sanitizedCapture(op.result);
            if (!safe) continue;
            const output = JSON.parse(safe);
            const value = op.target.startsWith("mcp:")
              ? output?.structuredContent
              : output;
            if (value && typeof value === "object")
              structured.push({
                source: op.target,
                name: op.name ?? "Tool",
                value,
              });
          }
        const error =
          entry.error ??
          (["Failed", "PartialSuccess", "RequiresReview"].includes(entry.state)
            ? operationError.get(id)?.code
            : null);
        return { ...entry, error: error ?? null, structured };
      }),
    };
  }
  return async (req, path, reply) => {
    if (!path.startsWith("/api/scheduler/")) return false;
    const send = (code, body) => {
      reply(code, body);
      return true;
    };
    if (
      !localUiRequest(req, "scheduler") ||
      req.headers["x-day18-ui"] !== "scheduler" ||
      (req.method !== "GET" &&
        req.headers.origin !== "http://" + req.headers.host)
    )
      return send(403, { error: "Open Scheduler in the local application." });
    try {
      if (req.method === "GET" && path === "/api/scheduler/catalog")
        return send(200, tasks.toolChoices());
      if (req.method==="GET" && path==="/api/scheduler/archive") return send(200,list(true));
      const log = path.match(
        /^\/api\/scheduler\/tasks\/([\w-]+)\/history\/([\w-]+)\/journal(?:\/([\w-]+))?$/,
      );
      if (log) {
        const entry = tasks.getOccurrence(log[2]);
        if (entry.task_id !== log[1])
          return send(404, { error: "Execution unavailable." });
        return journal(req, path, reply, { ...entry, operation: log[3] });
      }
      const route = path.match(
        /^\/api\/scheduler\/tasks(?:\/([\w-]+)(?:\/(history|result|review|start|pause|resume|stop))?)?$/,
      );
      if (!route) return send(404, { error: "Unknown scheduler endpoint." });
      const [, id, action] = route;
      if (req.method === "DELETE" && id && !action) return send(200, await tasks.deleteTask(id));
      if (req.method === "GET" && !id) return send(200, list());
      if (req.method === "GET" && action === "history") {
        const offset = Number(
          new URL(req.url, "http://localhost").searchParams.get("offset") ?? 0,
        );
        if (!Number.isSafeInteger(offset) || offset < 0)
          return send(400, { error: "Invalid history offset." });
        return send(200, history(id, offset));
      }
      if (req.method==="GET" && action==="result") {
        tasks.getTask(id,true);
        const row=db.prepare(`SELECT o.response FROM scheduled_occurrences o JOIN week4_runs r ON r.id=o.id
          WHERE o.task_id=? AND o.response IS NOT NULL AND r.state='Completed' ORDER BY o.due_at DESC LIMIT 1`).get(id);
        return send(200,{rows:row?[row]:[],hasMore:false});
      }
      const withStatus = task => ({ ...task, status: tasks.lifecycle(task) });
      if (req.method==="POST" && action==="review") return send(200,withStatus(tasks.acknowledgeReview(id,await readConfig(req))));
      if (req.method === "POST" && id && ["start","pause","resume","stop"].includes(action))
        return send(200, withStatus(tasks.changeLifecycle(id, action)));
      if (
        !action &&
        ((!id && req.method === "POST") || (id && req.method === "PUT"))
      ) {
        const input = await readConfig(req);
        if (!input || Array.isArray(input) || typeof input !== "object")
          return send(400, { error: "Invalid task definition." });
        const { authorized, revision, ...def } = input;
        if (
          typeof def.name !== "string" ||
          !Array.isArray(def.permissions) ||
          def.enabled !== false
        )
          return send(400, {
            error:
              "Provide a named, inactive task and an explicit tool selection.",
          });
        if (
          def.permissions.some(
            (p) =>
              !p ||
              typeof p.definition !== "string" ||
              !Number.isSafeInteger(p.revision),
          )
        )
          return send(400, { error: "Review the selected tool definitions." });
        if (def.permissions.length && authorized !== true)
          return send(403, {
            error: "Confirm unattended access to the selected tools.",
          });
        return send(
          id ? 200 : 201,
          withStatus(id ? tasks.editDefinition(id, revision, def) : tasks.createTask(def)),
        );
      }
      return send(405, { error: "Unsupported scheduler operation." });
    } catch (e) {
      if (e instanceof InvariantError)
        return send(e.status, { error: e.message });
      if ([400, 413, 415].includes(e.status))
        return send(e.status, { error: "Invalid scheduler request." });
      throw e;
    }
  };
}
