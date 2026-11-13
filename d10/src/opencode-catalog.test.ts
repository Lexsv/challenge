import { describe, expect, it, vi } from "vitest";
import {
  catalog,
  discoverModels,
  parseModels,
  resolvePrice,
  tier,
} from "./opencode-catalog";

describe("OpenCode catalog", () => {
  it("preserves variants, missing cache prices and time billing", () => {
    expect(
      catalog.find((m) => m.id === "deepseek-v4.1-flash-free")?.price.input,
    ).toBe(0);
    expect(
      catalog.find((m) => m.id === "deepseek-v4.1-flash")?.price.input,
    ).toBe(0.3);
    expect(
      catalog.find((m) => m.id === "beam-free")?.price.cacheWrite,
    ).toBeNull();
    expect(resolvePrice("gpt-live-1").unit).toBe("per minute");
  });
  it("never derives premium from price or free from missing prices", () => {
    expect(
      tier("gpt-5.5-pro", catalog.find((m) => m.id === "gpt-5.5-pro")?.price),
    ).toBe("Paid");
    expect(tier("unknown")).toBe("Unknown");
    expect(tier("beam-free")).toBe("Free");
    expect(tier("model", undefined, "Premium")).toBe("Premium");
  });
  it("resolves API and catalog components independently", () => {
    const p = resolvePrice("deepseek-v4.1-flash", { input: 0, cacheWrite: -1 });
    expect(p.input).toEqual({ value: 0, source: "API" });
    expect(p.output).toEqual({ value: 1.2, source: "Catalog" });
    expect(p.cacheWrite).toEqual({ value: null, source: "Unknown" });
    expect(resolvePrice("absent").input.source).toBe("Unknown");
  });
  it("parses documented discovery metadata and uses the Go endpoint without credentials", async () => {
    const data = {
      data: [
        {
          id: "test",
          name: "Test",
          capabilities: { structured_output: true },
          cost: {
            text: {
              input: { price: 0, cache: { read: 0.2 } },
              output: { price: 1 },
            },
          },
        },
      ],
    };
    expect(parseModels(data)[0]).toEqual({
      id: "test",
      name: "Test",
      structuredOutput: true,
      price: { input: 0, output: 1, cacheRead: 0.2 },
    });
    const fetcher = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => data });
    await expect(discoverModels("go", fetcher)).resolves.toHaveLength(1);
    expect(fetcher).toHaveBeenCalledWith(
      "https://opencode.ai/inference/go/v1/models",
      { credentials: "omit", redirect: "error" },
    );
  });
});
