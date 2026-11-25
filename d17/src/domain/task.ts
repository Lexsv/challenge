export type TaskStatus = "pending" | "running" | "completed" | "failed" | "cancelled";
export type TaskType = "reminder";

export interface Schedule {
  readonly scheduledAt: number;
}

export interface Task extends Schedule {
  readonly id: string;
  readonly type: TaskType;
  readonly status: TaskStatus;
  readonly message: string;
  readonly result: string | null;
  readonly error: string | null;
}

export class ValidationError extends Error {}

export function parseSchedule(value: string, now: number): Schedule {
  // Check the calendar independently. Date.parse alone normalizes February 30.
  const match = /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):?[0-5]\d)$/.exec(value);
  const scheduledAt = Date.parse(value);
  const date = match?.[1];
  if (!date || !Number.isFinite(scheduledAt) ||
      new Date(date + "T00:00:00Z").toJSON()?.slice(0, 10) !== date) {
    throw new ValidationError("scheduledAt must be a valid ISO 8601 date-time with Z or a numeric offset");
  }
  if (scheduledAt <= now) throw new ValidationError("scheduledAt must be in the future");
  return { scheduledAt };
}

export function newReminder(id: string, message: string, timestamp: string, now: number): Task {
  const text = message.trim();
  if (!text) throw new ValidationError("message must contain reminder text");
  return { id, type: "reminder", status: "pending", message: text,
    ...parseSchedule(timestamp, now), result: null, error: null };
}

export type TaskOutcome =
  | { status: "completed"; result: string }
  | { status: "failed"; error: string };

export type DomainEvent =
  | { kind: "task.created" | "task.started" | "task.cancelled" | "task.interrupted"; taskId: string }
  | { kind: "task.finished"; taskId: string; outcome: TaskOutcome };
