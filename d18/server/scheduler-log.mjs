import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  executionError,
  safeToolObservation,
} from "../src/execution-policy.ts";
const descriptions = {
  task_created: "Schedule created.",
  task_review_confirmed: "Outstanding executions reviewed; schedule is stopped.",
  task_restart_requested: "A new execution was requested for a consumed schedule.",
  execution_requires_review: "Execution finished with unresolved effects; review is required.",
  task_started: "Schedule started.",
  task_paused: "Schedule paused.",
  task_resumed: "Schedule resumed.",
  task_stopped: "Schedule stopped.",
  task_delete_requested: "Schedule deactivated; draining admitted executions.",
  task_deleted: "Schedule deleted; execution history retained.",
  task_delete_failed: "Schedule deletion failed.",
  trigger: "Scheduled occurrence is due.",
  execution_started: "Execution admitted.",
  resolution: "Authorized tools resolved.",
  resolution_error: "Tool resolution failed.",
  mcp_dispatch: "MCP request dispatched.",
  mcp_response: "MCP response received.",
  result_persisted: "Agent result saved.",
  execution_finished: "Occurrence finished.",
  execution_failed: "Occurrence failed.",
};
// One live file and one archive share the 10 MB budget. Call sites supply only
// application-owned IDs, status codes and counters, never arguments or results.
export function schedulerLogger(directory, maxBytes = 10_000_000) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, "scheduler.ndjson");
  const limit = Math.floor(maxBytes / 2);
  const fields = [
    "taskId",
    "runId",
    "toolId",
    "connectionId",
    "attemptId",
    "previousState",
    "state",
    "code",
    "schemaSide",
    "offered",
    "issues",
    "durationMs",
    "dueAt",
    "startedAt",
    "hasResponse",
  ];
  let warned = false;
  return (event, data) => {
    const record = {
      at: new Date().toISOString(),
      event,
      description: descriptions[event],
    };
    for (const key of ["taskName", "toolName", "connectionName"])
      if (typeof data[key] === "string")
        record[key] = String(safeToolObservation(data[key]))
          .replace(/[\r\n\t]/g, " ")
          .slice(0, 120);
    if (data.code)
      record.diagnostic =
        data.code === "unknown_task"
          ? "Scheduled task not found."
          : executionError(data.code, "manager", "execution", 0).message;
    if (data.code === "unsupported_schema" && typeof data.schemaPath === "string" &&
        typeof data.diagnostic === "string") {
      record.schemaPath = String(safeToolObservation(data.schemaPath)).slice(0, 1024);
      record.diagnostic = String(safeToolObservation(data.diagnostic)).slice(0, 512);
    }
    for (const key of fields)
      if (data[key] !== undefined && data[key] !== null)
        record[key] = data[key];
    const line = JSON.stringify(record) + "\n";
    try {
      const bytes = Buffer.byteLength(line);
      if (bytes > limit) throw Error();
      if (
        (statSync(file, { throwIfNoEntry: false })?.size ?? 0) + bytes >
        limit
      )
        renameSync(file, file + ".1");
      appendFileSync(file, line, { mode: 0o600 });
      warned = false;
    } catch {
      if (!warned) console.error("Scheduler monitoring log unavailable.");
      warned = true;
    }
  };
}
