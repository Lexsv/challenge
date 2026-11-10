import { describe, expect, it, vi } from "vitest";
import { ProviderRegistry } from "./provider-registry";
import { generateWithProvider, validateExperts } from "./generation";
import { adjacentExpert } from "./interaction-safety";
import type { Adapter } from "./openai";

const ok = { status: "succeeded" as const, text: "{}", ms: 1 };
function setup(id: string, execute: Adapter, structuredOutput = true) {
  return {
    id,
    catalog: () => ["same-model"],
    capabilities: () => ({
      structuredOutput,
      maxOutputTokens: 1000,
      supportedParameters: { temperature: true },
    }),
    validate: () => undefined,
    execute,
  };
}
describe("provider-aware generation", () => {
  it("routes OpenAI and OpenCode to separate adapters and credentials with their settings", async () => {
    const openai = vi.fn().mockResolvedValue(ok),
      console = vi.fn().mockResolvedValue(ok),
      go = vi.fn().mockResolvedValue(ok);
    const registry = new ProviderRegistry([
      setup("openai", openai),
      setup("opencode-console", console),
      setup("opencode-go", go),
    ]);
    const credentials = (id: string) =>
      ({
        openai: "oa-dummy",
        "opencode-console": "console-dummy",
        "opencode-go": "go-dummy",
      })[id] ?? "";
    const parameters = [
      { id: "1", enabled: true, key: "temperature", value: "0.7" },
    ];
    await generateWithProvider(
      registry,
      { provider: "openai", model: "same-model", maxTokens: 100, parameters },
      credentials,
      "team",
      false,
    );
    await generateWithProvider(
      registry,
      {
        provider: "opencode-console",
        model: "same-model",
        maxTokens: 100,
        parameters,
      },
      credentials,
      "team",
      false,
    );
    await generateWithProvider(
      registry,
      {
        provider: "opencode-go",
        model: "same-model",
        maxTokens: 100,
        parameters,
      },
      credentials,
      "team",
      true,
    );
    expect(openai.mock.calls[0][0]).toBe("oa-dummy");
    expect(console.mock.calls[0][0]).toBe("console-dummy");
    expect(go.mock.calls[0][0]).toBe("go-dummy");
    expect(go.mock.calls[0][1].settings).toEqual({
      provider: "opencode-go",
      model: "same-model",
      maxTokens: 100,
      parameters,
    });
  });
  it("rejects unknown providers and unsupported structured output before accessing credentials", async () => {
    const execute = vi.fn().mockResolvedValue(ok),
      credentials = vi.fn().mockReturnValue("dummy");
    const registry = new ProviderRegistry([
      setup("opencode-go", execute, false),
    ]);
    await expect(
      generateWithProvider(
        registry,
        { provider: "unknown", model: "m", maxTokens: 100 },
        credentials,
        "",
        false,
      ),
    ).rejects.toThrow(/Unsupported/);
    await expect(
      generateWithProvider(
        registry,
        { provider: "opencode-go", model: "m", maxTokens: 100 },
        credentials,
        "",
        false,
      ),
    ).rejects.toThrow(/Structured/);
    expect(credentials).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
});

it("preserves a custom generated expert configuration without OpenAI defaults", async () => {
  const { validateExperts } = await import("./generation");
  const config = {
    provider: "custom",
    model: "same-model",
    maxTokens: 123,
    parameters: [{ id: "p", enabled: true, key: "top_p", value: "0.4" }],
  };
  const result = validateExperts(
    JSON.stringify({
      experts: [
        { name: "A", roleLabel: "Role", description: "D", rolePrompt: "P" },
      ],
    }),
    true,
    config,
  )[0];
  expect(result.provider).toBe("custom");
  expect(result.model).toBe("same-model");
  expect(result.reasoning).toBeUndefined();
  expect(result.parameters).toEqual([]);
  expect(result.parameters).not.toBe(config.parameters);
});

it.each([
  ["Create a philosopher", ["Philosopher"]],
  ["Create two agents: a mathematician and a philosopher", ["Mathematician", "Philosopher"]],
] as const)("accepts the Architect's response to %s in one-or-many mode", async (input, names) => {
  const execute = vi.fn().mockResolvedValue({
    ...ok,
    text: JSON.stringify({ experts: names.map((name) => ({
      name, roleLabel: name, description: "Specialist", rolePrompt: "Answer in character.",
    })) }),
  });
  const config = { provider: "openai", model: "same-model", maxTokens: 100 };
  const registry = new ProviderRegistry([setup("openai", execute)]);
  const result = await generateWithProvider(registry, config, () => "fixture", input, false);
  expect(execute).toHaveBeenCalledOnce();
  expect(execute.mock.calls[0][1]).toMatchObject({
    input,
    instructions: expect.stringContaining("Use the requested count when specified."),
  });
  const agents = validateExperts(result.text, false, config);
  expect(agents.map((agent) => agent.name)).toEqual(names);
  expect(new Set(agents.map((agent) => agent.id)).size).toBe(names.length);
});

it("finds the next or previous agent by ID when deleting the selection", () => {
  const agents = validateExperts(JSON.stringify({ experts: ["A", "B", "C"].map((name) => ({
    name, roleLabel: name, description: "Specialist", rolePrompt: "Answer in character.",
  })) }));
  expect(adjacentExpert(agents, agents[1].id)).toBe(agents[2]);
  expect(adjacentExpert(agents, agents[2].id)).toBe(agents[1]);
  expect(adjacentExpert([agents[0]], agents[0].id)).toBeNull();
});
