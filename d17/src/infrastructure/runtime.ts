import type { IClock, IEventPublisher, IScheduler, ITaskExecutor } from "../application/ports/index.js";
import type { DomainEvent, Task } from "../domain/task.js";

export class SystemClock implements IClock {
  now(): number { return Date.now(); }
}

export class ReminderExecutor implements ITaskExecutor {
  readonly type = "reminder";
  constructor(private emit: (message: string, taskId: string) => void) {}
  async execute(task: Task): Promise<string> {
    this.emit(task.message, task.id);
    return task.message;
  }
}

export class LocalEventPublisher implements IEventPublisher {
  private readonly observers: Array<(event: DomainEvent) => void>;
  constructor(...observers: Array<(event: DomainEvent) => void>) { this.observers = observers; }
  addObserver(observer: (event: DomainEvent) => void) { this.observers.push(observer); }
  publish(event: DomainEvent): void {
    for (const observe of this.observers) observe(event);
  }
}

export class PollTimer {
  private timer?: NodeJS.Timeout;
  private active?: Promise<void>;
  private stopped = true;

  constructor(private scheduler: IScheduler, private interval: number,
    private onError: (error: unknown) => void) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.tick();
  }

  private tick(): void {
    this.active = this.scheduler.runDue().catch(this.onError).finally(() => {
      if (!this.stopped) this.timer = setTimeout(() => this.tick(), this.interval);
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.active;
  }
}
