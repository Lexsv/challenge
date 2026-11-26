import { Tiktoken, getEncodingNameForModel, type TiktokenModel } from 'js-tiktoken/lite';
import { billingUsage, providerCost, tokenCost, tokenPricing, type TokenPricing } from './token-billing.ts';
import { DEFAULT_ENDPOINTS } from './provider-endpoints.ts';
export { tokenPricing, type TokenPricing } from './token-billing.ts';
export type RequestMeter = {
  id: string; provider: string; model: string; actualModel?: string;
  requestKind?: 'answer' | 'summary' | 'extraction';
  sentInputTokens?: number;
  beforeInputTokens?: number;
  afterInputTokens?: number;
  compacted?: boolean;
  library: 'js-tiktoken'; startedAt: number; endedAt?: number;
  status: 'running' | 'completed' | 'failed' | 'incomplete';
  encoding?: 'o200k_base' | 'cl100k_base'; estimatedInputTokens?: number;
  actualInputTokens?: number; actualOutputTokens?: number; actualTotalTokens?: number; cachedInputTokens?: number; cacheWriteTokens?: number; longCacheWriteTokens?: number;
  providerRequestCost?: number; providerCostEstimated?: boolean;
  pricing?: TokenPricing; actualPricing?: TokenPricing; estimatedInputCost?: number; estimatedRequestCost?: number;
};
export type ModelRequestMeter = RequestMeter & { sessionId: string; runId: string; toolExecutionOffset?: number };
type CatalogPrices = (model:string) => import("./opencode-catalog.ts").DiscoveredModel["price"];
const encoders = new Map<string, Promise<Tiktoken>>();
const valid = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const tokens = (value: unknown): number | undefined => valid(value) && Number.isSafeInteger(value) ? value : undefined;

// Newer, exact model IDs from the local catalogs covered by OpenAI's official gpt-5 encoding rule.
// Verified 2026-11-10: https://github.com/openai/tiktoken/blob/main/tiktoken/model.py
const verifiedNewerModels = new Set(['gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.5-pro', 'gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-5.3-codex', 'gpt-5.3-codex-spark']);
export function verifiedEncoding(model: string): RequestMeter['encoding'] {
  try {
    const name = getEncodingNameForModel(model as TiktokenModel);
    return name === 'o200k_base' || name === 'cl100k_base' ? name : undefined;
  } catch { return verifiedNewerModels.has(model) ? 'o200k_base' : undefined; }
}
async function encoder(name: NonNullable<RequestMeter['encoding']>): Promise<Tiktoken> {
  if (!encoders.has(name)) encoders.set(name, (async () => {
    const ranks = name === 'o200k_base' ? await import('js-tiktoken/ranks/o200k_base') : await import('js-tiktoken/ranks/cl100k_base');
    return new Tiktoken(ranks.default);
  })());
  return encoders.get(name)!;
}

// Context planning may use a clearly labelled fallback; billed usage is never inferred.
// This is also the default encoding for the app's current OpenAI model family.
export const DEFAULT_CONTEXT_ENCODING = 'o200k_base' as const;
export async function estimateContextInput(model: string, body: unknown): Promise<{
  estimatedInputTokens?: number; encoding?: RequestMeter['encoding']; estimateApproximate?: boolean;
}> {
  const specific = verifiedEncoding(model);
  const candidates = [...new Set([specific, DEFAULT_CONTEXT_ENCODING].filter(Boolean))] as NonNullable<RequestMeter['encoding']>[];
  for (const encoding of candidates) {
    try {
      return { estimatedInputTokens: (await encoder(encoding)).encode(JSON.stringify(body), [], []).length,
        encoding, estimateApproximate: encoding !== specific };
    } catch { /* Try the local default if model-specific ranks are unavailable. */ }
  }
  return {};
}
// Count the complete outgoing JSON input, including role framing, instructions, history, and tool schemas.
// This is a local estimate: the provider may apply different internal framing/token accounting.
export async function beginMeter(provider: string, model: string, body: unknown, endpoint: string, prices?:CatalogPrices): Promise<RequestMeter> {
  const meter: RequestMeter = { id: crypto.randomUUID(), provider, model, library: 'js-tiktoken', startedAt: Date.now(), status: 'running' };
  const encoding = verifiedEncoding(model);
  if (encoding) {
    try {
      meter.estimatedInputTokens = (await encoder(encoding)).encode(JSON.stringify(body), [], []).length;
      meter.encoding = encoding;
    } catch { /* A missing encoding/rank file must not prevent the provider request. */ }
  }
  meter.pricing = tokenPricing(provider, model, endpoint, meter.estimatedInputTokens, prices?.(model));
  if (meter.pricing && meter.estimatedInputTokens !== undefined) meter.estimatedInputCost = meter.estimatedInputTokens * meter.pricing.inputPerMillion / 1_000_000;
  return meter;
}
export function finishMeter(meter: RequestMeter, response: unknown, endpoint: string, prices?:CatalogPrices): RequestMeter {
  const result: RequestMeter = { ...meter, endedAt: Date.now(), status: 'completed' };
  const payload = response as { model?: unknown; service_tier?: unknown; usage?: Record<string, unknown> } | null;
  if (typeof payload?.model === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(payload.model)) result.actualModel = payload.model;
  const usage = payload?.usage;
  const billed = billingUsage(result.provider, usage, payload?.service_tier);
  result.actualInputTokens = billed?.input;
  result.actualOutputTokens = billed?.output;
  result.actualTotalTokens = billed?.input !== undefined && billed.output !== undefined
    ? tokens(billed.input + billed.output) : tokens(usage?.total_tokens);
  result.cachedInputTokens = billed?.cachedInput;
  result.cacheWriteTokens = billed?.cacheWriteInput;
  result.longCacheWriteTokens = billed?.longCacheWriteInput;
  result.actualPricing = tokenPricing(result.provider, result.actualModel ?? result.model, endpoint, billed?.input,prices?.(result.actualModel ?? result.model));
  result.estimatedRequestCost = tokenCost(billed, result.actualPricing);
  const cost = endpoint === DEFAULT_ENDPOINTS[result.provider as keyof typeof DEFAULT_ENDPOINTS]
    ? providerCost(result.provider, usage) : undefined;
  if (cost) {
    result.providerRequestCost = cost.usd;
    result.providerCostEstimated = cost.estimated;
  }
  return result;
}
