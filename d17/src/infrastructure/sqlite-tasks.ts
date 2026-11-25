import { DatabaseSync } from "node:sqlite";
import type { IEventPublisher, ITaskRepository, ITaskStatusReader, TaskStatusView } from "../application/ports/index.js";
import type { Task, TaskOutcome } from "../domain/task.js";

export class SqliteTasks implements ITaskRepository, ITaskStatusReader {
  constructor(private db: DatabaseSync, private events: IEventPublisher) {
    // Hold the file lock until close. Recovery can never fail another live owner's task.
    db.exec(`
      PRAGMA locking_mode = EXCLUSIVE;
      BEGIN EXCLUSIVE;
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','running','completed','failed','cancelled')),
        message TEXT NOT NULL,
        scheduled_at INTEGER NOT NULL,
        result TEXT,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS pending_due ON tasks(scheduled_at, id) WHERE status = 'pending';
      COMMIT;
    `);
  }

  findStatus(id: string): TaskStatusView | undefined {
    return this.db.prepare("SELECT id,type,status,scheduled_at AS scheduledAt FROM tasks WHERE id=?")
      .get(id) as TaskStatusView | undefined;
  }

  insert(task: Task): void {
    this.db.prepare(`INSERT INTO tasks (id,type,status,message,scheduled_at)
      VALUES (?,?,?,?,?)`).run(task.id, task.type, task.status, task.message, task.scheduledAt);
  }

  claimDue(now: number): Task | undefined {
    const row = this.db.prepare(`UPDATE tasks SET status='running' WHERE id=(
      SELECT id FROM tasks WHERE status='pending' AND scheduled_at<=?
      ORDER BY scheduled_at,id LIMIT 1
    ) AND status='pending'
    RETURNING id,type,status,message,scheduled_at AS scheduledAt,result,error`).get(now);
    return row as unknown as Task | undefined;
  }

  finish(id: string, outcome: TaskOutcome): void {
    const result = this.db.prepare(`UPDATE tasks SET status=?, result=?, error=?
      WHERE id=? AND status='running'`).run(outcome.status,
      outcome.status === "completed" ? outcome.result : null,
      outcome.status === "failed" ? outcome.error : null, id);
    if (result.changes !== 1) throw new Error("Lost running task: " + id);
  }

  cancelPending(id: string): boolean {
    const changed = this.db.prepare("UPDATE tasks SET status='cancelled' WHERE id=? AND status='pending'")
      .run(id).changes === 1;
    if (changed) this.events.publish({ kind: "task.cancelled", taskId: id });
    return changed;
  }

  recoverInterrupted(): number {
    const rows = this.db.prepare(`UPDATE tasks SET status='failed',
      error='Server stopped during execution; outcome unknown' WHERE status='running' RETURNING id`).all();
    for (const row of rows) this.events.publish({ kind: "task.interrupted", taskId: String(row.id) });
    return rows.length;
  }
}
