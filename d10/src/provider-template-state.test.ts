import { describe, expect, it, vi } from "vitest";
import { deleteTemplates, openTemplates, saveTemplates, switchTemplateModel } from "./provider-template-state";
import { validateExperts } from "./generation";
import { createRun, Engine } from "./legacy-engine";
import { settings } from "./openai-model-compat";
import { newParameter } from "./api-parameters";

const providers = ["openai", "opencode-console", "opencode-go", "gemini", "custom-1"];
const row = { id: "p", enabled: true, key: "temperature", value: "0.7" };

describe("provider template draft interactions", () => {
  it.each(providers)("isolates Save and Cancel for %s", (id) => {
    const saved = { [id]: { model: [row] }, other: { model: [{ ...row, value: "0.2" }] } };
    const draft = openTemplates(saved, id);
    draft.model[0].value = "1.2";
    expect(saved[id].model[0].value).toBe("0.7"); // Cancel leaves saved state alone.
    const committed = saveTemplates(saved, id, draft, "model", draft.model);
    draft.model[0].value = "1.9";
    expect(committed[id].model[0].value).toBe("1.2");
    expect(committed.other).toEqual(saved.other);
  });

  it("preserves editable disabled rows and separates models", () => {
    const added = newParameter();
    expect(added).toMatchObject({ enabled: false, key: "", value: "" });
    const disabled = { ...added, key: "top_p", value: "0.5" };
    const first = switchTemplateModel({}, "a", [row, disabled], "b");
    expect(first.rows).toEqual([]);
    const back = switchTemplateModel(first.templates, "b", [], "a");
    expect(back.rows).toEqual([row, disabled]);
    const edited = back.rows.map((item) => item.id === disabled.id ? { ...item, enabled: true, value: "0.8" } : item).filter((item) => item.id !== row.id);
    expect(edited).toEqual([{ ...disabled, enabled: true, value: "0.8" }]);
  });

  it("deletes only the confirmed provider configuration", () => {
    const saved = { openai: { a: [row] }, "opencode-go": { b: [row] } };
    const cancelled = openTemplates(saved, "openai");
    expect(cancelled).toEqual(saved.openai);
    expect(saved.openai).toBeDefined();
    const confirmed = deleteTemplates(saved, "openai");
    expect(confirmed.openai).toBeUndefined();
    expect(confirmed["opencode-go"]).toEqual(saved["opencode-go"]);
  });

  it("does not copy templates into new experts, snapshots, or requests", async () => {
    const template = saveTemplates({}, "openai", {}, "gpt-5.6-terra", [row]);
    const text = JSON.stringify({ experts: [{ name: "A", roleLabel: "Role", description: "D", rolePrompt: "P" }] });
    const expert = validateExperts(text, true, settings("gpt-5.6-terra"))[0];
    const run = createRun("Question", "", [expert], "gpt-5.6-terra");
    const execute = vi.fn().mockResolvedValue({ status: "succeeded", text: "ok", ms: 1 });
    expect(execute).not.toHaveBeenCalled();
    await new Engine(() => {}, execute).execute(run, "dummy-openai");
    expect(template.openai["gpt-5.6-terra"]).toEqual([row]);
    expect(expert.parameters).toEqual([]);
    expect(run.snapshot.experts[0].parameters).toEqual([]);
    expect(execute.mock.calls[0][1].settings.parameters).toEqual([]);
    expect(execute.mock.calls[0][0]).toBe("dummy-openai");
  });

  it("leaves an existing expert's enabled and disabled rows untouched", async () => {
    const text = JSON.stringify({ experts: [{ name: "A", roleLabel: "Role", description: "D", rolePrompt: "P" }] });
    const expert = validateExperts(text, true, settings("gpt-5.6-terra"))[0];
    expert.parameters = [{ ...row, value: "0.1" }, { id: "off", enabled: false, key: "top_p", value: "0.9" }];
    const run = createRun("Question", "", [expert], "gpt-5.6-terra");
    saveTemplates({}, "openai", {}, "gpt-5.6-terra", [{ ...row, value: "1.2" }]);
    const execute = vi.fn().mockResolvedValue({ status: "succeeded", text: "ok", ms: 1 });
    await new Engine(() => {}, execute).execute(run, "dummy-openai");
    expect(run.snapshot.experts[0].parameters).toEqual(expert.parameters);
    expect(execute.mock.calls[0][1].settings.parameters).toEqual(expert.parameters);
  });
});
