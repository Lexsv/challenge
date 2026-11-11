import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ConsoleParameterEditor } from "./console-expert-parameters";
import { defaultConsoleRows } from "./console-expert-parameter-rules";
import { parameterPayload, validateParameters } from "./api-parameters";
import { expertSettingsError } from "./expert-settings-validation";
import { openCodeAdapter } from "./opencode-adapter";
import { duplicateExpert } from "./duplicate-expert";
import { createProviderRegistry } from "./provider-registry";
import { createRun } from "./engine";
import { settings } from "./openai-model-compat";

afterEach(() => vi.unstubAllGlobals());
describe("Console expert parameter defaults", () => {
  it("shows unchecked defaults without modifying existing rows", () => {
    const original: ReturnType<typeof defaultConsoleRows> = [];
    const rows = defaultConsoleRows(original);
    expect(rows.map(({ key, value, enabled }) => ({ key, value, enabled }))).toEqual([{ key: "reasoning_effort", value: "medium", enabled: false }, { key: "temperature", value: "1.0", enabled: false }]);
    expect(original).toEqual([]);
    expect(parameterPayload(rows)).toEqual({});
    const markup = renderToStaticMarkup(<ConsoleParameterEditor parameters={[]} onChange={() => {}} />);
    expect(markup).toContain("reasoning_effort"); expect(markup).toContain("temperature");
  });
  it("accepts experimental values while still rejecting malformed rows", () => {
    const rows = defaultConsoleRows([]);
    const [effort, temp] = rows;
    const expert = { id: "e", name: "A", description: "D", rolePrompt: "R", provider: "opencode-console", model: "kimi-k3", maxTokens: 100, parameters: [{ ...effort, enabled: true, value: "experimental" }, { ...temp, enabled: true, value: "2.1" }] };
    expect(expertSettingsError(expert, "", createProviderRegistry())).toBeUndefined();
    expect(validateParameters([{ ...temp, enabled: true, value: "{" }])).toMatch(/Invalid JSON/);
  });
  it("maps supported effort to Responses reasoning and omits disabled temperature", async () => {
    const rows = defaultConsoleRows([]); rows[0].enabled = true;
    const fetcher = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ model: "gpt-5.6-terra", status: "completed", output: [{ content: [{ type: "output_text", text: "ok" }] }] }) });
    await openCodeAdapter("console", fetcher)("dummy", { settings: { model: "gpt-5.6-terra", maxTokens: 100, parameters: rows }, instructions: "", input: "" });
    const body = JSON.parse(fetcher.mock.calls[0][1].body);
    expect(body.reasoning).toEqual({ effort: "medium" }); expect(body).not.toHaveProperty("reasoning_effort"); expect(body).not.toHaveProperty("temperature");
  });
  it("forwards experimental parameters and shows provider rejection", async () => {
    const rows = defaultConsoleRows([]); rows[0].enabled = true; rows[1].enabled = true; rows[1].value = "2.1";
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: "unsupported temperature" } }), { status: 400 }));
    const result = await openCodeAdapter("console", fetcher)("dummy", { settings: { model: "kimi-k3", maxTokens: 100, parameters: rows }, instructions: "", input: "" });
    expect(result.status).toBe("failed"); expect(result.error).toContain("unsupported temperature"); expect(result.error).toContain("400");
    expect(fetcher).toHaveBeenCalledOnce();
    const body = JSON.parse(fetcher.mock.calls[0][1].body);
    expect(body.model).toBe("kimi-k3"); expect(body.reasoning_effort).toBe("medium"); expect(body.temperature).toBe(2.1);
  });
  it("preserves enabled states and independent values in copies and frozen run snapshots", async () => {
    const rows = defaultConsoleRows([]); rows[0].enabled = true;
    const expert = { id: "expert", name: "A", description: "D", rolePrompt: "R", provider: "opencode-console", model: "gpt-5.6-terra", maxTokens: 100, parameters: rows };
    const duplicate = duplicateExpert([expert], expert.id)[1];
    expect(duplicate.parameters).toEqual(rows); expect(duplicate.parameters).not.toBe(rows);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ id: expert.model, limit: { output: 1000 }, capabilities: { structured_output: true } }] }), { status: 200 })));
    const registry = createProviderRegistry(); await registry.get("opencode-console")!.discover!();
    const evaluator = settings("gpt-5.6-terra");
    const run = createRun("Question", "", [expert], evaluator.model, "openai", registry, evaluator, "current-v1");
    rows[0].value = "high"; rows[1].enabled = true;
    expect(run.snapshot.experts[0].parameters?.[0]).toMatchObject({ value: "medium", enabled: true });
    expect(run.snapshot.experts[0].parameters?.[1]).toMatchObject({ value: "1.0", enabled: false });
  });
});
