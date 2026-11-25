import { AsyncLocalStorage } from "node:async_hooks";
import type { DomainEvent } from "../domain/task.js";
import { logLevels, type ILogger, type LogLevel, type LogFields } from "../application/ports/logger.js";

export class Logger implements ILogger {
  private readonly requests = new AsyncLocalStorage<string>();
  private readonly localTime?: Intl.DateTimeFormat;

  constructor(private threshold: LogLevel, timezone: string,
    private output: (line: string) => void = console.error) {
    if (timezone !== "UTC") {
      this.localTime = new Intl.DateTimeFormat("en-CA", { timeZone: timezone,
        dateStyle: "short", timeStyle: "long" });
    }
  }

  withRequest<T>(id: string, handle: () => T): T {
    return this.requests.run(id, handle);
  }

  write(level: LogLevel, event: string, fields: LogFields = {}): void {
    if (logLevels.indexOf(level) < logLevels.indexOf(this.threshold)) return;
    const now = new Date();
    this.output(JSON.stringify({ time: now.toISOString(), localTime: this.localTime?.format(now),
      level, event, requestId: this.requests.getStore(), ...fields }));
  }
}

export function logTaskEvent(logger: ILogger, event: DomainEvent): void {
  const taskId = event.taskId;
  switch (event.kind) {
    case "task.created":
      return logger.write("info", event.kind, { taskId, to: "pending" });
    case "task.started":
      return logger.write("info", event.kind, { taskId, from: "pending", to: "running" });
    case "task.cancelled":
      return logger.write("info", event.kind, { taskId, from: "pending", to: "cancelled" });
    case "task.interrupted":
      return logger.write("warn", event.kind, { taskId, from: "running", to: "failed",
        outcome: "failed", reason: "interrupted_execution" });
    case "task.finished": {
      const status = event.outcome.status;
      return logger.write(status === "failed" ? "error" : "info", event.kind, {
        taskId, from: "running", to: status, outcome: status,
        reason: status === "failed" ? "execution_failed" : undefined
      });
    }
  }
}
