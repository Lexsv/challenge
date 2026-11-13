import { describe, expect, it } from "vitest";
import { initialLabTab } from "./navigation";
import { createProviderRegistry } from "./provider-registry";
import { settings } from "./openai-model-compat";
const registry = createProviderRegistry();
describe("initial navigation", () => {
  it("requires explicit credentials, provider and supported model", () => {
    const config = { ...settings("gpt-5.6-terra"), provider: "openai" };
    expect(initialLabTab("", config, registry)).toBe("settings");
    expect(
      initialLabTab("dummy", { ...config, provider: undefined }, registry),
    ).toBe("settings");
    expect(
      initialLabTab("dummy", { ...config, provider: "missing" }, registry),
    ).toBe("settings");
    expect(
      initialLabTab("dummy", { ...config, model: "unknown" }, registry),
    ).toBe("settings");
    expect(initialLabTab("dummy", config, registry)).toBe("lab");
  });
});

it("uses the explicitly selected custom provider rather than model name", async () => {
  const { ProviderRegistry } = await import("./provider-registry");
  const custom = new ProviderRegistry([
    {
      id: "custom",
      catalog: () => ["gpt-5.6-terra"],
      capabilities: () => ({
        structuredOutput: false,
        maxOutputTokens: 1000,
        supportedParameters: {},
      }),
      validate: () => undefined,
      execute: async () => ({ status: "succeeded", text: "ok", ms: 0 }),
    },
  ]);
  expect(
    initialLabTab(
      "dummy",
      { provider: "custom", model: "gpt-5.6-terra", maxTokens: 100 },
      custom,
    ),
  ).toBe("settings");
});
