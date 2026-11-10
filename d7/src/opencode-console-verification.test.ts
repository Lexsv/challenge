import { afterEach, describe, expect, it, vi } from "vitest";
import { consoleVerificationPlan, selectConsoleVerificationPlan, verifyConsoleModel } from "./opencode-console-verification";
import { discoverModels } from "./opencode-catalog";
import { DEFAULT_ENDPOINTS } from "./provider-endpoints";

const endpoint = DEFAULT_ENDPOINTS["opencode-console"];
afterEach(() => vi.restoreAllMocks());
describe("OpenCode Console verification", () => {
  it("does not treat a public catalog response as authentication or initiate inference", async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: [{ id: "kimi-k3" }] }) });
    await expect(discoverModels("console", fetcher)).resolves.toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe("https://opencode.ai/inference/v1/models");
    expect(fetcher.mock.calls[0][1]).not.toHaveProperty("headers");
  });
  it("requires an explicitly selected model with a known protocol", () => {
    expect(consoleVerificationPlan("", endpoint)).toBeUndefined();
    expect(consoleVerificationPlan("unknown", endpoint)).toBeUndefined();
    expect(consoleVerificationPlan("claude-opus-5-5", endpoint)).toBeUndefined();
  });
  it.each([
    ["gpt-6.1-sol", "responses", "/inference/openai/v1/responses"],
    ["kimi-k3", "chat", "/inference/openai/v1/chat/completions"],
  ] as const)("verifies %s using its documented %s protocol", async (model, protocol, path) => {
    const plan = consoleVerificationPlan(model, endpoint)!;
    const fetcher = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => protocol === "responses" ? { model, status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "OK" }] }] } : { model, choices: [{ message: { content: "OK" } }] } });
    expect(plan.endpoint).toBe(`https://opencode.ai${path}`);
    const status = await verifyConsoleModel("dummy-secret", plan, fetcher);
    expect(status).toContain("Authentication verified");
    expect(status).toContain(`Model verified: ${model}`);
    expect(status).toContain("Other models are not verified");
    expect(status).not.toContain("dummy-secret");
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe(plan.endpoint);
    expect(init.redirect).toBe("error");
    expect(init.credentials).toBe("omit");
    const body = JSON.parse(init.body);
    expect(body.model).toBe(model);
    expect(Object.keys(body).sort()).toEqual(protocol === "responses" ? ["input", "model"] : ["messages", "model"]);
  });
  it.each([[401, "Authentication failed"], [403, "permission denied"], [400, "request rejected"], [422, "request rejected"], [500, "inconclusive"]] as const)("distinguishes HTTP %s", async (status, expected) => {
    const result = await verifyConsoleModel("dummy-secret", consoleVerificationPlan("kimi-k3", endpoint)!, vi.fn().mockResolvedValue({ ok: false, status }));
    expect(result).toContain(expected);
    if (status !== 401) expect(result).not.toContain("Authentication failed");
    expect(result).not.toContain("dummy-secret");
  });
  it("does not assume custom endpoints or free models authenticate keys", async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ model: "kimi-k3", choices: [{ message: { content: "OK" } }] }) });
    const custom = consoleVerificationPlan("kimi-k3", "https://example.test/inference/openai/v1/chat/completions")!;
    const free = consoleVerificationPlan("beam-free", endpoint)!;
    expect(await verifyConsoleModel("dummy", custom, fetcher)).toContain("Authentication: inconclusive");
    expect(await verifyConsoleModel("dummy", free, fetcher)).toContain("Authentication: inconclusive");
  });
  it("reports malformed successes and network errors conservatively without exposing secrets", async () => {
    const plan = consoleVerificationPlan("kimi-k3", endpoint)!;
    const malformed = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => { throw new Error("dummy-secret"); } });
    expect(await verifyConsoleModel("dummy-secret", plan, malformed)).toContain("Model result inconclusive");
    const network = vi.fn().mockRejectedValue(new Error("dummy-secret"));
    const result = await verifyConsoleModel("dummy-secret", plan, network);
    expect(result).toContain("inconclusive");
    expect(result).not.toContain("dummy-secret");
    expect(await verifyConsoleModel("", plan, network)).toContain("Enter an API key");
    expect(network).toHaveBeenCalledTimes(1);
  });
  it("does not mark a substituted model as verified", async () => {
    const plan = consoleVerificationPlan("kimi-k3", endpoint)!;
    const fetcher = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ model: "different-model", choices: [{ message: { content: "OK" } }] }) });
    const result = await verifyConsoleModel("dummy", plan, fetcher);
    expect(result).toContain("Model result inconclusive: kimi-k3");
    expect(result).not.toContain("Model verified:");
  });
  it("does not mark an empty or refused model response as verified", async () => {
    const plan = consoleVerificationPlan("kimi-k3", endpoint)!;
    const fetcher = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ model: "kimi-k3", choices: [{ message: { content: "" }, finish_reason: "content_filter" }] }) });
    const result = await verifyConsoleModel("dummy", plan, fetcher);
    expect(result).toContain("Model result inconclusive");
    expect(result).not.toContain("Model verified:");
  });
});


it("resolves selected-model endpoints from the Console provider base", async () => {
  const { consoleBaseEndpoint, consoleConfiguredEndpoint } = await import("./provider-endpoints");
  const base = consoleBaseEndpoint(endpoint);
  expect(base).toBe("https://opencode.ai/inference");
  expect(consoleConfiguredEndpoint(base)).toBe(endpoint);
  expect(consoleVerificationPlan("gpt-5.5", consoleConfiguredEndpoint(base))?.endpoint).toBe("https://opencode.ai/inference/openai/v1/responses");
  expect(consoleVerificationPlan("kimi-k3", consoleConfiguredEndpoint(base))?.endpoint).toBe(endpoint);
  expect(consoleVerificationPlan("", endpoint)).toBeUndefined();
});

it("does not dispatch a confirmed verification without a credential", async () => {
  const fetcher = vi.fn();
  const status = await verifyConsoleModel(" ", consoleVerificationPlan("kimi-k3", endpoint)!, fetcher);
  expect(status).toContain("Enter an API key");
  expect(fetcher).not.toHaveBeenCalled();
});


describe("automatic Console verification model", () => {
  it("skips restricted, unknown, and unsupported models in returned order", () => {
    const models = [
      { id: "beam-free", name: "Free" },
      { id: "big-pickle", name: "Free without suffix" },
      { id: "unknown-model", name: "Unknown", price: { input: 1, output: 1 } },
      { id: "glm-5.3-flash", name: "First supported" },
      { id: "kimi-k3", name: "Second supported" },
    ];
    const plan = selectConsoleVerificationPlan(models, endpoint);
    expect(plan?.model).toBe("glm-5.3-flash");
    expect(plan?.endpoint).toBe("https://opencode.ai/inference/openai/v1/chat/completions");
    expect(models[3].id).toBe("glm-5.3-flash");
  });
  it("returns no plan for empty or restricted catalogs", () => {
    expect(selectConsoleVerificationPlan([], endpoint)).toBeUndefined();
    expect(selectConsoleVerificationPlan([{ id: "beam-free", name: "Free" }, { id: "big-pickle", name: "Free" }], endpoint)).toBeUndefined();
  });
  it("makes one inference request without fallback after rejection", async () => {
    const plan = selectConsoleVerificationPlan([{ id: "glm-5.3-flash", name: "First" }, { id: "kimi-k3", name: "Second" }], endpoint)!;
    const fetcher = vi.fn().mockResolvedValue({ ok: false, status: 403 });
    expect(await verifyConsoleModel("dummy-key", plan, fetcher)).toContain("403");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetcher.mock.calls[0][1].body).model).toBe("glm-5.3-flash");
  });
});
