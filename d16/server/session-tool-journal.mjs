import { safeToolObservation } from "../src/execution-policy.ts";
import { createBuiltInToolRegistry } from "../src/tool-runtime.ts";
import { sanitizedCapture } from "./journal-payload.mjs";

export function sessionToolJournal(db) {
  const registry = createBuiltInToolRegistry();
  const query = `SELECT o.id,o.run_id AS runId,r.state AS runState,o.parent_llm_id AS llmCallId,o.target AS toolId,
    o.connection_key AS connectionId,o.state AS status,o.created,o.ended,
    (o.state='Success' AND o.policy_grant IS NOT NULL AND
      (coalesce(json_extract(o.display,'$.compatibilityWarning'),json_extract(o.display,'$.incompleteResult'),0)=1
       OR coalesce(json_extract(o.result,'$.compatibilityWarning.code'),'')='unsupported_content')) AS hasWarning,
    json_extract(o.display,'$.type') AS type,
    coalesce(json_extract(o.display,'$.name'),t.original_name) AS name,
    coalesce(json_extract(o.display,'$.server'),c.name) AS server,
    json_group_array(json_array(a.started,a.ended)) FILTER(WHERE a.id IS NOT NULL) AS spans,
    count(a.id) AS attempts, coalesce(sum(a.ended-a.started),0) AS duration
    FROM week4_operations o JOIN week4_runs r ON r.id=o.run_id
    LEFT JOIN week4_attempts a ON a.operation_id=o.id
    LEFT JOIN mcp_tools t ON t.connection_id=o.connection_key AND 'mcp:'||t.id=o.target
    LEFT JOIN mcp_connections c ON c.id=t.connection_id
    WHERE r.session_id=? AND o.kind='tool'`;
  const list = db.prepare(query + " GROUP BY o.id ORDER BY o.created,o.rowid");
  const detail =
    db.prepare(`SELECT o.* FROM week4_operations o JOIN week4_runs r ON r.id=o.run_id
    WHERE r.session_id=? AND o.kind='tool' AND o.id=?`);
  const attempts =
    db.prepare(`SELECT a.id,a.ordinal,a.started,a.ended,a.state,a.error,c.capture FROM week4_attempts a
    LEFT JOIN week4_checkpoints c ON c.attempt_id=a.id AND c.event='dispatch'
    WHERE a.operation_id=? ORDER BY a.ordinal`);
  return (req, path, reply) => {
    const match = path.match(
      /^\/api\/week4\/sessions\/([\w-]+)\/execution-journal(?:\/([\w-]+))?$/,
    );
    if (!match) return false;
    const [, session, id] = match;
    if (req.method !== "GET") reply(405, { error: "Read-only journal." });
    else if (
      !db.prepare("SELECT 1 FROM week3_sessions WHERE id=?").get(session)
    )
      reply(404, { error: "Session unavailable." });
    else {
      const restricted = !!db
        .prepare(
          "SELECT 1 FROM session_invariants WHERE session_id=? AND enabled=1",
        )
        .get("week3:" + session);
      if (!id)
        reply(
          200,
          list.all(session).map((row) => {
            const mcp = row.toolId.startsWith("mcp:"),
              internal = registry.get(row.toolId);
            return {
              ...row,
              hasWarning: Boolean(row.hasWarning),
              spans: JSON.parse(row.spans),
              type:
                row.type ??
                (mcp ? "MCP" : (internal?.executionType ?? "unknown")),
              name: restricted
                ? "Tool"
                : safeToolObservation(row.name ?? internal?.name ?? row.toolId),
              server: restricted ? null : safeToolObservation(row.server),
              connectionId: mcp || row.type === 'MCP' ? row.connectionId : null,
            };
          }),
        );
      else {
        const op = detail.get(session, id);
        if (!op) reply(404, { error: "Execution unavailable." });
        else {
          const display = JSON.parse(op.display ?? "{}");
          function visibleError(raw) {
            const error = JSON.parse(raw ?? "null");
            if (restricted && error) delete error.diagnostic;
            return error;
          }
          const rows = attempts.all(id).map(({ capture, error, ...a }) => ({
            ...a,
            error: visibleError(error),
            ...(!restricted && JSON.parse(capture ?? "{}")),
          }));
          const req = rows.find((a) => a.request)?.request;
          const args = req
            ? JSON.stringify(JSON.parse(req).params?.arguments)
            : rows.find((a) => a.sent)?.sent;
          const error = visibleError(op.error);
          reply(200, {
            proposedArguments: restricted ? undefined : display.proposedArguments,
            proposedFields: restricted ? undefined : display.proposedFields,
            arguments: restricted ? null : (args ?? null),
            result:
              restricted || op.result === null
                ? null
                : sanitizedCapture(op.result),
            error,
            authorization: display.authorization,
            validation: error?.code === "invalid_arguments" ? "failed" :
              op.state === "Success" ? "passed" : display.validation,
            dependencies: display.prerequisites ?? [],
            attempts: rows,
            restricted,
          });
        }
      }
    }
    return true;
  };
}
