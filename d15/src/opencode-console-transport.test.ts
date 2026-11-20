import { afterEach, describe, expect, it, vi } from "vitest";
import { consoleTransportUrl } from "./opencode-console-transport";
import { consoleVerificationPlan, verifyConsoleModel } from "./opencode-console-verification";
import { openCodeAdapter } from "./opencode-adapter";
import viteConfig from "../vite.config";

const chat = "https://opencode.ai/inference/openai/v1/chat/completions";
const responses = "https://opencode.ai/inference/openai/v1/responses";

afterEach(() => vi.unstubAllGlobals());
describe("Console development transport", () => {
  it("uses the same-origin route in both verification and expert execution", async () => {
    vi.stubGlobal("window", {});
    const fetcher = vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({ error: { message: "unauthorized" } }) });
    const plan = consoleVerificationPlan("kimi-k3", chat)!;
    await verifyConsoleModel("dummy-key", plan, fetcher);
    await openCodeAdapter("console", fetcher)("dummy-key", { settings: { model: "kimi-k3", maxTokens: 128 }, instructions: "role", input: "test" });
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetcher.mock.calls) {
      expect(url).toBe("/__d5_opencode_console/chat/completions");
      expect(init.headers.Authorization).toBe("Bearer dummy-key");
      expect(JSON.parse(init.body).model).toBe("kimi-k3");
    }
  });
  it("routes only exact official inference URLs and preserves all overrides", () => {
    expect(consoleTransportUrl(chat, true)).toBe("/__d5_opencode_console/chat/completions");
    expect(consoleTransportUrl(responses, true)).toBe("/__d5_opencode_console/responses");
    expect(consoleTransportUrl(chat, false)).toBe(chat);
    expect(consoleTransportUrl("https://proxy.example/inference/openai/v1/chat/completions", true)).toContain("proxy.example");
    expect(consoleTransportUrl(`${chat}?test=1`, true)).toBe(`${chat}?test=1`);
    expect(consoleTransportUrl("https://opencode.ai/inference/go/openai/v1/chat/completions", true)).toContain("/go/");
  });
  it("fixes the upstream host and rewrites only the two allowed inference paths", () => {
    const config = viteConfig;
    const proxy = (config as { server: { proxy: Record<string, { target: string; changeOrigin: boolean; rewrite: (path: string) => string }> } }).server.proxy;
    const [pattern, rule] = Object.entries(proxy)[0];
    expect(rule.target).toBe("https://opencode.ai");
    expect(rule.changeOrigin).toBe(true);
    expect(new RegExp(pattern).test("/__d5_opencode_console/chat/completions")).toBe(true);
    expect(new RegExp(pattern).test("/__d5_opencode_console/responses")).toBe(true);
    expect(new RegExp(pattern).test("/__d5_opencode_console/models")).toBe(true);
    expect(rule.rewrite("/__d5_opencode_console/models")).toBe("/inference/v1/models");
    expect(new RegExp(pattern).test("/__d5_opencode_console/other")).toBe(false);
    expect(rule.rewrite("/__d5_opencode_console/chat/completions")).toBe("/inference/openai/v1/chat/completions");
    expect(rule.rewrite("/__d5_opencode_console/responses")).toBe("/inference/openai/v1/responses");
  });
  it.each([401, 403, 404, 429])("preserves HTTP %s without retry for verification and execution", async (status) => {
    const fetcher = vi.fn().mockResolvedValue({ ok: false, status, json: async () => ({ error: { message: "test rejection" } }) });
    const plan = consoleVerificationPlan("kimi-k3", chat)!;
    const result = await verifyConsoleModel("dummy-key", plan, fetcher);
    expect(result).toContain(String(status));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][1].headers.Authorization).toBe("Bearer dummy-key");
    const attempt = await openCodeAdapter("console", fetcher)("dummy-key", { settings: { model: "kimi-k3", maxTokens: 128 }, instructions: "role", input: "test" });
    expect(attempt.error).toContain(String(status));
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetcher.mock.calls[1][1].body).model).toBe("kimi-k3");
    expect(JSON.stringify(attempt)).not.toContain("dummy-key");
  });
});
