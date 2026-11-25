import { newReminder } from "../../domain/task.js";
import type { IClock, IEventPublisher, ITaskRepository } from "../ports/index.js";

export class CreateReminder {
  constructor(private tasks: ITaskRepository, private clock: IClock,
    private events: IEventPublisher, private nextId: () => string) {}

  execute(message: string, scheduledAt: string) {
    const task = newReminder(this.nextId(), message, scheduledAt, this.clock.now());
    this.tasks.insert(task);
    this.events.publish({ kind: "task.created", taskId: task.id });
    return task;
  }
}
