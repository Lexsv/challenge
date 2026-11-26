import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import {
  billingUsage,
  providerCost,
  tokenCost,
  tokenPricing,
} from "./token-billing";
import { finishMeter, type RequestMeter } from "./token-meter";
import { ProviderModelTable, sortedPricingRows } from "./provider-model-table";
import { ProviderRegistry } from "./provider-registry";
import { DEFAULT_ENDPOINTS } from "./provider-endpoints";
import { aggregateSessionStats } from "./session-stats";
import { emptySession } from "./session-api";

const consoleId = "opencode-console";
const endpoint = DEFAULT_ENDPOINTS[consoleId];
const model = "gpt-6-astra";
const base: RequestMeter = {
  id: "test",
  provider: consoleId,
  model,
  library: "js-tiktoken",
  startedAt: 1,
  status: "running",
};
const price = tokenPricing(consoleId, model, endpoint);

it("reconciles the nine-request Astra dashboard to the cent at published Console rates", () => {
  // Persisted inclusive input/output per request. Only the dashboard aggregate of 27 ordinary inputs is available.
  const input = [1815, 8060, 8294, 9581, 9961, 10483, 11181, 11764, 11975];
  const output = [32, 44, 38, 52, 426, 412, 249, 68, 103];
  const sum = (numbers: number[]) => numbers.reduce((a, b) => a + b, 0);
  expect(input).toHaveLength(9);
  expect(Math.max(...input)).toBeLessThan(272000);
  expect(price).toMatchObject({
    inputPerMillion: 10,
    outputPerMillion: 50,
    cachedInputPerMillion: 1,
    cacheWritePerMillion: 12.5,
  });
  expect((sum(input) * 10 + sum(output) * 50) / 1e6).toBeCloseTo(0.90234, 10);
  const writes = sum(input) - 27; // Reconstructed with zero recorded reads, consistent with the dashboard's ~83k writes.
  expect(writes).toBe(83087);
  const estimate = tokenCost(
    billingUsage(consoleId, {
      opencode: {
        tokens: {
          input: 27,
          output: sum(output),
          cache_read: 0,
          cache_write_5m: writes,
          cache_write_1h: 0,
        },
      },
    }),
    price,
  );
  expect(estimate).toBeCloseTo(1.1100575, 10);
  expect(estimate?.toFixed(2)).toBe("1.11");
});

it("uses OpenCode billed buckets and the provider receipt, including reasoning in output only once", () => {
  // Published Inference API example. The ordinary prompt count excludes the additional billed cache reads here.
  const usage = {
    prompt_tokens: 1200,
    completion_tokens: 300,
    cost: 0.00412,
    opencode: {
      tokens: {
        input: 1200,
        output: 300,
        reasoning: 120,
        cache_read: 8000,
        cache_write_5m: 0,
        cache_write_1h: 0,
      },
    },
  };
  const meter = finishMeter(base, { usage }, endpoint);
  expect(meter).toMatchObject({
    actualInputTokens: 9200,
    actualOutputTokens: 300,
    actualTotalTokens: 9500,
    cachedInputTokens: 8000,
    cacheWriteTokens: 0,
    estimatedRequestCost: (1200 * 10 + 300 * 50 + 8000) / 1e6,
    providerRequestCost: 0.00412,
    providerCostEstimated: false,
  });
  const state = emptySession({
    id: "s",
    createdAt: 1,
    updatedAt: 1,
    title: "Test",
  });
  state.requestMeters = [base, meter].map((m) => ({
    ...m,
    sessionId: "s",
    runId: "r",
  }));
  expect(aggregateSessionStats(state).cost).toMatchObject({
    pricedRequests: 1,
    providerReportedRequests: 1,
    subtotals: [{ currency: "USD", subtotal: 0.00412, requests: 1 }],
  });
  expect(providerCost("opencode-go", { cost: 0 })).toMatchObject({
    usd: 0,
    estimated: false,
  });
  expect(
    providerCost(consoleId, { cost: 0.1, opencode: { estimated: true } }),
  ).toMatchObject({ usd: 0.1, estimated: true });
  expect(
    tokenPricing("opencode-go", model, DEFAULT_ENDPOINTS["opencode-go"]),
  ).toBeUndefined();
  expect(
    finishMeter(base, { usage }, "https://example.org").providerRequestCost,
  ).toBeUndefined();
});

it("splits OpenAI inclusive input by read and both write lifetimes and applies per-request context tiers", () => {
  const usage = billingUsage("openai", {
    input_tokens: 12000,
    output_tokens: 100,
    input_tokens_details: {
      cached_tokens: 4000,
      cache_write_tokens: 7000,
      cache_write_tokens_details: {
        ttl_30m_tokens: 3000,
        ttl_12h_tokens: 4000,
      },
    },
  });
  const direct = tokenPricing("openai", model, DEFAULT_ENDPOINTS.openai);
  expect(
    tokenCost(
      { input: 100, output: 10, cachedInput: 0, cacheWriteInput: 100 },
      direct,
    ),
  ).toBeUndefined();
  expect(tokenCost(usage, direct)).toBe(
    (1000 * 10 + 4000 + 3000 * 12.5 + 4000 * 25 + 100 * 50) / 1e6,
  );
  expect(
    tokenPricing(consoleId, model, endpoint, 272000)?.cacheWritePerMillion,
  ).toBe(12.5);
  expect(
    tokenPricing(consoleId, model, endpoint, 272001)?.cacheWritePerMillion,
  ).toBe(25);
});

it("declines an estimate when a necessary counter, retention price or service-tier price is unknown", () => {
  expect(
    tokenCost(
      billingUsage(consoleId, { prompt_tokens: 20, completion_tokens: 2 }),
      price,
    ),
  ).toBeUndefined();
  expect(
    tokenCost(
      billingUsage(consoleId, {
        opencode: {
          tokens: {
            input: 2,
            output: 3,
            cache_read: 0,
            cache_write_5m: 0,
            cache_write_1h: 10,
          },
        },
      }),
      price,
    ),
  ).toBeUndefined();
  expect(
    tokenCost(
      { input: 10, output: 1, cachedInput: 8, cacheWriteInput: 5 },
      price,
    ),
  ).toBeUndefined();
  expect(
    tokenCost(
      billingUsage(
        "openai",
        {
          input_tokens: 10,
          output_tokens: 1,
          input_tokens_details: { cache_write_tokens: 0 },
        },
        "priority",
      ),
      price,
    ),
  ).toBeUndefined();
  expect(
    tokenCost(
      billingUsage("openai", {
        input_tokens: 10,
        output_tokens: 1,
        input_tokens_details: {
          cache_write_tokens: 8,
          cache_write_tokens_details: { ttl_30m_tokens: 2, ttl_12h_tokens: 5 },
        },
      }),
      price,
    ),
  ).toBeUndefined();
});

it("displays four independently priced buckets for the configured provider", () => {
  const registry = new ProviderRegistry();
  const html = renderToStaticMarkup(
    createElement(ProviderModelTable, {
      registry,
      ids: [model],
      selectedModel: model,
      view: "pricing",
      provider: consoleId,
      onConfigure: () => {},
    }),
  );
  for (const text of [
    "Input",
    "Output",
    "Cache Read",
    "Cache Write",
    "$10",
    "$50",
    "$1",
    "$12.5",
  ])
    expect(html).toContain(">" + text + "<");
});

it("prefers official prices, identifies external fallback estimates and respects account endpoint boundaries",()=>{
  expect(tokenPricing("openai",model,DEFAULT_ENDPOINTS.openai,1,{input:1})).toMatchObject({source:"openai-model-page",inputPerMillion:10,longCacheWritePerMillion:25});
  expect(tokenPricing("openai","gpt-5.5",DEFAULT_ENDPOINTS.openai)).toMatchObject({source:"opencode-fallback",inputPerMillion:5});
  expect(tokenPricing(consoleId,model,endpoint,1,{input:7})).toMatchObject({source:"opencode-mixed",inputPerMillion:7,cacheWritePerMillion:12.5});
  expect(tokenPricing("openai","gpt-5.5","https://example.test/v1/responses")).toBeUndefined();
});

it("sorts each pricing bucket numerically in both directions with missing prices last", () => {
  const ids = Object.freeze(["missing", "gpt-6-astra", "big-pickle", "gpt-6-luna"]);
  const registry = new ProviderRegistry();
  for (const column of ["input", "output", "cacheRead", "cacheWrite"] as const) {
    const sorted = (direction: "asc" | "desc") => sortedPricingRows(ids, consoleId, registry, column, direction).map(row => row.id);
    expect(sorted("asc")).toEqual(["big-pickle", "gpt-6-luna", "gpt-6-astra", "missing"]);
    expect(sorted("desc")).toEqual(["gpt-6-astra", "gpt-6-luna", "big-pickle", "missing"]);
  }
  expect(sortedPricingRows(ids, consoleId, registry, "id", "asc").map(row => row.id)).toEqual([...ids].sort());
  expect(sortedPricingRows(ids, consoleId, registry, "id", "desc").map(row => row.id)).toEqual([...ids].sort().reverse());
  const html = renderToStaticMarkup(createElement(ProviderModelTable, {
    ids: ["gpt-live-1"], registry, view: "pricing", provider: consoleId, selectedModel: "", onConfigure: () => {},
  }));
  expect(html).toContain('aria-sort="ascending"');
  const headers = html.match(/<thead\b[\s\S]*?<\/thead>/)?.[0] ?? "";
  expect(headers.replace(/<style\b[^>]*>[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, "")).toBe("ModelInputOutputCache ReadCache WriteRate Base");
  expect(headers.match(/data-testid="ArrowDropDownIcon"/g)).toHaveLength(6);
  expect(html).toContain("$0.05 / min");
  expect(html).toContain("Rate Base");
});
