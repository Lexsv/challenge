import { describe, expect, it, vi } from "vitest";
import { httpFailure, sanitizeFailureText } from "./normalized-failure";
import { openCodeAdapter } from "./opencode-adapter";

describe("provider-neutral error normalization", () => {
  it.each([
    [400, "request"], [401, "authentication"], [402, "payment"], [403, "permission"], [404, "not_found"],
    [408, "timeout"], [409, "conflict"], [410, "gone"], [413, "request_too_large"], [422, "request"],
    [429, "rate_limit"], [500, "service"], [502, "service"], [503, "service"], [504, "service"],
  ] as const)("preserves HTTP %i as %s without retry", async (status, category) => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: "Provider rejected dummy-secret" } }), { status, headers: { "Retry-After": "30" } }));
    const result = await openCodeAdapter("console", fetcher)("dummy-secret", { settings: { provider: "opencode-console", model: "kimi-k3", maxTokens: 128 }, instructions: "", input: "" });
    expect(result.failure).toMatchObject({ category, httpStatus: status, retryAfter: "30", providerMessage: "Provider rejected [redacted]" });
    expect(result.error).toContain(String(status));
    expect(JSON.stringify(result)).not.toContain("dummy-secret");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("does not retain unsafe retry headers or credentials", () => {
    expect(httpFailure(429, undefined, "Bearer secret").retryAfter).toBeUndefined();
    expect(sanitizeFailureText("Authorization: Bearer dummy-key oc_sk_123456789abcdef", "dummy-key")).not.toMatch(/dummy-key|123456789abcdef/);
  });
  it("reports network and CORS failures without guessing the cause", async () => {
    const fetcher = vi.fn().mockRejectedValue(new TypeError("private payload"));
    const result = await openCodeAdapter("console", fetcher)("dummy-key", { settings: { model: "kimi-k3", maxTokens: 128 }, instructions: "", input: "" });
    expect(result.failure?.category).toBe("transport");
    expect(result.failure?.summary).toContain("CORS");
    expect(JSON.stringify(result)).not.toContain("private payload");
  });
  it("distinguishes unsupported protocols and malformed successful responses", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("not json", { status: 200 }));
    const adapter = openCodeAdapter("console", fetcher);
    const settings = { model: "unknown-model", maxTokens: 128 };
    expect((await adapter("dummy", { settings, instructions: "", input: "" })).failure?.category).toBe("unsupported_protocol");
    expect(fetcher).not.toHaveBeenCalled();
    expect((await adapter("dummy", { settings: { ...settings, model: "kimi-k3" }, instructions: "", input: "" })).failure?.category).toBe("malformed_response");
  });
});

it("classifies a local timeout without attempting a retry", async () => {
  vi.useFakeTimers();
  try {
    const fetcher = vi.fn().mockImplementation((_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted")))));
    const pending = openCodeAdapter("console", fetcher)("dummy", { settings: { model: "kimi-k3", maxTokens: 128 }, instructions: "", input: "" });
    await vi.advanceTimersByTimeAsync(120000);
    const result = await pending;
    expect(result.status).toBe("timed-out");
    expect(result.failure?.category).toBe("timeout");
    expect(fetcher).toHaveBeenCalledTimes(1);
  } finally { vi.useRealTimers(); }
});
