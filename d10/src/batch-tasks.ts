import type { Run } from "./models";

export type BatchTask = { id: string; version: number; question: string; reference: string };

export function saveTask(tasks: readonly BatchTask[], draft: { id?: string; question: string; reference: string }): BatchTask[] {
  if (!draft.question.trim()) throw new Error("Enter a task.");
  if (!draft.id) return [...tasks, { id: crypto.randomUUID(), version: 1, question: draft.question, reference: draft.reference }];
  return tasks.map((task) => task.id !== draft.id ? task : task.question === draft.question && task.reference === draft.reference ? task : { ...task, question: draft.question, reference: draft.reference, version: task.version + 1 });
}

/** Capture the task list once, and await each existing single-task execution in order. */
export async function executeBatch(
  tasks: readonly BatchTask[],
  create: (task: BatchTask) => Run,
  run: (run: Run) => Promise<void>,
  onStart: (run: Run) => void,
): Promise<void> {
  const snapshot = structuredClone(tasks);
  for (const task of snapshot) {
    const current = create(task);
    onStart(current);
    await run(current);
  }
}
