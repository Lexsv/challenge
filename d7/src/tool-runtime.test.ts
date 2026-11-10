import { describe, expect, it, vi } from "vitest";
import type { ToolRecord } from "./tools-page";
import {
  HttpExchangeRateSource,
  MockExchangeRateSource,
  ToolRegistry,
  createBuiltInToolRegistry,
} from "./tool-runtime";

function jsonResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  } as Response;
}

describe("built-in tool runtime", () => {
  it("calculates tax totals", async () => {
    const registry = createBuiltInToolRegistry();
    const result = await registry.executeById("builtin.tax_calculator", {
      amount: 100,
      taxRate: 15,
    });
    expect(result).toEqual({
      ok: true,
      toolId: "builtin.tax_calculator",
      output: {
        amount: 100,
        taxRate: 15,
        taxAmount: 15,
        total: 115,
      },
    });
  });

  it("converts currency from supplied rate", async () => {
    const registry = createBuiltInToolRegistry();
    const result = await registry.executeById("builtin.currency_converter", {
      amount: 100,
      fromCurrency: "usd",
      toCurrency: "eur",
      exchangeRate: 0.92,
    });
    expect(result).toEqual({
      ok: true,
      toolId: "builtin.currency_converter",
      output: {
        amount: 100,
        fromCurrency: "USD",
        toCurrency: "EUR",
        exchangeRate: 0.92,
        convertedAmount: 92,
      },
    });
  });

  it("looks up deterministic mock exchange rates", async () => {
    const registry = createBuiltInToolRegistry(new MockExchangeRateSource());
    const result = await registry.executeById("builtin.exchange_rate", {
      fromCurrency: "USD",
      toCurrency: "JPY",
    });
    expect(result).toEqual({
      ok: true,
      toolId: "builtin.exchange_rate",
      output: {
        fromCurrency: "USD",
        toCurrency: "JPY",
        exchangeRate: 156,
        rateSource: "mock-static-rates-v1",
      },
    });
  });

  it("returns structured errors for invalid arguments and unsupported currencies", async () => {
    const registry = createBuiltInToolRegistry(new MockExchangeRateSource());

    const invalid = await registry.executeById("builtin.tax_calculator", {
      amount: "100",
      taxRate: 10,
    });
    expect(invalid.ok).toBe(false);
    if (invalid.ok) throw new Error("expected error");
    expect(invalid.error.code).toBe("invalid_arguments");

    const unsupported = await registry.executeById("builtin.exchange_rate", {
      fromCurrency: "CAD",
      toCurrency: "CHF",
    });
    expect(unsupported.ok).toBe(false);
    if (unsupported.ok) throw new Error("expected error");
    expect(unsupported.error.code).toBe("execution_error");
    expect(unsupported.error.message).toContain("Unsupported currency pair");
  });

  it("converts 100 USD to EUR with a rate fetched over HTTP", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ rates: { EUR: 0.9 } }));
    const registry = createBuiltInToolRegistry(
      new HttpExchangeRateSource(fetcher as unknown as typeof fetch),
    );

    const rate = await registry.executeById("builtin.exchange_rate", {
      fromCurrency: "USD",
      toCurrency: "EUR",
    });
    expect(rate.ok).toBe(true);
    if (!rate.ok) throw new Error("expected rate");
    expect(rate.output).toMatchObject({ exchangeRate: 0.9, rateSource: "frankfurter.app" });
    expect(fetcher.mock.calls[0][0].toString()).toBe(
      "https://api.frankfurter.dev/v1/latest?from=USD&to=EUR",
    );

    const converted = await registry.executeById("builtin.currency_converter", {
      amount: 100,
      fromCurrency: "USD",
      toCurrency: "EUR",
      exchangeRate: (rate.output as { exchangeRate: number }).exchangeRate,
    });
    expect(converted.ok).toBe(true);
    if (!converted.ok) throw new Error("expected conversion");
    expect((converted.output as { convertedAmount: number }).convertedAmount).toBe(90);
  });

  it("uses the direct CORS-enabled endpoint for CAD to JPY without a redirect", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ rates: { JPY: 112 } }));
    const source = new HttpExchangeRateSource(fetcher as unknown as typeof fetch);

    await expect(source.getRate("CAD", "JPY")).resolves.toBe(112);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0].toString()).toBe(
      "https://api.frankfurter.dev/v1/latest?from=CAD&to=JPY",
    );
  });

  it("invokes a provided fetch function without binding it as a method", async () => {
    let observedThis: unknown;
    const fetcher = function (this: unknown) {
      observedThis = this;
      return Promise.resolve(jsonResponse({ rates: { JPY: 112 } }));
    } as unknown as typeof fetch;

    const source = new HttpExchangeRateSource(fetcher);
    await expect(source.getRate("CAD", "JPY")).resolves.toBe(112);
    expect(observedThis).toBeUndefined();
  });

  it("converts 100 USD to CAD and applies 10% tax using local tools", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ rates: { CAD: 1.36 } }));
    const registry = createBuiltInToolRegistry(
      new HttpExchangeRateSource(fetcher as unknown as typeof fetch),
    );

    const rate = await registry.executeById("builtin.exchange_rate", {
      fromCurrency: "USD",
      toCurrency: "CAD",
    });
    expect(rate.ok).toBe(true);
    if (!rate.ok) throw new Error("expected rate");
    const converted = await registry.executeById("builtin.currency_converter", {
      amount: 100,
      fromCurrency: "USD",
      toCurrency: "CAD",
      exchangeRate: (rate.output as { exchangeRate: number }).exchangeRate,
    });
    expect(converted.ok).toBe(true);
    if (!converted.ok) throw new Error("expected conversion");
    expect((converted.output as { convertedAmount: number }).convertedAmount).toBe(136);

    const taxed = await registry.executeById("builtin.tax_calculator", {
      amount: (converted.output as { convertedAmount: number }).convertedAmount,
      taxRate: 10,
    });
    expect(taxed).toMatchObject({
      ok: true,
      output: { amount: 136, taxRate: 10, taxAmount: 13.6, total: 149.6 },
    });
  });

  it("returns clear errors for provider failures and malformed responses", async () => {
    const unavailable = new HttpExchangeRateSource(
      vi.fn().mockRejectedValue(new Error("network down")) as unknown as typeof fetch,
    );
    await expect(unavailable.getRate("USD", "EUR")).rejects.toThrow(
      "Exchange rate provider is unavailable.",
    );

    const httpFailure = new HttpExchangeRateSource(
      vi.fn().mockResolvedValue(jsonResponse({}, 503)) as unknown as typeof fetch,
    );
    await expect(httpFailure.getRate("USD", "EUR")).rejects.toThrow("HTTP 503");

    const malformed = new HttpExchangeRateSource(
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error("bad JSON");
        },
      }) as unknown as typeof fetch,
    );
    await expect(malformed.getRate("USD", "EUR")).rejects.toThrow("malformed JSON");

    const missingRate = new HttpExchangeRateSource(
      vi.fn().mockResolvedValue(jsonResponse({ rates: {} })) as unknown as typeof fetch,
    );
    await expect(missingRate.getRate("USD", "EUR")).resolves.toBeUndefined();
  });

  it("rejects invalid currency codes before making an HTTP request", async () => {
    const fetcher = vi.fn();
    const registry = createBuiltInToolRegistry(
      new HttpExchangeRateSource(fetcher as unknown as typeof fetch),
    );

    const result = await registry.executeById("builtin.exchange_rate", {
      fromCurrency: "US",
      toCurrency: "EURO",
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid currency error");
    expect(result.error.code).toBe("invalid_arguments");
    expect(result.error.message).toContain("exactly three letters");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("times out an unresponsive exchange-rate provider", async () => {
    const fetcher = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      }),
    );
    const source = new HttpExchangeRateSource(fetcher as typeof fetch, 5);

    await expect(source.getRate("USD", "EUR")).rejects.toThrow("timed out after 5 ms");
  });

  it("handles unknown tool identifiers", async () => {
    const registry = createBuiltInToolRegistry();
    const result = await registry.executeById("missing.tool", {});
    expect(result).toEqual({
      ok: false,
      toolId: "missing.tool",
      error: {
        code: "unknown_tool",
        message: "Tool not found: missing.tool",
      },
    });
  });

  it("supports discovery and execution via registry without hardcoded manager behavior", async () => {
    const registry = createBuiltInToolRegistry(new MockExchangeRateSource());
    const builtIns = registry.listBuiltIn();
    const builtInIds = builtIns.map((tool) => tool.id).sort();
    expect(builtInIds).toEqual([
      "builtin.currency_converter",
      "builtin.exchange_rate",
      "builtin.tax_calculator",
    ]);
    const executionTypes = Object.fromEntries(
      builtIns.map((tool) => [tool.id, tool.executionType]),
    );
    expect(executionTypes).toEqual({
      "builtin.tax_calculator": "function",
      "builtin.currency_converter": "function",
      "builtin.exchange_rate": "http",
    });

    const rate = await registry.executeById("builtin.exchange_rate", {
      fromCurrency: "USD",
      toCurrency: "EUR",
    });
    expect(rate.ok).toBe(true);
    if (!rate.ok) throw new Error("expected rate");
    const converted = await registry.executeById("builtin.currency_converter", {
      amount: 50,
      fromCurrency: "USD",
      toCurrency: "EUR",
      exchangeRate: (rate.output as { exchangeRate: number }).exchangeRate,
    });
    expect(converted.ok).toBe(true);
    if (!converted.ok) throw new Error("expected conversion");
    expect((converted.output as { convertedAmount: number }).convertedAmount).toBe(
      46,
    );
  });

  it("keeps user-created pseudocode tools discoverable but non-executable", () => {
    const registry = new ToolRegistry();
    const userTools: ToolRecord[] = [
      {
        id: "tool-1",
        name: "Pseudo Tax",
        type: "Function",
        description: "User-defined pseudocode helper",
        config: { definition: "result = amount * 1.15" },
      },
    ];

    const catalog = registry.listWithUserTools(userTools);
    expect(catalog).toEqual([
      {
        id: "user:tool-1",
        name: "Pseudo Tax",
        description: "User-defined pseudocode helper",
        executable: false,
        kind: "user-defined",
      },
    ]);
  });
});
