import { afterEach, describe, expect, it, vi } from "vitest";
import { last, type Expert } from "./models";
import { catalog, capabilities, settings, validSettings, verificationSettings, resolveExpert } from "./openai-model-compat";
import { ConnectionController } from "./connection";
import { createRun, Engine } from "./legacy-engine";
import { expertSchema } from "./generation";
import { respond, type Adapter, type Request } from "./openai";
const expert = (name: string, model = ""): Expert => ({
  ...settings(model),
  id: name,
  name,
  description: "Test expert",
  rolePrompt: "Test role",
});
const ok = { status: "succeeded" as const, text: "answer", ms: 1 };
const evaluator = (request: Request) => ({
  ...ok,
  text: JSON.stringify({
    evaluations: JSON.parse(request.input).answers.map(
      (a: { resultId: string }) => ({
        resultId: a.resultId,
        verdict: "correct",
        explanation: "Test evaluation",
      }),
    ),
  }),
});
afterEach(() => vi.unstubAllGlobals());
describe("shared model selection", () => {
  it.each(catalog)(
    "uses %s for verification, Architect, evaluation and inherited participants",
    async (model) => {
      const c = new ConnectionController(() => ({
        getItem: () => null,
        setItem: () => {},
        removeItem: () => {},
      }));
      c.updateKey("dummy-shared-model");
      const verification = vi.fn<Adapter>(async () => ok);
      await c.verify(model, verification);
      expect(verification.mock.calls[0][1].settings.model).toBe(model);
      const bodies: Record<string, unknown>[] = [];
      vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(init.body as string));
        return new Response(
          JSON.stringify({
            status: "completed",
            output: [
              {
                content: [
                  {
                    type: "output_text",
                    text: '{"experts":[{"name":"A","description":"B","rolePrompt":"C"}]}',
                  },
                ],
              },
            ],
          }),
        );
      });
      await respond("dummy-shared-model", {
        settings: settings(model),
        instructions: "Architect",
        input: "Describe experts",
        schema: expertSchema,
      });
      expect(bodies[0].model).toBe(model);
      expect(bodies[0].reasoning).toEqual({
        effort: model.startsWith("gpt-6.1-") ? "medium" : "low",
      });
      expect(bodies[0].text).toMatchObject({
        format: { type: "json_schema", strict: true },
      });
      const run = createRun(
        "Question",
        "Reference",
        [expert("inherited"), expert("overridden", "gpt-5.6-luna")],
        model,
      );
      const requests: Request[] = [];
      const adapter: Adapter = async (_key, request) => {
        requests.push(request);
        return request.schema ? evaluator(request) : ok;
      };
      await new Engine(() => {}, adapter).execute(run, c.getKey);
      expect(
        requests.filter((r) => !r.schema).map((r) => r.settings.model),
      ).toEqual([model, "gpt-5.6-luna"]);
      expect(requests.find((r) => r.schema)!.settings.model).toBe(model);
      expect(run.snapshot.evaluator.model).toBe(model);
    },
  );
  it("keeps earlier resolved models and settings unchanged across selection changes and retries", async () => {
    const team = [expert("inherited"), expert("override", "gpt-5.6-luna")];
    const old = createRun("Q", "R", team, "gpt-5.6-terra");
    const captured = JSON.stringify(old.snapshot);
    const newer = createRun("Q", "R", team, "gpt-6.1-sol");
    expect(newer.snapshot.experts[0].model).toBe("gpt-6.1-sol");
    expect(newer.snapshot.experts[1].model).toBe("gpt-5.6-luna");
    const requests: Request[] = [];
    let failed = false;
    const adapter: Adapter = async (_key, r) => {
      requests.push(r);
      if (r.schema) return evaluator(r);
      if (!failed) {
        failed = true;
        return { ...ok, status: "failed", error: "Synthetic failure" };
      }
      return ok;
    };
    const engine = new Engine(() => {}, adapter);
    await engine.execute(old, "dummy-key");
    await engine.execute(old, "dummy-key", 0);
    expect(JSON.stringify(old.snapshot)).toBe(captured);
    expect(
      requests
        .filter((r) => r.schema)
        .every((r) => r.settings.model === "gpt-5.6-terra"),
    ).toBe(true);
    expect(old.snapshot.experts[0].model).toBe("gpt-5.6-terra");
    expect(last(old.results[0].attempts)?.status).toBe("succeeded");
  });
  it("invalidates verification when changing models without triggering another request", async () => {
    const c = new ConnectionController(() => ({
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    }));
    c.updateKey("dummy-key");
    const adapter = vi.fn<Adapter>(async () => ok);
    await c.verify("gpt-5.6-terra", adapter);
    expect(c.getSnapshot().verification).toBe("verified");
    c.invalidate();
    expect(c.getSnapshot().verification).toBe("unverified");
    expect(adapter).toHaveBeenCalledTimes(1);
  });
});
describe("capability-aware request settings", () => {
  it("offers only catalog models with structured output and valid defaults", () => {
    for (const model of catalog) {
      expect(capabilities(model)?.structuredOutput).toBe(true);
      expect(validSettings(settings(model))).toBe(true);
      expect(validSettings(verificationSettings(model))).toBe(true);
    }
    expect(settings("gpt-5.6-terra").reasoning).toBe("low");
    expect(settings("gpt-6.1-sol").reasoning).toBe("medium");
    expect(settings("gpt-6.1-terra").reasoning).toBe("medium");
  });
  it("does not offer or send none for GPT-6.1 Sol and rejects unsupported settings before fetching", async () => {
    expect(capabilities("gpt-6.1-sol")!.reasoningEfforts).not.toContain("none");
    expect(verificationSettings("gpt-6.1-sol").reasoning).toBe("low");
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const response = await respond("dummy-key", {
      settings: { ...settings("gpt-6.1-sol"), reasoning: "none" },
      instructions: "Test",
      input: "Test",
    });
    expect(response.status).toBe("failed");
    expect(response.error).toContain("reasoning");
    expect(fetcher).not.toHaveBeenCalled();
    expect(
      validSettings({ ...settings("gpt-6.1-sol"), maxTokens: 128001 }),
    ).toBe(false);
  });
  it("keeps explicitly unsupported inherited settings invalid until corrected", () => {
    const inherited = { ...expert("A"), reasoning: "none" };
    expect(validSettings(resolveExpert(inherited, "gpt-5.6-terra"))).toBe(true);
    expect(validSettings(resolveExpert(inherited, "gpt-6.1-sol"))).toBe(false);
    expect(() => createRun("Q", "R", [inherited], "gpt-6.1-sol")).toThrow();
  });
  it("preserves conservative custom participant requests and surfaces real API rejection without claiming compatibility", async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string));
      return new Response("Do not display upstream body", { status: 400 });
    });
    const response = await respond("dummy-key", {
      settings: settings("custom-unverified-model"),
      instructions: "Role",
      input: "Question",
    });
    expect(bodies[0]).not.toHaveProperty("reasoning");
    expect(bodies[0].max_output_tokens).toBe(4096);
    expect(response.error).toContain("400");
    expect(response.error).not.toContain("upstream");
    expect(() =>
      createRun("Q", "R", [expert("A")], "custom-unverified-model"),
    ).toThrow();
  });
});
