import { describe, expect, it, vi } from "vitest";
import { createRun, Engine } from "./engine";
import { ProviderRegistry } from "./provider-registry";
import type { Expert } from "./models";

describe("provider-neutral core", () => {
  it("executes and retries a custom-only provider with its own credentials", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ status: "failed", text: "", ms: 1 })
      .mockResolvedValueOnce({ status: "succeeded", text: "answer", ms: 1 });
    const registry = new ProviderRegistry([
      {
        id: "custom",
        catalog: () => ["model"],
        capabilities: () => ({
          structuredOutput: true,
          maxOutputTokens: 1000,
          supportedParameters: {},
        }),
        validate: () => undefined,
        execute,
      },
    ]);
    const expert: Expert = {
      id: "x",
      name: "x",
      description: "",
      rolePrompt: "role",
      provider: "custom",
      model: "model",
      maxTokens: 100,
    };
    const run = createRun(
      "question",
      "",
      [expert],
      "model",
      "custom",
      registry,
      { provider: "custom", model: "model", maxTokens: 100 },
      "current-v1",
    );
    const engine = new Engine(() => {}, registry);
    await engine.execute(run, (id) => (id === "custom" ? "custom-dummy" : ""));
    await engine.execute(
      run,
      (id) => (id === "custom" ? "custom-dummy" : ""),
      0,
    );
    expect(execute.mock.calls.map((call) => call[0])).toEqual([
      "custom-dummy",
      "custom-dummy",
    ]);
    expect(run.results[0].attempts.at(-1)?.status).toBe("succeeded");
  });
  it("fails explicitly on missing provider credentials without dispatch", async () => {
    const execute = vi.fn();
    const registry = new ProviderRegistry([
      {
        id: "custom",
        catalog: () => ["model"],
        capabilities: () => ({
          structuredOutput: true,
          maxOutputTokens: 1000,
          supportedParameters: {},
        }),
        validate: () => undefined,
        execute,
      },
    ]);
    const expert: Expert = {
      id: "x",
      name: "x",
      description: "",
      rolePrompt: "role",
      provider: "custom",
      model: "model",
      maxTokens: 100,
    };
    const run = createRun(
      "question",
      "",
      [expert],
      "model",
      "custom",
      registry,
      { provider: "custom", model: "model", maxTokens: 100 },
      "current-v1",
    );
    await new Engine(() => {}, registry).execute(run, () => "");
    expect(execute).not.toHaveBeenCalled();
    expect(run.results[0].attempts[0].error).toMatch(/key missing/i);
  });
});

it("migrates legacy snapshots to their original OpenAI identity during retry", async () => {
  const {
    createRun: legacyRun,
    Engine: LegacyEngine,
    importHistoricalOpenAIRun,
  } = await import("./legacy-engine");
  const { settings } = await import("./openai-model-compat");
  const adapter = vi
    .fn()
    .mockResolvedValue({ status: "succeeded", text: "answer", ms: 1 });
  const expert: Expert = {
    ...settings("gpt-5.6-terra"),
    id: "old",
    name: "old",
    description: "",
    rolePrompt: "role",
  };
  const run = legacyRun("question", "", [expert], "gpt-5.6-terra");
  const snapshot = structuredClone(run.snapshot);
  delete (snapshot as { validationPolicy?: string }).validationPolicy;
  delete snapshot.experts[0].provider;
  delete snapshot.evaluator.provider;
  run.snapshot = snapshot;
  run.results[0].expert = { ...run.results[0].expert, provider: undefined };
  const imported = importHistoricalOpenAIRun(run);
  await new LegacyEngine(() => {}, adapter).execute(imported, "dummy-key");
  expect(imported.snapshot.experts[0].provider).toBe("openai");
  expect(imported.snapshot.evaluator.provider).toBe("openai");
  expect(Object.isFrozen(imported.snapshot)).toBe(true);
  expect(adapter.mock.calls[0][0]).toBe("dummy-key");
  expect(JSON.stringify(imported.snapshot)).not.toContain("dummy-key");
});
