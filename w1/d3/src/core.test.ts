import { describe, it, expect, vi, afterEach } from "vitest";
import { createRun, Engine } from "./engine";
import { validateExperts } from "./generation";
import { validateEvaluation } from "./evaluation";
import { settings, last, totals, type Expert } from "./models";
import { respond, type Adapter, type Request } from "./openai";
const expert = (name: string): Expert => ({
  ...settings(""),
  id: name,
  name,
  description: "A useful expert",
  rolePrompt: `Role ${name}`,
});
const ok = (text = "answer") => ({
  status: "succeeded" as const,
  text,
  usage: { input: 10, output: 20, reasoning: 5 },
  ms: 10,
});
const fail = {
  status: "failed" as const,
  text: "",
  error: "Mock failure",
  ms: 10,
};
const makeRun = (n = 2) =>
  createRun(
    "question",
    "private reference",
    Array.from({ length: n }, (_, i) => expert(`E${i}`)),
    "gpt-5.6-terra",
  );
const evaluation = (request: Request) =>
  ok(
    JSON.stringify({
      evaluations: JSON.parse(request.input).answers.map(
        (a: { resultId: string }) => ({
          resultId: a.resultId,
          verdict: "correct",
          explanation: "Equivalent answer",
        }),
      ),
    }),
  );
describe("Architect validation", () => {
  it("assigns stable independent IDs only after shape validation", () => {
    const text = JSON.stringify({
      experts: [
        {
          name: "A",
          roleLabel: "Philosopher",
          description: "B",
          rolePrompt: "C",
        },
      ],
    });
    expect(validateExperts(text, true)[0].id).not.toBe(
      validateExperts(text, true)[0].id,
    );
    expect(() => validateExperts('{"experts":[]}')).toThrow();
    expect(() => validateExperts('{"experts":[{"name":"A"}]}')).toThrow();
    expect(() =>
      validateExperts(
        JSON.stringify({
          experts: [
            {
              name: "A",
              roleLabel: "Philosopher",
              description: "B",
              rolePrompt: "C",
            },
            {
              name: "D",
              roleLabel: "Comedian",
              description: "E",
              rolePrompt: "F",
            },
          ],
        }),
        true,
      ),
    ).toThrow();
  });
});
describe("snapshot isolation", () => {
  it("deep copies and freezes resolved team and evaluator without credentials", () => {
    const team = [expert("A")];
    const run = createRun("Q", "R", team, "gpt-5.6-terra");
    team[0].rolePrompt = "changed";
    team.splice(0);
    expect(run.snapshot.experts[0].rolePrompt).toBe("Role A");
    expect(run.snapshot.experts[0].model).toBe("gpt-5.6-terra");
    expect(Object.isFrozen(run.snapshot.experts[0])).toBe(true);
    expect(run.snapshot.evaluator.model).toBe("gpt-5.6-terra");
    expect(JSON.stringify(run)).not.toContain("apiKey");
  });
});
describe("evaluation validation", () => {
  it("maps by ID rather than order and rejects duplicates, unknown and missing IDs", () => {
    const item = (resultId: string) => ({
      resultId,
      verdict: "correct",
      explanation: "Valid",
    });
    expect(
      validateEvaluation(
        JSON.stringify({ evaluations: [item("b"), item("a")] }),
        ["a", "b"],
      )[0].resultId,
    ).toBe("b");
    for (const ids of [["a", "a"], ["a", "z"], ["a"]])
      expect(() =>
        validateEvaluation(JSON.stringify({ evaluations: ids.map(item) }), [
          "a",
          "b",
        ]),
      ).toThrow();
  });
});
describe("orchestration and retries", () => {
  it("limits concurrency to three and preserves independent successes with terminal progress", async () => {
    let running = 0,
      max = 0;
    const seen: Request[] = [];
    const run = makeRun(5);
    const updates: number[] = [];
    const adapter: Adapter = async (_key, r) => {
      seen.push(r);
      if (r.schema) return evaluation(r);
      running++;
      max = Math.max(max, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running--;
      return r.instructions === "Role E1" ? fail : ok();
    };
    await new Engine(
      () =>
        updates.push(
          run.results.filter(
            (r) =>
              last(r.attempts)?.status === "succeeded" ||
              last(r.attempts)?.status === "failed",
          ).length,
        ),
      adapter,
    ).execute(run, "placeholder");
    expect(max).toBe(3);
    expect(
      run.results.filter((r) => last(r.attempts)?.status === "succeeded"),
    ).toHaveLength(4);
    expect(updates).toContain(1);
    expect(updates).toContain(5);
    expect(run.evaluationStatus).toBe("completed");
    for (const r of seen.filter((r) => !r.schema)) {
      expect(r.input).toBe("question");
      expect(r.input).not.toContain("private reference");
    }
    const payload = seen.find((r) => r.schema)!.input;
    expect(payload).not.toContain("Role E");
    expect(payload).not.toContain("gpt-");
  });
  it("retries only the failed participant, marks old evaluations stale, keeps attempts and hides stale judgments on failure", async () => {
    const run = makeRun();
    let first = true;
    let failEval = false;
    const calls: string[] = [];
    const stages: string[] = [];
    const adapter: Adapter = async (key, r) => {
      calls.push(r.schema ? "evaluation" : r.instructions);
      expect(key).toBe(first ? "first-placeholder" : "new-placeholder");
      if (r.schema) return failEval ? fail : evaluation(r);
      return first && r.instructions === "Role E1" ? fail : ok("new answer");
    };
    const engine = new Engine(() => stages.push(run.evaluationStatus), adapter);
    await engine.execute(run, "first-placeholder");
    expect(run.evaluationStatus).toBe("completed");
    first = false;
    failEval = true;
    const original = run.results[0].attempts[0];
    await engine.execute(run, "new-placeholder", 1);
    expect(stages).toContain("stale");
    expect(run.evaluationStatus).toBe("failed");
    expect(run.results[0].attempts).toEqual([original]);
    expect(run.results[1].attempts).toHaveLength(2);
    expect(run.evaluations).toHaveLength(2);
    expect(calls.filter((c) => c === "Role E0")).toHaveLength(1);
    failEval = false;
    await engine.execute(run, "new-placeholder", undefined, true);
    expect(run.evaluationStatus).toBe("completed");
    expect(calls.filter((c) => c === "Role E1")).toHaveLength(2);
  });
  it("skips evaluation when all fail and prevents overlapping operations", async () => {
    const run = makeRun();
    const adapter = vi.fn<Adapter>(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return fail;
    });
    const engine = new Engine(() => {}, adapter);
    const p = engine.execute(run, "placeholder");
    await engine.execute(run, "placeholder");
    await p;
    expect(adapter).toHaveBeenCalledTimes(2);
    expect(run.evaluationStatus).toBe("skipped");
    expect(run.busy).toBe(false);
  });
  it("counts missing usage as partial without adding reasoning twice", () => {
    expect(
      totals([
        { id: "a", ...ok() },
        { id: "b", ...fail },
      ]),
    ).toEqual({ input: 10, output: 20, partial: true });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe("OpenAI adapter with mocked fetch", () => {
  it("uses only official endpoint, excludes unsupported controls and keeps credentials out of results", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            status: "completed",
            output: [
              {
                type: "message",
                content: [{ type: "output_text", text: "OK" }],
              },
            ],
            usage: { input_tokens: 2, output_tokens: 3 },
          }),
        ),
    );
    vi.stubGlobal("fetch", fetcher);
    const a = await respond("placeholder", {
      settings: { model: "custom-id", maxTokens: 128 },
      instructions: "Role",
      input: "Question",
    });
    expect(a.status).toBe("succeeded");
    expect(JSON.stringify(a)).not.toContain("placeholder");
    const [url, init] = fetcher.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect(JSON.parse(init.body as string)).toMatchObject({
      store: false,
      model: "custom-id",
    });
    expect(JSON.parse(init.body as string)).not.toHaveProperty("reasoning");
  });
  it("does not echo raw authentication errors", async () => {
    vi.stubGlobal(
      "fetch",
      async () => new Response("sensitive upstream content", { status: 401 }),
    );
    const a = await respond("placeholder", {
      settings: settings("gpt-5.6-terra"),
      instructions: "",
      input: "Q",
    });
    expect(a.error).toContain("401");
    expect(JSON.stringify(a)).not.toContain("sensitive");
  });
  it("retains usage and partial text for incomplete outputs, handles refusals", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            status: "incomplete",
            output: [{ content: [{ type: "output_text", text: "partial" }] }],
            usage: { input_tokens: 1, output_tokens: 128 },
          }),
        ),
    );
    const a = await respond("placeholder", {
      settings: settings("gpt-5.6-terra"),
      instructions: "",
      input: "Q",
    });
    expect(a.status).toBe("incomplete");
    expect(a.text).toBe("partial");
    expect(a.usage?.output).toBe(128);
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            status: "completed",
            output: [{ content: [{ type: "refusal", refusal: "No" }] }],
          }),
        ),
    );
    expect(
      (
        await respond("placeholder", {
          settings: settings("gpt-5.6-terra"),
          instructions: "",
          input: "Q",
        })
      ).status,
    ).toBe("failed");
  });
  it("times out a stalled request without automatic retry", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(
      (_url, init: RequestInit) =>
        new Promise((_resolve, reject) =>
          init.signal?.addEventListener("abort", () =>
            reject(new Error("aborted")),
          ),
        ),
    );
    vi.stubGlobal("fetch", fetcher);
    const p = respond("placeholder", {
      settings: settings("gpt-5.6-terra"),
      instructions: "",
      input: "Q",
    });
    await vi.advanceTimersByTimeAsync(120001);
    expect((await p).status).toBe("timed-out");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("retry billing and partial usage", () => {
  it("does not reevaluate an unchanged successful-answer set after another failed participant retry", async () => {
    const run = makeRun();
    let evaluationCalls = 0;
    const adapter: Adapter = async (_key, request) => {
      if (request.schema) {
        evaluationCalls++;
        return evaluation(request);
      }
      return request.instructions === "Role E1" ? fail : ok();
    };
    const engine = new Engine(() => {}, adapter);
    await engine.execute(run, "placeholder");
    await engine.execute(run, "placeholder", 1);
    expect(evaluationCalls).toBe(1);
    expect(run.evaluationStatus).toBe("completed");
    expect(run.results[1].attempts).toHaveLength(2);
    expect(run.results[0].attempts).toHaveLength(1);
  });
  it("retains independently available input usage when output usage is missing", () => {
    expect(totals([{ id: "a", ...ok(), usage: { input: 7 } }])).toEqual({
      input: 7,
      output: undefined,
      partial: true,
    });
  });
});
