import { describe, expect, it } from "vitest";
import { experimentCost, formatCost, requestCost } from "./request-cost";
import type { Attempt, Run } from "./models";

const attempt = (changes: Partial<Attempt> = {}): Attempt => ({ id: "a", status: "succeeded", text: "ok", ms: 1, actualModel: "glm-5.3-flash", usage: { input: 100, output: 54 }, ...changes });
describe("historical request costs", () => {
  it("calculates per-million input and output costs using the actual model", () => {
    const cost = requestCost(attempt(), "opencode-console")!;
    expect(cost.usd).toBeCloseTo((100 * 0.15 + 54 * 0.5) / 1_000_000, 12);
    expect(formatCost(cost.usd)).toBe("$0.000042");
    expect(cost.estimated).toBe(true);
    expect(requestCost(attempt({ actualModel: "kimi-k3" }), "opencode-console")?.usd).not.toBe(cost.usd);
  });
  it("does not double-count cached or reasoning tokens", () => {
    const cost = requestCost(attempt({ usage: { input: 100, output: 54, reasoning: 20, cachedInput: 40 } }), "opencode-console")!;
    expect(cost.usd).toBeCloseTo((60 * 0.15 + 40 * 0.03 + 54 * 0.5) / 1_000_000, 12);
  });
  it("prefers reported cost, including real zeros, regardless of missing prices", () => {
    expect(requestCost(attempt({ actualModel: undefined, cost: { usd: 0, source: "provider", estimated: false } }), "opencode-console")?.usd).toBe(0);
    expect(formatCost(0)).toBe("$0.000000");
    expect(formatCost(0.00000000001)).toContain("e-");
  });
  it("leaves unknown models, per-minute pricing, other providers and failures unknown", () => {
    for (const a of [attempt({ actualModel: "unknown" }), attempt({ actualModel: "gpt-live-1" }), attempt({ status: "failed" }), attempt({ actualModel: undefined }), attempt({ usage: { input: 1 } })]) expect(requestCost(a, "opencode-console")).toBeUndefined();
    expect(requestCost(attempt(), "openai")).toBeUndefined();
  });
  it("sums attempts and evaluator requests while identifying partial costs", () => {
    const run = { results: [{ expert: { name: "A", provider: "opencode-console" }, attempts: [attempt()] }, { expert: { name: "B", provider: "opencode-console" }, attempts: [attempt({ status: "failed" })] }], evaluations: [attempt({ cost: { usd: 0.01, source: "provider", estimated: false } })], snapshot: { evaluator: { provider: "openai" } } } as unknown as Run;
    const total = experimentCost(run);
    expect(total.amount).toBeCloseTo(0.010042, 9);
    expect(total.missing).toEqual(["B (attempt 1)"]);
    expect(total.estimated).toBe(true);
  });
});
