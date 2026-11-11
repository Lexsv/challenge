import { afterEach, describe, expect, it, vi } from "vitest";
import { createRun, Engine, importHistoricalOpenAIRun } from "./legacy-engine";
import { settings } from "./openai-model-compat";
import { createProviderRegistry, ProviderRegistry } from "./provider-registry";
import { respond } from "./openai";
import type { Expert } from "./models";

afterEach(() => vi.unstubAllGlobals());
describe("current run parameter identity", () => {
  it.each([undefined, []])(
    "preserves absent or empty OpenAI rows: %s",
    async (parameters) => {
      const fetcher = vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({
              status: "completed",
              output: [{ content: [{ type: "output_text", text: "answer" }] }],
            }),
            { status: 200 },
          ),
        );
      vi.stubGlobal("fetch", fetcher);
      const expert: Expert = {
        ...settings("gpt-5.6-terra"),
        id: "x",
        name: "x",
        description: "d",
        rolePrompt: "r",
        parameters,
      };
      const evaluator = { ...settings("gpt-5.6-terra"), parameters: [] };
      const run = createRun(
        "q",
        "",
        [expert],
        "gpt-5.6-terra",
        "openai",
        createProviderRegistry(),
        evaluator,
      );
      expect(run.snapshot.experts[0].parameters).toEqual(parameters);
      expect(run.snapshot.evaluator.parameters).toEqual([]);
      expect(Object.isFrozen(run.snapshot)).toBe(true);
      await new Engine(() => {}, respond).execute(run, "dummy");
      const body = JSON.parse(fetcher.mock.calls[0][1].body);
      if (parameters === undefined)
        expect(body.max_output_tokens).toBe(expert.maxTokens);
      else expect(body).not.toHaveProperty("max_output_tokens");
    },
  );
  it("keeps custom-provider rows absent rather than inserting OpenAI defaults", () => {
    const provider = {
      id: "custom",
      catalog: () => ["model"],
      capabilities: () => ({
        structuredOutput: true,
        maxOutputTokens: 1000,
        supportedParameters: {},
      }),
      validate: () => undefined,
      execute: async () => ({
        status: "succeeded" as const,
        text: "ok",
        ms: 0,
      }),
    };
    const registry = new ProviderRegistry([provider]);
    const expert: Expert = {
      provider: "custom",
      model: "model",
      maxTokens: 100,
      id: "x",
      name: "x",
      description: "d",
      rolePrompt: "r",
    };
    const run = createRun("q", "", [expert], "model", "custom", registry, {
      provider: "custom",
      model: "model",
      maxTokens: 100,
    });
    expect(run.snapshot.experts[0].parameters).toBeUndefined();
    expect(run.snapshot.evaluator.parameters).toBeUndefined();
  });
  it("preserves explicit enabled and disabled rows on retry and historical import", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ status: "failed", text: "", ms: 1 })
      .mockResolvedValueOnce({ status: "succeeded", text: "ok", ms: 1 });
    const params = [
      { id: "a", key: "temperature", value: "0.7", enabled: true },
      { id: "b", key: "top_p", value: "0.4", enabled: false },
    ];
    const expert: Expert = {
      ...settings("gpt-5.6-terra"),
      id: "x",
      name: "x",
      description: "d",
      rolePrompt: "r",
      parameters: params,
    };
    const registry = createProviderRegistry(execute);
    const run = createRun(
      "q",
      "",
      [expert],
      "gpt-5.6-terra",
      "openai",
      registry,
    );
    params[0].value = "1.2";
    const engine = new Engine(() => {}, execute, {}, registry);
    await engine.execute(run, "dummy");
    await engine.execute(run, "dummy", 0);
    expect(execute.mock.calls[1][1].settings.parameters).toEqual([
      { id: "a", key: "temperature", value: "0.7", enabled: true },
      { id: "b", key: "top_p", value: "0.4", enabled: false },
    ]);
    expect(run.snapshot.validationPolicy).toBe("current-v1");
    const historical = structuredClone(run);
    delete (historical.snapshot as { validationPolicy?: string })
      .validationPolicy;
    const imported = importHistoricalOpenAIRun(historical);
    expect(imported.snapshot.experts[0].parameters).toEqual(
      run.snapshot.experts[0].parameters,
    );
    expect(imported.snapshot.validationPolicy).toBe("historical-openai-v0");
  });
});
