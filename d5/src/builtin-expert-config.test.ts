import { describe, expect, it, vi } from "vitest";
import { createProviderRegistry } from "./provider-registry";
import { catalog } from "./opencode-catalog";
import { consoleModelSelectable } from "./opencode-console-verification";
import { validateExperts } from "./generation";
import { selectExpertProvider } from "./interaction-safety";
import { expertSettingsError } from "./expert-settings-validation";
import { newParameter, parameterPayload } from "./api-parameters";
import { createRun } from "./legacy-engine";
import { settings } from "./openai-model-compat";

const generated = JSON.stringify({ experts: [{ name: "A", roleLabel: "Role", description: "D", rolePrompt: "P" }] });

describe("built-in expert provider configuration", () => {
  it("registers separate catalogs without changing OpenCode metadata or fetching", () => {
    const fetcher = vi.spyOn(globalThis, "fetch");
    const before = structuredClone(catalog);
    const registry = createProviderRegistry();
    expect(registry.modelOptionsFor("openai")).toContain("gpt-5.6-terra");
    expect(registry.modelOptionsFor("opencode-console")).toEqual(catalog.map((model) => model.id).filter((id) => consoleModelSelectable(id)));
    expect(registry.modelOptionsFor("opencode-go")).toContain("grok-4.7");
    expect(registry.modelOptionsFor("opencode-go")).not.toContain("gpt-6-astra");
    expect(registry.modelOptionsFor("gemini")).toContain("gemini-2.5-flash");
    expect(registry.get("gemini")?.executionAvailable).toBe(false);
    expect(catalog).toEqual(before);
    expect(fetcher).not.toHaveBeenCalled();
    fetcher.mockRestore();
  });

  it("initializes new experts without copying generation parameters or reasoning", () => {
    const config = { ...settings("gpt-5.6-terra"), parameters: [{ id: "x", enabled: true, key: "temperature", value: "0.7" }] };
    const expert = validateExperts(generated, true, config)[0];
    expect(expert.parameters).toEqual([]);
    expect(expert.reasoning).toBeUndefined();
    const run = createRun("Question", "", [expert], config.model);
    expect(run.snapshot.experts[0].parameters).toEqual([]);
    expect(config.parameters[0].value).toBe("0.7");
  });

  it("changes only the chosen expert's provider and requires a new model", () => {
    const registry = createProviderRegistry();
    const first = validateExperts(generated, true, settings("gpt-5.6-terra"))[0];
    first.parameters = [{ id: "x", enabled: false, key: "temperature", value: "0.7" }];
    const second = structuredClone(first);
    const changed = selectExpertProvider(first, "gemini");
    expect(changed.model).toBe("");
    expect(changed.parameters).toEqual(first.parameters);
    expect(second).toEqual(first);
    expect(expertSettingsError(changed, "gpt-5.6-terra", registry, "openai")).toMatch(/Select a model/);
    const selected = { ...changed, model: "gemini-2.5-flash" };
    expect(expertSettingsError(selected, "gpt-5.6-terra", registry, "openai")).toBeUndefined();
    expect(() => createRun("Q", "", [selected], "gpt-5.6-terra", "openai", registry)).toThrow(/Gemini execution is not available/);
  });

  it("preserves manual enabled and disabled rows", () => {
    const row = newParameter();
    expect(row).toMatchObject({ enabled: false, key: "", value: "" });
    const enabled = { ...row, enabled: true, key: "temperature", value: "0.7" };
    const disabled = { ...newParameter(), key: "top_p", value: "0.9" };
    expect(parameterPayload([enabled, disabled])).toEqual({ temperature: 0.7 });
    expect(disabled).toMatchObject({ enabled: false, value: "0.9" });
  });
});
