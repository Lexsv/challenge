import { safeToolObservation } from "../src/execution-policy.ts";
import { createBuiltInToolRegistry } from "../src/tool-runtime.ts";
import { recordConsumedLinks } from "./mcp-executor.mjs";
import { sanitizedCapture } from "./journal-payload.mjs";

export function sessionToolJournal(db) {
  const registry = createBuiltInToolRegistry();
  // Older captures can be classified when each distinct resource is corroborated
  // by a stored origin for this exact call. Keep raw attempt captures intact.
  const accepted = db.prepare(`SELECT count(DISTINCT w.id) AS n FROM mcp_watch_origins origin
    JOIN mcp_resource_watches w ON w.id=origin.watch_id
    WHERE origin.call_id=? AND w.connection_id=? AND w.scope=? AND 'mcp:'||origin.tool_id=?`);
  function historicalLinks(row, session, omitted) {
    return omitted > 0 ? Math.min(omitted,accepted.get(row.id,row.connectionId,session,row.toolId).n) : 0;
  }
  const query = `SELECT o.id,o.run_id AS runId,r.state AS runState,o.parent_llm_id AS llmCallId,o.target AS toolId,
    o.connection_key AS connectionId,o.state AS status,o.created,o.ended,
    (o.state='Success' AND o.policy_grant IS NOT NULL AND
      (coalesce(json_extract(o.display,'$.compatibilityWarning'),json_extract(o.display,'$.incompleteResult'),0)=1
       OR coalesce(json_extract(o.result,'$.compatibilityWarning.code'),'')='unsupported_content')) AS hasWarning,
    CASE WHEN json_extract(o.result,'$.watchedResourceLinks') IS NULL
      AND json_extract(o.result,'$.compatibilityWarning.code')='unsupported_content'
      AND (SELECT count(*) FROM json_each(o.result,'$.compatibilityWarning.omitted'))=1
      THEN json_extract(o.result,'$.compatibilityWarning.omitted.resource_link') END AS oldLinks,
    json_extract(o.display,'$.type') AS type,
    coalesce(json_extract(o.display,'$.name'),t.original_name) AS name,
    coalesce(json_extract(o.display,'$.server'),c.name) AS server,
    json_group_array(json_array(a.started,a.ended)) FILTER(WHERE a.id IS NOT NULL) AS spans,
    count(a.id) AS attempts, coalesce(sum(a.ended-a.started),0) AS duration
    FROM week4_operations o JOIN week4_runs r ON r.id=o.run_id
    LEFT JOIN week4_attempts a ON a.operation_id=o.id
    LEFT JOIN mcp_tools t ON t.connection_id=o.connection_key AND 'mcp:'||t.id=o.target
    LEFT JOIN mcp_connections c ON c.id=t.connection_id
    WHERE coalesce(r.session_id,'occurrence:'||r.id)=? AND o.kind='tool'`;
  const list = db.prepare(query + " GROUP BY o.id ORDER BY o.created,o.rowid");
  const detail =
    db.prepare(`SELECT o.* FROM week4_operations o JOIN week4_runs r ON r.id=o.run_id
    WHERE coalesce(r.session_id,'occurrence:'||r.id)=? AND o.kind='tool' AND o.id=?`);
  const attempts =
    db.prepare(`SELECT a.id,a.ordinal,a.started,a.ended,a.state,a.error,c.capture FROM week4_attempts a
    LEFT JOIN week4_checkpoints c ON c.attempt_id=a.id AND c.event='dispatch'
    WHERE a.operation_id=? ORDER BY a.ordinal`);
  return (req, path, reply, taskEntry) => {
    const match = path.match(
      /^\/api\/week4\/sessions\/([\w-]+)\/execution-journal(?:\/([\w-]+))?$/,
    );
    if (!match && !taskEntry) return false;
    const session=taskEntry ? "occurrence:"+taskEntry.id : match[1], id=taskEntry ? taskEntry.operation : match[2];
    if (req.method !== "GET") reply(405, { error: "Read-only journal." });
    else if (
      !taskEntry && !db.prepare("SELECT 1 FROM week3_sessions WHERE id=?").get(session)
    )
      reply(404, { error: "Session unavailable." });
    else {
      const restricted = taskEntry ? !!taskEntry.private_payloads : !!db
        .prepare(
          "SELECT 1 FROM session_invariants WHERE session_id=? AND enabled=1",
        )
        .get("week3:" + session);
      if (!id)
        reply(
          200,
          list.all(session).map(({oldLinks,...row}) => {
            const mcp = row.toolId.startsWith("mcp:"),
              internal = registry.get(row.toolId);
            return {
              ...row,
              hasWarning: Boolean(row.hasWarning) && !(oldLinks && historicalLinks(row,session,oldLinks)===oldLinks),
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
          const result = restricted || !op.result ? null : JSON.parse(op.result);
          if (result?.compatibilityWarning?.code === "unsupported_content" && !result.watchedResourceLinks &&
              Object.keys(result.compatibilityWarning.omitted ?? {}).length === 1) {
            recordConsumedLinks(result,historicalLinks({id,connectionId:op.connection_key,toolId:op.target},session,result.compatibilityWarning.omitted?.resource_link));
          }
          reply(200, {
            proposedArguments: restricted ? undefined : display.proposedArguments,
            proposedFields: restricted ? undefined : display.proposedFields,
            arguments: restricted ? null : (args ?? null),
            result:
              result === null ? null : sanitizedCapture(JSON.stringify(result)),
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
