import { consoleTransportUrl } from "./opencode-console-transport";
// Supplied Console price snapshot. Prices do not establish account or Go eligibility.
export type ModelTier = "Free" | "Paid" | "Premium" | "Unknown";
export type Price = {
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
};
export type CatalogEntry = {
  name: string;
  id: string;
  price: Price;
  unit: "per 1M tokens" | "per minute";
  date: string;
};
const rows: [
  string,
  string,
  number | null,
  number | null,
  number | null,
  number | null,
][] = [
  ["Beam", "beam-free", 0, 0, 0, null],
  ["Big Pickle", "big-pickle", 0, 0, 0, 0],
  ["Claude Fable 5.1", "claude-fable-5-1", 10, 50, 0.25, 12.5],
  ["Claude Haiku 5.5", "claude-haiku-5-5", 0.1, 0.5, 0.01, 0.125],
  ["Claude Opus 5.5", "claude-opus-5-5", 4, 20, 0.2, 5],
  ["Claude Sonnet 5.5", "claude-sonnet-5-5", 2, 10, 0.2, 2.5],
  ["Crouton Alpha", "crouton-alpha-free", 0, 0, 0, null],
  ["DeepSeek V4 Pro", "deepseek-v4-pro", 1.74, 3.48, 0.145, null],
  ["DeepSeek V4.1 Flash", "deepseek-v4.1-flash", 0.3, 1.2, 0.006, null],
  ["DeepSeek V4.1 Flash Free", "deepseek-v4.1-flash-free", 0, 0, 0, null],
  ["Flint 40B", "flint-40b-free", 0, 0, 0, null],
  ["Gemini 3.1 Pro Preview", "gemini-3.1-pro", 2, 12, 0.2, null],
  ["Gemini 3.5 Flash Lite", "gemini-3.5-flash-lite", 0.3, 2.5, 0.03, null],
  ["Gemini 3.8 Flash", "gemini-3.8-flash", 1.5, 7.5, 0.15, null],
  ["Gemini 4 Argon", "gemini-4-argon", 2, 10, 0.1, null],
  ["GLM-5.3", "glm-5.3", 1.4, 4.4, 0.26, null],
  ["GLM-5.3-Flash", "glm-5.3-flash", 0.15, 0.5, 0.03, null],
  ["GLM-5.3-Flash Free", "glm-5.3-flash-free", 0, 0, 0, null],
  ["GPT-5.3 Codex", "gpt-5.3-codex", 1.75, 14, 0.175, null],
  ["GPT-5.3 Codex Spark", "gpt-5.3-codex-spark", 1.75, 14, 0.175, null],
  ["GPT-5.4 Mini", "gpt-5.4-mini", 0.75, 4.5, 0.075, null],
  ["GPT-5.4 Nano", "gpt-5.4-nano", 0.2, 1.25, 0.02, null],
  ["GPT-5.5", "gpt-5.5", 5, 30, 0.5, null],
  ["GPT-5.5 Pro", "gpt-5.5-pro", 30, 180, 30, null],
  ["GPT-5.6 Terra", "gpt-5.6-terra", 2, 12, 0.2, 2.5],
  ["GPT-6 Astra", "gpt-6-astra", 10, 50, 1, 12.5],
  ["GPT-6 Luna", "gpt-6-luna", 0.1, 0.5, 0.01, 0.125],
  ["GPT-6.1 Sol", "gpt-6.1-sol", 2, 10, 0.1, 2.5],
  ["Grok 4.7", "grok-4.7", 2, 6, 0.5, null],
  ["Grok Build 0.1", "grok-build-0.1", 1, 2, 0.2, null],
  ["Jev 1.13", "jev-1.13", 0.042, 0, null, null],
  ["Jev 1.13 Free", "jev-1.13-free", 0, 0, null, null],
  ["Kimi K2.7 Code", "kimi-k2.7-code", 0.95, 4, 0.19, null],
  ["Kimi K3", "kimi-k3", 3, 15, 0.3, 3],
  ["MiMo-V2.6-Flash Free", "mimo-v2.6-flash-free", 0, 0, 0, null],
  ["MiniMax-M3", "minimax-m3", 0.3, 1.2, 0.06, null],
  ["Mistral Large 4", "mistral-large-4", 0.68, 2.09, 0.07, null],
  ["Muse Wonder", "muse-wonder-1.0", 4, 20, 0.2, null],
  ["Nemotron 3.5 Lightning", "nemotron-3.5-lightning-free", 0, 0, 0, null],
  ["Nemotron 3.5 Super VL", "nemotron-3.5-super-vl-free", 0, 0, 0, null],
  ["Pulse Alpha", "pulse-alpha-free", 0, 0, 0, null],
  ["Qwen3.8 Flash", "qwen3.8-flash", 0.15, 0.47, 0.016, 0.2],
];
export const catalog: CatalogEntry[] = rows.map(
  ([name, id, input, output, cacheRead, cacheWrite]) => ({
    name,
    id,
    price: { input, output, cacheRead, cacheWrite },
    unit: "per 1M tokens",
    date: "2026-11-06",
  }),
);
catalog.push({
  name: "GPT-Live 1",
  id: "gpt-live-1",
  price: { input: 0.05, output: null, cacheRead: null, cacheWrite: null },
  unit: "per minute",
  date: "2026-11-06",
});
export function tier(
  id: string,
  price?: Price,
  explicit?: ModelTier,
): ModelTier {
  if (explicit && explicit !== "Unknown") return explicit;
  if (id.endsWith("-free")) return "Free";
  if (!price) return "Unknown";
  const values = [price.input, price.output].filter(
    (v): v is number => v !== null,
  );
  return values.some((v) => v > 0)
    ? "Paid"
    : values.length === 2 && values.every((v) => v === 0)
      ? "Free"
      : "Unknown";
}
export function resolvePrice(id: string, api?: Partial<Price>) {
  const fallback = catalog.find((m) => m.id === id);
  const valid = (v: unknown): v is number =>
    typeof v === "number" && Number.isFinite(v) && v >= 0;
  const components = ["input", "output", "cacheRead", "cacheWrite"] as const;
  const unit = fallback?.unit ?? "per 1M tokens";
  const values = components.map((field) => {
    const apiValue = unit === "per 1M tokens" ? api?.[field] : undefined;
    if (valid(apiValue)) return { value: apiValue, source: "API" as const };
    const catalogValue = fallback?.price[field];
    if (valid(catalogValue))
      return { value: catalogValue, source: "Catalog" as const };
    return { value: null, source: "Unknown" as const };
  });
  return {
    provider: "opencode",
    model: id,
    currency: "USD",
    unit,
    sourceDate: fallback?.date,
    input: values[0],
    output: values[1],
    cacheRead: values[2],
    cacheWrite: values[3],
  };
}

export type DiscoveredModel = {
  id: string;
  name: string;
  disabled?: boolean;
  available?: boolean;
  price?: Partial<Price>;
  structuredOutput?: boolean;
  maxOutputTokens?: number;
  contextWindow?: number;
  parameterSupport?: Record<string, boolean>;
};
const validPrice = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0;
export function parseModels(value: unknown): DiscoveredModel[] {
  if (
    !value ||
    typeof value !== "object" ||
    !("data" in value) ||
    !Array.isArray(value.data)
  )
    return [];
  return value.data.flatMap((item: unknown) => {
    if (!item || typeof item !== "object") return [];
    const obj = item as Record<string, any>;
    if (typeof obj.id !== "string" || !obj.id) return [];
    const input = obj.cost?.text?.input;
    const output = obj.cost?.text?.output;
    const price: Partial<Price> = {};
    const maxOutputTokens = obj.limit?.output;
    const contextWindow = obj.limit?.context;
    const parameterSupport: Record<string, boolean> = {};
    for (const name of [
      "temperature",
      "top_p",
      "top_k",
      "max_completion_tokens",
    ]) {
      if (typeof obj.capabilities?.[name] === "boolean")
        parameterSupport[name] = obj.capabilities[name];
    }
    if (validPrice(input?.price)) price.input = input.price;
    if (validPrice(output?.price)) price.output = output.price;
    if (validPrice(input?.cache?.read)) price.cacheRead = input.cache.read;
    if (validPrice(input?.cache?.write)) price.cacheWrite = input.cache.write;
    return [
      {
        id: obj.id,
        name: typeof obj.name === "string" ? obj.name : obj.id,
        ...(typeof obj.disabled === "boolean" ? { disabled: obj.disabled } : {}),
        ...(typeof obj.available === "boolean" ? { available: obj.available } : {}),
        ...(Object.keys(price).length ? { price } : {}),
        ...(Number.isSafeInteger(contextWindow) && contextWindow > 0 ? { contextWindow } : {}),
        ...(Number.isInteger(maxOutputTokens) && maxOutputTokens > 0
          ? { maxOutputTokens }
          : {}),
        ...(Object.keys(parameterSupport).length ? { parameterSupport } : {}),
        ...(typeof obj.capabilities?.structured_output === "boolean"
          ? { structuredOutput: obj.capabilities.structured_output }
          : {}),
      },
    ];
  });
}
export const MODEL_ENDPOINTS = {
  console: "https://opencode.ai/inference/v1/models",
  go: "https://opencode.ai/inference/go/v1/models",
} as const;
export async function discoverModels(
  mode: keyof typeof MODEL_ENDPOINTS,
  fetcher: typeof fetch = fetch,
  endpoint: string = MODEL_ENDPOINTS[mode],
): Promise<DiscoveredModel[]> {
  const response = await fetcher(mode === "console" ? consoleTransportUrl(endpoint) : endpoint, {
    credentials: "omit",
    redirect: "error",
  });
  if (!response.ok)
    throw new Error(`Model discovery failed (${response.status}).`);
  return parseModels(await response.json());
}
