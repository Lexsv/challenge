import { describe, expect, it } from "vitest";
import { resolveExpert, type Expert } from "./models";

describe("provider-neutral model identity", () => {
  it("does not infer reasoning or parameters from a shared model ID", () => {
    const expert: Expert = {
      id: "1",
      name: "Test",
      description: "",
      rolePrompt: "",
      provider: "custom",
      model: "gpt-5.6-terra",
      maxTokens: 100,
    };
    const resolved = resolveExpert(expert, "unused");
    expect(resolved.provider).toBe("custom");
    expect(resolved.reasoning).toBeUndefined();
    expect(resolved.parameters).toBeUndefined();
  });
});

it("inherits a default model only from the same explicit provider", () => {
  const custom: Expert = {
    id: "x",
    name: "x",
    description: "d",
    rolePrompt: "r",
    provider: "custom",
    model: "",
    maxTokens: 100,
  };
  expect(resolveExpert(custom, "openai-model", "openai").model).toBe("");
  expect(resolveExpert(custom, "custom-model", "custom").model).toBe(
    "custom-model",
  );
  expect(
    resolveExpert({ ...custom, model: "chosen" }, "other", "openai").model,
  ).toBe("chosen");
  expect(
    resolveExpert({ ...custom, provider: undefined }, "openai-model", "openai")
      .model,
  ).toBe("");
});
