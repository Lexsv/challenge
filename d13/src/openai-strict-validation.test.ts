import { describe, expect, it } from "vitest";
import {
  settings,
  validSettings,
  validateNewOpenAISettings,
} from "./openai-model-compat";

describe("new and historical OpenAI parameter validation", () => {
  const base = { ...settings("gpt-5.6-terra"), provider: "openai" };
  it("accepts the captured output limit and forwards unconfirmed fields", () => {
    const max = {
      id: "a",
      enabled: true,
      key: "max_output_tokens",
      value: "1024",
    };
    expect(
      validateNewOpenAISettings({ ...base, parameters: [max] }),
    ).toBeUndefined();
    const unknown = {
      id: "b",
      enabled: true,
      key: "arbitrary_option",
      value: "1",
    };
    expect(
      validateNewOpenAISettings({ ...base, parameters: [unknown] }),
    ).toBeUndefined();
    expect(validSettings({ ...base, parameters: [unknown] })).toBe(true);
  });
  it("preserves disabled unknown values and rejects managed fields", () => {
    const inactive = {
      id: "a",
      enabled: false,
      key: "unknown_option",
      value: "0.7",
    };
    expect(
      validateNewOpenAISettings({ ...base, parameters: [inactive] }),
    ).toBeUndefined();
    expect(inactive.value).toBe("0.7");
    expect(
      validateNewOpenAISettings({
        ...base,
        parameters: [{ ...inactive, enabled: true, key: "model" }],
      }),
    ).toMatch(/managed/i);
  });
});

it("enforces current policy and explicitly imports historical snapshots without changing them", async () => {
  const { createRun, Engine } = await import("./engine");
  const { importHistoricalOpenAIRun } = await import("./legacy-engine");
  const { createProviderRegistry } = await import("./provider-registry");
  const { vi } = await import("vitest");
  const adapter = vi
    .fn()
    .mockResolvedValueOnce({ status: "failed", text: "", ms: 1 })
    .mockResolvedValueOnce({ status: "succeeded", text: "answer", ms: 1 });
  const registry = createProviderRegistry(adapter);
  const parameter = {
    id: "p",
    enabled: true,
    key: "custom_option",
    value: "3",
  };
  const expert = {
    ...settings("gpt-5.6-terra"),
    provider: "openai",
    id: "x",
    name: "x",
    description: "d",
    rolePrompt: "p",
    parameters: [parameter],
  };
  const evaluator = { ...settings("gpt-5.6-terra"), provider: "openai" };
  expect(
    createRun(
      "q",
      "",
      [expert],
      "gpt-5.6-terra",
      "openai",
      registry,
      evaluator,
      "current-v1",
    ).snapshot.validationPolicy,
  ).toBe("current-v1");
  expect(() =>
    createRun(
      "q",
      "",
      [expert],
      "gpt-5.6-terra",
      "openai",
      registry,
      evaluator,
      undefined as never,
    ),
  ).toThrow(/policy/i);
  const valid = createRun(
    "q",
    "",
    [{ ...expert, parameters: [] }],
    "gpt-5.6-terra",
    "openai",
    registry,
    evaluator,
    "current-v1",
  );
  const old = structuredClone(valid);
  delete (old.snapshot as { validationPolicy?: string }).validationPolicy;
  old.snapshot.experts[0].parameters = [parameter];
  old.results[0].expert = old.snapshot.experts[0];
  const missing = structuredClone(old);
  await new Engine(() => {}, registry).execute(missing, () => "dummy");
  expect(missing.results[0].attempts[0].error).toMatch(/policy is missing/i);
  expect(adapter).not.toHaveBeenCalled();
  const historical = importHistoricalOpenAIRun(old);
  const before = JSON.stringify(historical.snapshot);
  const engine = new Engine(() => {}, registry);
  const key = (provider: string) => (provider === "openai" ? "dummy" : "");
  await engine.execute(historical, key);
  await engine.execute(historical, key, 0);
  expect(adapter).toHaveBeenCalledTimes(2);
  expect(adapter.mock.calls[1][1].settings.parameters).toEqual([parameter]);
  expect(adapter.mock.calls[0][0]).toBe("dummy");
  expect(adapter.mock.calls[0][1].settings.parameters).toEqual([parameter]);
  expect(JSON.stringify(historical.snapshot)).toBe(before);
  expect(old.snapshot.validationPolicy).toBeUndefined();
  expect(Object.isFrozen(historical.snapshot)).toBe(true);
});
