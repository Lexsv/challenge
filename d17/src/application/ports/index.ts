import type { DomainEvent, Task, TaskOutcome, TaskType } from "../../domain/task.js";

export type TaskStatusView = Pick<Task, "id" | "type" | "status" | "scheduledAt">;
export interface ITaskStatusReader { findStatus(id: string): TaskStatusView | undefined }

export interface ITaskRepository {
  insert(task: Task): void;
  claimDue(now: number): Task | undefined;
  finish(id: string, outcome: TaskOutcome): void;
  recoverInterrupted(): number;
}

export interface IClock { now(): number }
export interface IScheduler { runDue(): Promise<void> }
export interface ITaskExecutor {
  readonly type: TaskType;
  execute(task: Task): Promise<string>;
}
export interface IEventPublisher { publish(event: DomainEvent): void }
