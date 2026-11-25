import type { TaskStatus } from "../../domain/task.js";

export const logLevels = ["debug", "info", "warn", "error"] as const;
export type LogLevel = typeof logLevels[number];

// Only operational metadata belongs here. Request bodies, headers, executor results
// and exception messages can all contain client data.
export interface LogFields {
  taskId?: string;
  from?: TaskStatus;
  to?: TaskStatus;
  method?: string;
  statusCode?: number;
  tool?: "create_reminder" | "unknown";
  outcome?: "accepted" | "rejected" | "preflight" | "completed" | "failed";
  reason?: string;
}

export interface ILogger {
  write(level: LogLevel, event: string, fields?: LogFields): void;
}
