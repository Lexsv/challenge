import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_ENDPOINTS, discoveryEndpoint, validateEndpoint, type BuiltinEndpointId } from "./provider-endpoints";
import { createProviderRegistry } from "./provider-registry";
import { settings } from "./openai-model-compat";
import { createRun, Engine } from "./legacy-engine";

afterEach(() => vi.unstubAllGlobals());
describe("provider endpoint overrides", () => {
  it.each(Object.keys(DEFAULT_ENDPOINTS) as BuiltinEndpointId[])("isolates and explicitly approves %s", (id) => {
    const registry = createProviderRegistry();
    const endpoint = new URL(DEFAULT_ENDPOINTS[id]);
    endpoint.host = "trusted.example";
    const custom = endpoint.href;
    expect(() => registry.setEndpoint(id, custom)).toThrow(/Confirm/);
    expect(registry.endpointFor(id)).toBe(DEFAULT_ENDPOINTS[id]);
    registry.setEndpoint(id, custom, true);
    expect(registry.endpointFor(id)).toBe(custom);
    for (const other of Object.keys(DEFAULT_ENDPOINTS).filter((v) => v !== id)) expect(registry.endpointFor(other)).toBe(DEFAULT_ENDPOINTS[other as BuiltinEndpointId]);
    registry.setEndpoint(id, DEFAULT_ENDPOINTS[id]);
    expect(registry.endpointFor(id)).toBe(DEFAULT_ENDPOINTS[id]);
  });
  it("rejects insecure, credential-bearing and malformed protocol paths", () => {
    for (const url of ["http://example.test/v1/responses", "https://user:pass@example.test/v1/responses", "https://example.test/v1/responses?x=1", "https://example.test/v1/responses#x", "https://example.test/wrong"]) expect(validateEndpoint("openai", url)).toBeDefined();
    expect(validateEndpoint("openai", "https://example.test/v1/responses")).toBeUndefined();
    expect(discoveryEndpoint("opencode-go", "https://example.test/inference/go/openai/v1/chat/completions")).toBe("https://example.test/inference/go/v1/models");
  });
  it("routes OpenAI verification and execution to the approved URL without logging the key", async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: "completed", output: [{ content: [{ type: "output_text", text: "ok" }] }] }) });
    vi.stubGlobal("fetch", fetcher);
    const registry = createProviderRegistry();
    const url = "https://proxy.example/v1/responses";
    registry.setEndpoint("openai", url, true);
    const result = await registry.get("openai")!.execute("dummy-key", { settings: settings("gpt-5.6-terra"), instructions: "role", input: "q" });
    expect(fetcher.mock.calls[0][0]).toBe(url);
    expect(fetcher.mock.calls[0][1].redirect).toBe("error");
    expect(JSON.stringify(result)).not.toContain("dummy-key");
  });
  it("sanitizes a provider error at an approved custom endpoint", async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: { message: "Rejected dummy-secret" } }) });
    vi.stubGlobal("fetch", fetcher);
    const registry = createProviderRegistry();
    registry.setEndpoint("openai", "https://proxy.example/v1/responses", true);
    const result = await registry.get("openai")!.execute("dummy-secret", { settings: { ...settings("gpt-5.6-terra"), parameters: [] }, instructions: "role", input: "q" });
    expect(fetcher.mock.calls[0][0]).toBe("https://proxy.example/v1/responses");
    expect(result.error).toContain("Rejected");
    expect(JSON.stringify(result)).not.toContain("dummy-secret");
  });
  it.each(["console", "go"] as const)("routes %s discovery and execution independently", async (mode) => {
    const fetcher = vi.fn().mockImplementation(async (_url, init) => init?.method === "POST" ? { ok: true, json: async () => ({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }) } : { ok: true, json: async () => ({ data: [{ id: "test", capabilities: { structured_output: true }, limit: { output: 1024 } }] }) });
    vi.stubGlobal("fetch", fetcher);
    const registry = createProviderRegistry();
    const id = `opencode-${mode}` as const;
    const endpoint = new URL(DEFAULT_ENDPOINTS[id]); endpoint.host = `${mode}.example`;
    registry.setEndpoint(id, endpoint.href, true);
    expect(fetcher).not.toHaveBeenCalled();
    await registry.get(id)!.discover!();
    expect(fetcher.mock.calls[0][0]).toBe(discoveryEndpoint(id, endpoint.href));
    const result = await registry.get(id)!.execute("dummy-key", { settings: { provider: id, model: "test", maxTokens: 128 }, instructions: "role", input: "q" });
    expect(fetcher.mock.calls[1][0]).toBe(endpoint.href);
    expect(JSON.stringify(result)).not.toContain("dummy-key");
  });
  it("discards discovery results from an endpoint that changed mid-request", async () => {
    let finish!: (value: unknown) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise((resolve) => { finish = resolve; })));
    const registry = createProviderRegistry();
    const pending = registry.get("opencode-console")!.discover!();
    registry.setEndpoint("opencode-console", "https://new.example/inference/openai/v1/chat/completions", true);
    finish({ ok: true, json: async () => ({ data: [{ id: "old-model", capabilities: { structured_output: true }, limit: { output: 1024 } }] }) });
    await expect(pending).rejects.toThrow(/Endpoint changed/);
    expect(registry.capabilitiesFor("opencode-console", "old-model")).toBeUndefined();
  });
  it("refuses to retry an immutable run at a changed endpoint", async () => {
    const execute = vi.fn().mockResolvedValue({ status: "failed", text: "", ms: 1 });
    const registry = createProviderRegistry(execute);
    const expert = { ...settings("gpt-5.6-terra"), id: "x", name: "A", description: "D", rolePrompt: "R" };
    const run = createRun("Q", "", [expert], "gpt-5.6-terra", "openai", registry);
    const snapshot = JSON.stringify(run.snapshot);
    registry.setEndpoint("openai", "https://proxy.example/v1/responses", true);
    await new Engine(() => {}, execute, {}, registry).execute(run, "dummy-key");
    expect(execute).not.toHaveBeenCalled();
    expect(run.results[0].attempts[0].error).toMatch(/endpoint changed/);
    expect(JSON.stringify(run.snapshot)).toBe(snapshot);
  });
});
