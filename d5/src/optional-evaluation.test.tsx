import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { createRun, Engine } from "./engine";
import { evaluationRequested, settings, type Expert } from "./models";
import { ParticipantDetails, RunView } from "./results";
import type { Adapter } from "./openai";
const expert = (id: string): Expert => ({
  ...settings(""),
  id,
  name: `Expert ${id}`,
  description: "Description",
  rolePrompt: "Role",
});
const team = [expert("1"), expert("2"), expert("3")];
const renderRun = (run: ReturnType<typeof createRun>) =>
  renderToStaticMarkup(
    <RunView
      run={run}
      disabled={false}
      refresh={() => {}}
      retry={() => {}}
      retryEvaluation={() => {}}
    />,
  );
describe("optional expected answer", () => {
  it.each(["", "   \n "])(
    "runs all participants and never evaluates empty reference %j",
    async (reference) => {
      const run = createRun("Question", reference, team, "gpt-5.6-terra");
      const adapter = vi.fn<Adapter>(async (_key, request) => ({
        status: request.instructions === "Role" ? "succeeded" : "failed",
        text: "response",
        ms: 1,
      }));
      await new Engine(() => {}, adapter).execute(run, "dummy");
      expect(adapter).toHaveBeenCalledTimes(3);
      expect(adapter.mock.calls.every(([, request]) => !request.schema)).toBe(
        true,
      );
      expect(run.results.map((result) => result.attempts[0].text)).toEqual([
        "response",
        "response",
        "response",
      ]);
      expect(run.snapshot.evaluationRequested).toBe(false);
      expect(run.evaluationStatus).toBe("not_evaluated");
      expect(run.evaluations).toHaveLength(0);
      const html = renderRun(run);
      expect(html).toContain("Not evaluated");
      expect(html).not.toContain(">Verdict</th>");
      expect(html).not.toContain("AI evaluation:");
      expect(
        renderToStaticMarkup(
          <ParticipantDetails
            run={run}
            result={run.results[0]}
            disabled={false}
            refresh={() => {}}
            retry={() => {}}
          />,
        ),
      ).not.toContain("Manual verdict override");
    },
  );
  it("keeps technical errors and does not trigger evaluation on retries or evaluation-only requests", async () => {
    const run = createRun("Question", "", team, "gpt-5.6-terra");
    const adapter = vi.fn<Adapter>(async () => ({
      status: "failed",
      error: "Synthetic failure",
      text: "",
      ms: 1,
    }));
    const engine = new Engine(() => {}, adapter);
    await engine.execute(run, "dummy");
    await engine.execute(run, "dummy", 0);
    await engine.execute(run, "dummy", undefined, true);
    expect(adapter).toHaveBeenCalledTimes(4);
    expect(run.evaluationStatus).toBe("not_evaluated");
    expect(run.evaluations).toHaveLength(0);
    expect(renderRun(run)).toContain("Synthetic failure");
  });
  it("runs existing evaluation when reference is provided and preserves legacy history", async () => {
    const run = createRun("Question", "answer", team, "gpt-5.6-terra");
    const adapter = vi.fn<Adapter>(async (_key, request) =>
      request.schema
        ? {
            status: "succeeded",
            text: JSON.stringify({
              evaluations: JSON.parse(request.input).answers.map(
                (a: { resultId: string }) => ({
                  resultId: a.resultId,
                  verdict: "correct",
                  explanation: "Correct",
                }),
              ),
            }),
            ms: 1,
          }
        : { status: "succeeded", text: "answer", ms: 1 },
    );
    await new Engine(() => {}, adapter).execute(run, "dummy");
    expect(adapter).toHaveBeenCalledTimes(4);
    expect(run.evaluationStatus).toBe("completed");
    expect(renderRun(run)).toContain("AI evaluation: Correct");
    const legacy = structuredClone(run);
    delete (legacy.snapshot as { evaluationRequested?: boolean })
      .evaluationRequested;
    expect(evaluationRequested(legacy)).toBe(true);
    expect(renderRun(legacy)).toContain("AI evaluation: Correct");
  });
  it("still requires a nonblank question", () => {
    expect(() => createRun("   ", "", team, "gpt-5.6-terra")).toThrow();
  });
});
