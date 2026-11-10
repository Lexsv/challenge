import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BatchTaskList } from "./batch-task-list";
import { executeBatch, saveTask, type BatchTask } from "./batch-tasks";
import { createRun, Engine } from "./legacy-engine";
import { settings } from "./openai-model-compat";
import type { Adapter } from "./provider-contract";

describe("batch tasks", () => {
  it("validates tasks and preserves versions while editing and deleting", () => {
    expect(() => saveTask([], { question: "  ", reference: "" })).toThrow("Enter a task.");
    const created = saveTask([], { question: "First", reference: "answer" });
    const unchanged = saveTask(created, { ...created[0] });
    expect(unchanged[0].version).toBe(1);
    const edited = saveTask(created, { ...created[0], question: "First revised" });
    expect(edited[0].version).toBe(2);
    expect(created[0].question).toBe("First");
    expect(edited.filter((item) => item.id !== edited[0].id)).toEqual([]);
  });

  it("runs two tasks in order, with parallel experts and evaluation only for the expected answer", async () => {
    const tasks: BatchTask[] = [
      { id: "first", version: 1, question: "Question one", reference: "known answer" },
      { id: "second", version: 2, question: "Question two", reference: "" },
    ];
    const experts = ["one", "two"].map((id) => ({ ...settings("gpt-5.6-terra"), id, name: id, description: "D", rolePrompt: `Role ${id}` }));
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const adapter = vi.fn<Adapter>(async (_key, request) => {
      if (request.schema) {
        events.push("evaluate");
        const answers = JSON.parse(request.input).answers as { resultId: string }[];
        return { status: "succeeded", text: JSON.stringify({ evaluations: answers.map(({ resultId }) => ({ resultId, verdict: "correct", explanation: "ok" })) }), ms: 1 };
      }
      events.push(request.input);
      if (request.input === "Question one") await gate;
      return { status: "succeeded", text: `Answer: ${request.input}`, ms: 1 };
    });
    const runs: ReturnType<typeof createRun>[] = [];
    const engine = new Engine(() => {}, adapter);
    const pending = executeBatch(tasks, (task) => createRun(task.question, task.reference, experts, "gpt-5.6-terra", "openai", undefined, undefined, { id: task.id, version: task.version }), (run) => engine.execute(run, "dummy"), (run) => runs.push(run));
    await vi.waitFor(() => expect(events).toEqual(["Question one", "Question one"]));
    expect(runs).toHaveLength(1);
    tasks[1].question = "Changed while running";
    release();
    await pending;
    expect(events).toEqual(["Question one", "Question one", "evaluate", "Question two", "Question two"]);
    expect(runs.map((run) => run.snapshot.question)).toEqual(["Question one", "Question two"]);
    expect(runs.map((run) => run.snapshot.batchTask)).toEqual([{ id: "first", version: 1 }, { id: "second", version: 2 }]);
    expect(runs[0].evaluationStatus).toBe("completed");
    expect(runs[1].evaluationStatus).toBe("not_evaluated");
    expect(runs[1].evaluations).toHaveLength(0);
    expect(runs.every((run) => run.results.every((result) => result.attempts[0].status === "succeeded"))).toBe(true);
    expect(Object.isFrozen(runs[0].snapshot.batchTask)).toBe(true);
    const edited = saveTask(tasks, { id: "first", question: "Edited after run", reference: "new" });
    expect(edited[0].version).toBe(2);
    expect(runs[0].snapshot.question).toBe("Question one");
    expect(runs[0].snapshot.reference).toBe("known answer");
    expect(runs[0].snapshot.batchTask?.version).toBe(1);
  });

  it("runs only the selected task through the same runner", async () => {
    const tasks: BatchTask[] = [
      { id: "first", version: 1, question: "Question one", reference: "known answer" },
      { id: "second", version: 1, question: "Question two", reference: "" },
    ];
    const experts = [{ ...settings("gpt-5.6-terra"), id: "one", name: "one", description: "D", rolePrompt: "Role" }];
    const adapter = vi.fn<Adapter>(async (_key, request) => ({ status: "succeeded", text: `Answer: ${request.input}`, ms: 1 }));
    const engine = new Engine(() => {}, adapter);
    const runs: ReturnType<typeof createRun>[] = [];
    await executeBatch([tasks[1]], (task) => createRun(task.question, task.reference, experts, "gpt-5.6-terra", "openai", undefined, undefined, { id: task.id, version: task.version }), (run) => engine.execute(run, "dummy"), (run) => runs.push(run));
    expect(adapter).toHaveBeenCalledTimes(1);
    expect(runs.map((run) => run.snapshot.question)).toEqual(["Question two"]);
    expect(runs[0].snapshot.batchTask).toEqual({ id: "second", version: 1 });
  });

  it("renders separately accessible task actions and clamps card previews", () => {
    const html = renderToStaticMarkup(<BatchTaskList tasks={[{ id: "x", version: 1, question: "A long question", reference: "Expected answer" }]} onChange={() => {}} active={false} onRunTask={() => {}} />);
    expect(html).toContain('aria-label="View task 1"');
    expect(html).toContain('aria-label="Edit task 1"');
    expect(html).toContain('aria-label="Run task 1"');
    expect(html).toContain('aria-label="Delete task 1"');
    expect(html).toContain('-webkit-line-clamp:5');
    expect(html).toContain('-webkit-line-clamp:2');
    expect(html).toContain('Add Task');
  });

  it("disables task editing and deletion while a run is active", () => {
    const html = renderToStaticMarkup(<BatchTaskList tasks={[{ id: "x", version: 1, question: "Task", reference: "" }]} onChange={() => {}} active onRunTask={() => {}} />);
    expect(html).toMatch(/disabled=""[^>]*aria-label="Edit task 1"|aria-label="Edit task 1"[^>]*disabled=""/);
    expect(html).toMatch(/disabled=""[^>]*aria-label="Delete task 1"|aria-label="Delete task 1"[^>]*disabled=""/);
    expect(html).toMatch(/disabled=""[^>]*aria-label="Run task 1"|aria-label="Run task 1"[^>]*disabled=""/);
  });
});
