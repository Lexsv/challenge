import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ProviderRegistry, createProviderRegistry } from "./provider-registry";
import { ModelField } from "./main";

describe("provider-scoped model options and defaults", () => {
  it("isolates model lists and defaults, including identical IDs", () => {
    const openai = createProviderRegistry().get("openai")!;
    const go = {
      id: "opencode-go",
      catalog: () => ["gpt-5.6-terra", "unknown"],
      capabilities: (id: string) =>
        id === "gpt-5.6-terra"
          ? {
              structuredOutput: true,
              maxOutputTokens: 1000,
              supportedParameters: {},
            }
          : undefined,
      validate: () => undefined,
      execute: async () => ({
        status: "succeeded" as const,
        text: "ok",
        ms: 0,
      }),
    };
    const registry = new ProviderRegistry([openai, go]);
    expect(registry.modelOptionsFor("openai")).toContain("gpt-6.1-sol");
    expect(registry.modelOptionsFor("opencode-go")).toEqual(["gpt-5.6-terra"]);
    expect(registry.modelOptionsFor(undefined)).toEqual([]);
    expect(
      registry.initialParametersFor("openai", "gpt-5.6-terra", 500)[0].key,
    ).toBe("max_output_tokens");
    expect(
      registry.initialParametersFor("opencode-go", "gpt-5.6-terra", 500),
    ).toEqual([]);
    expect(registry.initialParametersFor("openai", "unknown", 500)).toEqual([]);
  });
  it("shows an explicit unresolved-provider and undiscovered-model message", () => {
    const empty = new ProviderRegistry([
      {
        id: "empty",
        catalog: () => ["id"],
        capabilities: () => undefined,
        validate: () => undefined,
        execute: async () => ({
          status: "succeeded" as const,
          text: "ok",
          ms: 0,
        }),
      },
    ]);
    expect(
      renderToStaticMarkup(
        <ModelField
          label="Model"
          value=""
          onChange={() => {}}
          registry={empty}
        />,
      ),
    ).toContain("Select a provider first.");
    expect(
      renderToStaticMarkup(
        <ModelField
          label="Model"
          value=""
          onChange={() => {}}
          registry={empty}
          providerId="empty"
        />,
      ),
    ).toContain("No discovered models available for this provider.");
  });
});
