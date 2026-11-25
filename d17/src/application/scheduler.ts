import type { Task, TaskOutcome, TaskType } from "../domain/task.js";
import type { IClock, IEventPublisher, IScheduler, ITaskExecutor, ITaskRepository } from "./ports/index.js";

export class TaskExecution {
  private readonly byType = new Map<TaskType, ITaskExecutor>();

  constructor(executors: ITaskExecutor[]) {
    for (const executor of executors) {
      if (this.byType.has(executor.type)) throw new Error("Duplicate executor: " + executor.type);
      this.byType.set(executor.type, executor);
    }
  }

  async run(task: Task): Promise<TaskOutcome> {
    try {
      const executor = this.byType.get(task.type);
      if (!executor) throw new Error("No executor for " + task.type);
      return { status: "completed", result: await executor.execute(task) };
    } catch (error) {
      return { status: "failed", error: error instanceof Error ? error.message : "Execution failed" };
    }
  }
}

export class Scheduler implements IScheduler {
  constructor(private tasks: ITaskRepository, private clock: IClock,
    private execution: TaskExecution, private events: IEventPublisher) {}

  async runDue(): Promise<void> {
    // Bound each pass so shutdown and incoming requests get a turn under backlog.
    for (let count = 0; count < 100; count++) {
      const task = this.tasks.claimDue(this.clock.now());
      if (!task) return;
      this.events.publish({ kind: "task.started", taskId: task.id });
      const outcome = await this.execution.run(task);
      this.tasks.finish(task.id, outcome);
      this.events.publish({ kind: "task.finished", taskId: task.id, outcome });
    }
  }
}
