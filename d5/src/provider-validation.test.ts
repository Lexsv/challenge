import { afterEach, describe, expect, it, vi } from "vitest";
import { createProviderRegistry } from "./provider-registry";

afterEach(() => vi.unstubAllGlobals());
describe("provider-specific capabilities", () => {
  it("treats missing metadata as unknown and enforces discovered capabilities independently", async () => {
    const data = {
      data: [
        {
          id: "same-id",
          capabilities: {
            structured_output: true,
            temperature: true,
            top_p: false,
            max_completion_tokens: true,
          },
          limit: { output: 1024 },
        },
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => data }),
    );
    const registry = createProviderRegistry();
    const go = registry.get("opencode-go")!;
    const config = {
      provider: "opencode-go",
      model: "same-id",
      maxTokens: 512,
    };
    expect(go.validate(config)).toMatch(/unknown/i);
    expect(registry.get("openai")!.capabilities("same-id")).toBeUndefined();
    await go.discover!();
    expect(go.capabilities("same-id")?.structuredOutput).toBe(true);
    expect(go.validate(config)).toBeUndefined();
    expect(go.validate({ ...config, maxTokens: 2048 })).toMatch(/limit/i);
    expect(
      go.validate({
        ...config,
        parameters: [{ id: "a", enabled: true, key: "top_p", value: "0.5" }],
      }),
    ).toMatch(/unsupported/i);
    expect(
      go.validate({
        ...config,
        parameters: [
          { id: "a", enabled: true, key: "temperature", value: "0.5" },
        ],
      }),
    ).toBeUndefined();
    expect(
      registry.get("opencode-console")!.capabilities("same-id"),
    ).toBeUndefined();
  });
});

it("validates expert settings against its provider even when model IDs match", async () => {
  const { ProviderRegistry } = await import("./provider-registry");
  const { expertSettingsError } = await import("./expert-settings-validation");
  const adapter = async () => ({
    status: "succeeded" as const,
    text: "ok",
    ms: 0,
  });
  const capabilities = {
    structuredOutput: true,
    maxOutputTokens: 1000,
    supportedParameters: {},
  };
  const registry = new ProviderRegistry([
    {
      id: "first",
      catalog: () => ["shared"],
      capabilities: () => capabilities,
      validate: (s) => (s.reasoning === "low" ? undefined : "Requires low"),
      execute: adapter,
    },
    {
      id: "second",
      catalog: () => ["shared"],
      capabilities: () => capabilities,
      validate: (s) => (s.reasoning ? "Reasoning unsupported" : undefined),
      execute: adapter,
    },
  ]);
  const expert = {
    id: "x",
    name: "x",
    description: "x",
    rolePrompt: "x",
    provider: "first",
    model: "shared",
    maxTokens: 100,
    reasoning: "low",
  };
  expect(expertSettingsError(expert, "shared", registry)).toBeUndefined();
  expect(
    expertSettingsError({ ...expert, provider: "second" }, "shared", registry),
  ).toBe("Reasoning unsupported");
  expect(
    expertSettingsError({ ...expert, provider: "missing" }, "shared", registry),
  ).toMatch(/Unsupported provider/);
});

it("renders reasoning indicators using provider-scoped model capabilities", async () => {
  const { ProviderRegistry } = await import("./provider-registry");
  const { expertConfigurationLabels } =
    await import("./expert-configuration-chips");
  const execute = async () => ({
    status: "succeeded" as const,
    text: "ok",
    ms: 0,
  });
  const provider = (id: string, efforts: string[]) => ({
    id,
    catalog: () => ["shared"],
    capabilities: () => ({
      structuredOutput: true,
      maxOutputTokens: 1000,
      supportedParameters: {},
      reasoningEfforts: efforts,
    }),
    validate: () => undefined,
    execute,
  });
  const registry = new ProviderRegistry([
    provider("one", ["low"]),
    provider("two", []),
  ]);
  const expert = {
    id: "x",
    name: "x",
    description: "x",
    rolePrompt: "x",
    provider: "one",
    model: "shared",
    maxTokens: 100,
    reasoning: "low",
  };
  expect(expertConfigurationLabels(expert, "shared", registry)).toContain(
    "Reasoning: Low",
  );
  expect(
    expertConfigurationLabels(
      { ...expert, provider: "two" },
      "shared",
      registry,
    ),
  ).toContain("Reasoning: Not supported");
  expect(
    expertConfigurationLabels(
      { ...expert, provider: "missing" },
      "shared",
      registry,
    ),
  ).toContain("Reasoning: Unknown");
});

it("requires explicit provider identity for reasoning capability resolution", async () => {
  const { ProviderRegistry, createProviderRegistry } =
    await import("./provider-registry");
  const openAI = createProviderRegistry().get("openai")!;
  const fake = {
    id: "opencode-go",
    catalog: () => ["gpt-5.6-terra"],
    capabilities: () => ({
      structuredOutput: true,
      maxOutputTokens: 1024,
      supportedParameters: {},
      reasoningEfforts: ["high"],
    }),
    validate: () => undefined,
    execute: async () => ({ status: "succeeded" as const, text: "ok", ms: 0 }),
  };
  const registry = new ProviderRegistry([openAI, fake]);
  expect(
    registry.capabilitiesFor("openai", "gpt-5.6-terra")?.reasoningEfforts,
  ).toContain("low");
  expect(
    registry.capabilitiesFor("opencode-go", "gpt-5.6-terra")?.reasoningEfforts,
  ).toEqual(["high"]);
  expect(registry.capabilitiesFor(undefined, "gpt-5.6-terra")).toBeUndefined();
  expect(registry.capabilitiesFor("unknown", "gpt-5.6-terra")).toBeUndefined();
});

it("isolates parameter policies between providers with the same model", async () => {
  const { ProviderRegistry, createProviderRegistry } =
    await import("./provider-registry");
  const openai = createProviderRegistry().get("openai")!;
  const custom = {
    id: "custom",
    catalog: () => ["gpt-5.6-terra"],
    capabilities: () => ({
      structuredOutput: true,
      maxOutputTokens: 1000,
      supportedParameters: { input: true },
    }),
    validate: (s: import("./models").Settings) =>
      s.parameters?.some((p) => p.enabled && p.key !== "input")
        ? "Unsupported parameter"
        : undefined,
    execute: async () => ({ status: "succeeded" as const, text: "ok", ms: 0 }),
  };
  const registry = new ProviderRegistry([openai, custom]);
  const config = {
    model: "gpt-5.6-terra",
    maxTokens: 100,
    parameters: [{ id: "p", enabled: true, key: "input", value: '"value"' }],
  };
  expect(
    registry.get("custom")!.validate({ ...config, provider: "custom" }),
  ).toBeUndefined();
  expect(
    registry.get("openai")!.validate({ ...config, provider: "openai" }),
  ).toMatch(/managed/i);
  expect(
    registry.get("custom")!.validate({
      ...config,
      provider: "custom",
      parameters: [{ ...config.parameters[0], key: "temperature" }],
    }),
  ).toMatch(/Unsupported/);
});

it("distinguishes supported, unsupported, and unknown parameter metadata", async () => {
  const { parameterSupport, createProviderRegistry } =
    await import("./provider-registry");
  expect(
    parameterSupport({ temperature: true, top_p: false }, "temperature"),
  ).toBe("supported");
  expect(parameterSupport({ temperature: true, top_p: false }, "top_p")).toBe(
    "unsupported",
  );
  expect(parameterSupport(undefined, "temperature")).toBe("unknown");
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          {
            id: "model",
            capabilities: {
              structured_output: true,
              temperature: true,
              top_p: false,
              max_completion_tokens: true,
            },
            limit: { output: 1024 },
          },
        ],
      }),
    }),
  );
  const provider = createProviderRegistry().get("opencode-go")!;
  await provider.discover!();
  const config = { provider: "opencode-go", model: "model", maxTokens: 100 };
  const param = (key: string) => [
    { id: "p", enabled: true, key, value: "0.5" },
  ];
  expect(
    provider.validate({ ...config, parameters: param("temperature") }),
  ).toBeUndefined();
  expect(provider.validate({ ...config, parameters: param("top_p") })).toMatch(
    /unsupported/i,
  );
  expect(
    provider.validate({ ...config, parameters: param("future_parameter") }),
  ).toBeUndefined();
  expect(
    parameterSupport(
      provider.capabilities("model")?.supportedParameters,
      "future_parameter",
    ),
  ).toBe("unknown");
});

it("does not infer OpenCode output-field support from the model output limit", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          {
            id: "unknown-output",
            capabilities: { structured_output: true },
            limit: { output: 1024 },
          },
          {
            id: "unsupported-output",
            capabilities: {
              structured_output: true,
              max_completion_tokens: false,
            },
            limit: { output: 1024 },
          },
          {
            id: "supported-output",
            capabilities: {
              structured_output: true,
              max_completion_tokens: true,
            },
            limit: { output: 1024 },
          },
        ],
      }),
    }),
  );
  const provider = createProviderRegistry().get("opencode-go")!;
  await provider.discover!();
  const config = { provider: "opencode-go", maxTokens: 100 };
  expect(
    provider.validate({ ...config, model: "unknown-output" }),
  ).toBeUndefined();
  expect(
    provider.capabilities("unknown-output")?.supportedParameters
      .max_completion_tokens,
  ).toBeUndefined();
  expect(provider.validate({ ...config, model: "unsupported-output" })).toMatch(
    /does not support/i,
  );
  expect(
    provider.validate({ ...config, model: "supported-output" }),
  ).toBeUndefined();
});
