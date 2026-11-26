import { tokenCost, tokenPricing } from "./token-billing.ts";
import { DEFAULT_ENDPOINTS } from "./provider-endpoints.ts";
import type { Attempt, Run } from "./models";

export type RequestCost = { usd: number; source: "provider" | "catalog"; estimated: boolean; catalogDate?: string };
const valid = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;

/** Calculate only when the actual model and both token rates are available. */
export function requestCost(attempt: Attempt | undefined, provider?: string, discovered?: import("./opencode-catalog").DiscoveredModel["price"]): RequestCost | undefined {
  if (!attempt) return undefined;
  if (attempt.cost && valid(attempt.cost.usd)) return attempt.cost;
  if (!provider || attempt.status === "running" || !attempt.actualModel) return undefined;
  const price = tokenPricing(provider, attempt.actualModel, DEFAULT_ENDPOINTS[provider as keyof typeof DEFAULT_ENDPOINTS], attempt.usage?.input,discovered);
  const usd = tokenCost(attempt.usage, price);
  return usd !== undefined && price ? { usd, source: "catalog", estimated: true, catalogDate: price.asOf } : undefined;
}
export function formatCost(cost: number): string {
  if (cost > 0 && cost < 0.000000001) return `$${cost.toExponential(4)}`;
  if (cost > 0 && cost < 0.000001) return `$${cost.toFixed(10).replace(/0+$/, "")}`;
  return `$${cost.toFixed(6)}`;
}
export function experimentCost(run: Run) {
  const entries = [
    ...run.results.flatMap(result => result.attempts.map((attempt, index) => ({ attempt, provider: result.expert.provider, name: `${result.expert.name} (attempt ${index + 1})` }))),
    ...run.evaluations.map((attempt, index) => ({ attempt, provider: run.snapshot.evaluator.provider, name: `Evaluator (attempt ${index + 1})` })),
  ];
  const known = entries.map((entry) => ({ ...entry, cost: requestCost(entry.attempt, entry.provider) }));
  return { amount: known.reduce((sum, entry) => sum + (entry.cost?.usd ?? 0), 0), known: known.filter((entry) => !!entry.cost).length, missing: known.filter((entry) => !entry.cost).map((entry) => entry.name), estimated: known.some((entry) => entry.cost?.estimated) };
}
