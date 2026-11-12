import { Tiktoken, getEncodingNameForModel, type TiktokenModel } from 'js-tiktoken/lite';
import { catalog } from './opencode-catalog';
import { DEFAULT_ENDPOINTS } from './provider-endpoints';

export type TokenPricing = {
  currency: 'USD'; inputPerMillion: number; outputPerMillion: number; cachedInputPerMillion?: number;
  source: 'openai-model-page' | 'opencode-catalog'; asOf: string;
};
export type RequestMeter = {
  id: string; provider: string; model: string; actualModel?: string;
  requestKind?: 'answer' | 'summary';
  sentInputTokens?: number;
  beforeInputTokens?: number;
  afterInputTokens?: number;
  compacted?: boolean;
  library: 'js-tiktoken'; startedAt: number; endedAt?: number;
  status: 'running' | 'completed' | 'failed' | 'incomplete';
  encoding?: 'o200k_base' | 'cl100k_base'; estimatedInputTokens?: number;
  actualInputTokens?: number; actualOutputTokens?: number; actualTotalTokens?: number; cachedInputTokens?: number;
  pricing?: TokenPricing; actualPricing?: TokenPricing; estimatedInputCost?: number; estimatedRequestCost?: number;
};
export type ModelRequestMeter = RequestMeter & { sessionId: string; runId: string; toolExecutionOffset?: number };
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
export function tokenPricing(provider: string, model: string, endpoint: string): TokenPricing | undefined {
  if (endpoint !== DEFAULT_ENDPOINTS[provider as keyof typeof DEFAULT_ENDPOINTS]) return undefined;
  if (provider === 'openai' && ['gpt-4o-mini', 'gpt-4o-mini-2024-07-18'].includes(model)) return {
    currency: 'USD', inputPerMillion: 0.15, outputPerMillion: 0.60, cachedInputPerMillion: 0.075,
    source: 'openai-model-page', asOf: '2026-11-10',
  }; // https://developers.openai.com/api/docs/models/gpt-4o-mini (standard text rates)
  if (provider !== 'opencode-console') return undefined;
  const entry = catalog.find((item) => item.id === model);
  if (!entry || entry.unit !== 'per 1M tokens' || !valid(entry.price.input) || !valid(entry.price.output)) return undefined;
  return { currency: 'USD', inputPerMillion: entry.price.input, outputPerMillion: entry.price.output,
    ...(valid(entry.price.cacheRead) ? { cachedInputPerMillion: entry.price.cacheRead } : {}), source: 'opencode-catalog', asOf: entry.date };
}

// Count the complete outgoing JSON input, including role framing, instructions, history, and tool schemas.
// This is a local estimate: the provider may apply different internal framing/token accounting.
export async function beginMeter(provider: string, model: string, body: unknown, endpoint: string): Promise<RequestMeter> {
  const meter: RequestMeter = { id: crypto.randomUUID(), provider, model, library: 'js-tiktoken', startedAt: Date.now(), status: 'running' };
  const encoding = verifiedEncoding(model);
  if (encoding) {
    try {
      meter.estimatedInputTokens = (await encoder(encoding)).encode(JSON.stringify(body), [], []).length;
      meter.encoding = encoding;
    } catch { /* A missing encoding/rank file must not prevent the provider request. */ }
  }
  meter.pricing = tokenPricing(provider, model, endpoint);
  if (meter.pricing && meter.estimatedInputTokens !== undefined) meter.estimatedInputCost = meter.estimatedInputTokens * meter.pricing.inputPerMillion / 1_000_000;
  return meter;
}
export function finishMeter(meter: RequestMeter, response: unknown, endpoint: string): RequestMeter {
  const result: RequestMeter = { ...meter, endedAt: Date.now(), status: 'completed' };
  const payload = response as { model?: unknown; usage?: Record<string, unknown> } | null;
  if (typeof payload?.model === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(payload.model)) result.actualModel = payload.model;
  const usage = payload?.usage;
  result.actualInputTokens = tokens(usage?.input_tokens ?? usage?.prompt_tokens);
  result.actualOutputTokens = tokens(usage?.output_tokens ?? usage?.completion_tokens);
  result.actualTotalTokens = tokens(usage?.total_tokens);
  const details = (usage?.input_tokens_details ?? usage?.prompt_tokens_details) as { cached_tokens?: unknown } | undefined;
  result.cachedInputTokens = tokens(details?.cached_tokens);
  // An unknown/different actual model must not inherit the requested model's rates.
  result.actualPricing = tokenPricing(result.provider, result.actualModel ?? result.model, endpoint);
  delete result.estimatedRequestCost;
  if (result.actualPricing && result.actualInputTokens !== undefined && result.actualOutputTokens !== undefined) {
    const cached = result.cachedInputTokens ?? 0;
    if (cached <= result.actualInputTokens && (!cached || result.actualPricing.cachedInputPerMillion !== undefined)) {
      result.estimatedRequestCost = ((result.actualInputTokens - cached) * result.actualPricing.inputPerMillion
        + cached * (result.actualPricing.cachedInputPerMillion ?? 0) + result.actualOutputTokens * result.actualPricing.outputPerMillion) / 1_000_000;
    }
  }
  return result;
}
