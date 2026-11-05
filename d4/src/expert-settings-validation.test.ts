import { describe, expect, it } from "vitest";
import { expertSettingsError } from "./expert-settings-validation";
import { settings, type Expert } from "./models";
import { newParameter } from "./api-parameters";
const expert: Expert = {
  ...settings(""),
  id: "one",
  name: "Expert",
  description: "Description",
  rolePrompt: "Prompt",
  parameters: [
    { id: "one", enabled: true, key: "max_output_tokens", value: "8192" },
    { id: "two", enabled: false, key: "temperature", value: "0" },
  ],
};
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
          expertSettingsError({ ...expert, parameters }, "gpt-5.6-terra"),
        ).toBeUndefined();
        parameters[2] = {
          ...parameters[2],
          key: "top_p",
          value: "0.7",
          enabled: true,
        };
        expect(
          expertSettingsError({ ...expert, parameters }, "gpt-5.6-terra"),
        ).toBeUndefined();
        expect(
          expertSettingsError(
            { ...expert, parameters: parameters.slice(1) },
            "gpt-5.6-terra",
          ),
        ).toBeUndefined();
      }
  });
  it("explains independent existing validation blockers instead of hiding them", () => {
    expect(
      expertSettingsError({ ...expert, description: "" }, "gpt-5.6-terra"),
    ).toContain("description");
    expect(
      expertSettingsError(
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
      expertSettingsError(
        { ...expert, model: "custom-model" },
        "gpt-5.6-terra",
      ),
    ).toContain("4096");
  });
});
