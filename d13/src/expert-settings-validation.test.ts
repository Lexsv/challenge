import { describe, expect, it } from "vitest";
import { expertSettingsError } from "./expert-settings-validation";
import { type Expert } from "./models";
import { settings } from "./openai-model-compat";
import { createProviderRegistry } from "./provider-registry";
import { newParameter } from "./api-parameters";
const expert: Expert = {
  ...settings(""),
  provider: "openai",
  id: "one",
  name: "Expert",
  description: "Description",
  rolePrompt: "Prompt",
  parameters: [
    { id: "one", enabled: true, key: "max_output_tokens", value: "8192" },
    { id: "two", enabled: false, key: "temperature", value: "0" },
  ],
};
const registry = createProviderRegistry();
const validateExpert = (expert: Expert, model: string) =>
  expertSettingsError(expert, model, registry, "openai");
describe("expert settings Save validation", () => {
  it("accepts parameter edits, toggles, additions and deletions when valid", () => {
    for (const value of ["0", "0.7", "1.2"])
      for (const enabled of [false, true]) {
        const parameters = [
          expert.parameters![0],
          { ...expert.parameters![1], value, enabled },
          newParameter(),
        ];
        expect(
          validateExpert({ ...expert, parameters }, "gpt-5.6-terra"),
        ).toBeUndefined();
        parameters[2] = {
          ...parameters[2],
          key: "top_p",
          value: "0.7",
          enabled: true,
        };
        expect(
          validateExpert({ ...expert, parameters }, "gpt-5.6-terra"),
        ).toBeUndefined();
        expect(
          validateExpert(
            { ...expert, parameters: parameters.slice(1) },
            "gpt-5.6-terra",
          ),
        ).toBeUndefined();
      }
  });
  it("explains independent existing validation blockers instead of hiding them", () => {
    expect(
      validateExpert({ ...expert, description: "" }, "gpt-5.6-terra"),
    ).toContain("description");
    expect(
      validateExpert(
        {
          ...expert,
          parameters: [
            ...expert.parameters!,
            { ...newParameter(), enabled: true },
          ],
        },
        "gpt-5.6-terra",
      ),
    ).toContain("key");
    expect(
      validateExpert({ ...expert, model: "custom-model" }, "gpt-5.6-terra"),
    ).toContain("unknown");
  });
});

it("does not infer OpenAI when provider or registry context is missing", () => {
  expect(
    expertSettingsError(expert, "gpt-5.6-terra", undefined, "openai"),
  ).toContain("registry");
  expect(
    expertSettingsError(
      { ...expert, provider: undefined },
      "gpt-5.6-terra",
      registry,
      "openai",
    ),
  ).toContain("identity");
});
