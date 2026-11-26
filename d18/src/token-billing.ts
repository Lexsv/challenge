// Token prices are USD per million. Persist the rate used with each new meter.
import { resolvePrice, type Price } from "./opencode-catalog.ts";
import { DEFAULT_ENDPOINTS } from "./provider-endpoints.ts";
import type { Usage } from "./models.ts";

export type TokenPricing = {
  currency: "USD";
  inputPerMillion: number;
  outputPerMillion: number;
  cachedInputPerMillion?: number;
  cacheWritePerMillion?: number;
  longCacheWritePerMillion?: number;
  source:
    | "openai-model-page"
    | "google-pricing"
    | "opencode-discovery"
    | "opencode-mixed"
    | "opencode-catalog"
    | "opencode-fallback";
  asOf: string;
};

type Rates = [
  input: number,
  output: number,
  read: number,
  write?: number,
  longWrite?: number,
];
// Standard text rates, short context. https://developers.openai.com/api/docs/pricing
const openAI = new Map<string, Rates>([
  ["gpt-4o-mini", [0.15, 0.6, 0.075]],
  ["gpt-4o-mini-2024-07-18", [0.15, 0.6, 0.075]],
  ["gpt-5.6-terra", [2, 12, 0.2, 2.5, 5]],
  ["gpt-5.6-luna", [0.2, 1.2, 0.02, 0.25, 0.5]],
  ["gpt-6-astra", [10, 50, 1, 12.5, 25]],
  ["gpt-6.1-sol", [2, 10, 0.1, 2.5, 5]],
  ["gpt-6.1-terra", [1, 5, 0.05, 1.25, 2.5]],
]);

// Published full-request long-context tiers. https://opencode.ai/docs/console/models/
const consoleLong = new Map<string, [number, Rates]>([
  ["gpt-6-astra", [272000, [20, 75, 2, 25]]],
  ["gpt-6.1-sol", [272000, [4, 15, 0.2, 5]]],
  ["gpt-5.6-terra", [272000, [4, 18, 0.4, 5]]],
  ["gpt-6-luna", [272000, [0.2, 0.75, 0.02, 0.25]]],
  ["gpt-5.5", [272000, [10, 45, 1]]],
  ["grok-4.7", [200000, [4, 12, 1]]],
  ["claude-haiku-5-5", [100000, [0.5, 2.5, 0.05, 0.625]]],
]);

export const pricingSourceLabels: Record<TokenPricing["source"], string> = {
  "openai-model-page": "OpenAI official pricing",
  "google-pricing": "Google official pricing",
  "opencode-catalog": "OpenCode published catalog",
  "opencode-discovery": "OpenCode Models API",
  "opencode-mixed": "OpenCode Models API and published catalog",
  "opencode-fallback": "Estimated · OpenCode fallback",
};

// Standard paid text rates. Google prices cache storage separately by time.
const google = new Map<string, Rates>([
  ["gemini-2.5-flash", [0.3, 2.5, 0.03]],
  ["gemini-2.5-flash-lite", [0.1, 0.4, 0.01]],
  ["gemini-2.5-pro", [1.25, 10, 0.125]],
]);

export function tokenPricing(
  provider: string,
  model: string,
  endpoint: string | undefined,
  input = 0,
  discovered?: Partial<Price>,
): TokenPricing | undefined {
  if (
    !endpoint ||
    endpoint !== DEFAULT_ENDPOINTS[provider as keyof typeof DEFAULT_ENDPOINTS]
  )
    return;
  const rates = provider === "openai" ? openAI.get(model) : undefined;
  if (rates) {
    const [ordinary, output, read, write, longWrite] = rates;
    // OpenAI model pages specify 2x input/cache and 1.5x output above 272K on these models.
    const long = write !== undefined && input > 272000;
    return {
      currency: "USD",
      inputPerMillion: ordinary * (long ? 2 : 1),
      outputPerMillion: output * (long ? 1.5 : 1),
      cachedInputPerMillion: read * (long ? 2 : 1),
      cacheWritePerMillion:
        write === undefined ? undefined : write * (long ? 2 : 1),
      longCacheWritePerMillion:
        longWrite === undefined ? undefined : longWrite * (long ? 2 : 1),
      source: "openai-model-page",
      asOf: "2026-11-26",
    };
  }
  if (provider === "gemini" && google.has(model)) {
    const [ordinary, output, read] =
      model === "gemini-2.5-pro" && input > 200000
        ? [2.5, 15, 0.25]
        : google.get(model)!;
    return {
      currency: "USD",
      inputPerMillion: ordinary,
      outputPerMillion: output,
      cachedInputPerMillion: read,
      source: "google-pricing",
      asOf: "2026-11-26",
    };
  }
  const fallback =
    (provider === "openai" && model.startsWith("gpt-")) ||
    (provider === "gemini" && model.startsWith("gemini-"));
  if (provider !== "opencode-console" && !fallback) return;
  const entry = resolvePrice(
    model,
    provider === "opencode-console" ? discovered : undefined,
  );
  if (
    entry.unit !== "per 1M tokens" ||
    entry.input.value === null ||
    entry.output.value === null
  )
    return;
  const tier = consoleLong.get(model);
  const long = tier && input > tier[0];
  const [ordinary, output, read, write] = long
    ? tier[1]
    : [
        entry.input.value,
        entry.output.value,
        entry.cacheRead.value,
        entry.cacheWrite.value,
      ];
  const sources = [
    entry.input,
    entry.output,
    entry.cacheRead,
    entry.cacheWrite,
  ].map((p) => p.source);
  const api = !long && sources.includes("API");
  return {
    currency: "USD",
    inputPerMillion: ordinary,
    outputPerMillion: output,
    cachedInputPerMillion: read ?? undefined,
    cacheWritePerMillion: write ?? undefined,
    source: fallback
      ? "opencode-fallback"
      : api
        ? sources.includes("Catalog")
          ? "opencode-mixed"
          : "opencode-discovery"
        : "opencode-catalog",
    asOf: api ? new Date().toISOString().slice(0, 10) : entry.sourceDate!,
  };
}

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const count = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const optional = (v: unknown) => (count(v) ? v : undefined);

function normalizeUsage(provider: string, raw: unknown): Usage | undefined {
  if (!raw || typeof raw !== "object") return;
  const u = object(raw);
  const billed = object(u.opencode).tokens;
  if (
    (provider === "opencode-console" || provider === "opencode-go") &&
    billed !== undefined
  ) {
    // OpenCode billing buckets are disjoint; output already includes reasoning.
    const b = object(billed);
    const {
      input,
      output,
      cache_read: read,
      cache_write_5m: shortWrite,
      cache_write_1h: longWrite,
    } = b;
    if (
      count(input) &&
      count(output) &&
      count(read) &&
      count(shortWrite) &&
      count(longWrite) &&
      count(input + read + shortWrite + longWrite)
    )
      return {
        input: input + read + shortWrite + longWrite,
        output,
        reasoning: optional(b.reasoning),
        cachedInput: read,
        cacheWriteInput: shortWrite + longWrite,
        longCacheWriteInput: longWrite,
      };
    return {
      input: optional(u.input_tokens ?? u.prompt_tokens),
      output: optional(u.output_tokens ?? u.completion_tokens),
      billingIncomplete: true,
    };
  }
  const details = object(u.input_tokens_details ?? u.prompt_tokens_details);
  const times = object(details.cache_write_tokens_details);
  const read = details.cached_tokens,
    short = times.ttl_30m_tokens,
    long = times.ttl_12h_tokens;
  const totalWrite = details.cache_write_tokens;
  const split = short !== undefined || long !== undefined;
  const splitTotal = (optional(short) ?? 0) + (optional(long) ?? 0);
  const invalid =
    (split && (!count(short) || !count(long))) ||
    [read, short, long, totalWrite].some((v) => v !== undefined && !count(v)) ||
    (split && totalWrite !== undefined && totalWrite !== splitTotal);
  return {
    input: optional(u.input_tokens ?? u.prompt_tokens),
    output: optional(u.output_tokens ?? u.completion_tokens),
    reasoning: optional(
      object(u.output_tokens_details ?? u.completion_tokens_details)
        .reasoning_tokens,
    ),
    cachedInput: optional(read),
    cacheWriteInput: optional(totalWrite) ?? (split ? splitTotal : undefined),
    longCacheWriteInput: optional(long),
    ...(invalid && { billingIncomplete: true }),
  };
}

export function billingUsage(
  provider: string,
  raw: unknown,
  tier?: unknown,
): Usage | undefined {
  const usage = normalizeUsage(provider, raw);
  if (
    usage &&
    tier != null &&
    tier !== "default" &&
    tier !== "standard" &&
    tier !== "auto"
  )
    usage.billingIncomplete = true;
  return usage;
}

export function providerCost(provider: string, raw: unknown) {
  if (provider !== "opencode-console" && provider !== "opencode-go") return;
  const usage = object(raw),
    usd = usage.cost;
  if (typeof usd === "number" && Number.isFinite(usd) && usd >= 0)
    return {
      usd,
      source: "provider" as const,
      estimated: object(usage.opencode).estimated === true,
    };
}

export function tokenCost(
  usage?: Usage,
  price?: TokenPricing,
): number | undefined {
  if (
    !price ||
    !usage ||
    usage.billingIncomplete ||
    !count(usage.input) ||
    !count(usage.output)
  )
    return;
  const read = usage.cachedInput ?? 0,
    writes = usage.cacheWriteInput ?? 0,
    long = usage.longCacheWriteInput ?? 0;
  if (
    ![read, writes, long].every(count) ||
    read + writes > usage.input ||
    long > writes
  )
    return;
  // A missing write bucket on a write-priced model cannot establish a zero write charge.
  if (
    price.cacheWritePerMillion !== undefined &&
    price.cacheWritePerMillion !== price.inputPerMillion &&
    usage.cacheWriteInput === undefined &&
    usage.input > read
  )
    return;
  if (
    writes > 0 &&
    price.longCacheWritePerMillion !== undefined &&
    usage.longCacheWriteInput === undefined
  )
    return;
  if (
    (read && price.cachedInputPerMillion === undefined) ||
    (writes > long && price.cacheWritePerMillion === undefined) ||
    (long && price.longCacheWritePerMillion === undefined)
  )
    return;
  return (
    ((usage.input - read - writes) * price.inputPerMillion +
      usage.output * price.outputPerMillion +
      read * (price.cachedInputPerMillion ?? 0) +
      (writes - long) * (price.cacheWritePerMillion ?? 0) +
      long * (price.longCacheWritePerMillion ?? 0)) /
    1_000_000
  );
}
