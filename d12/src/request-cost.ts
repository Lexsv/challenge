import { catalog } from "./opencode-catalog";
import type { Attempt, Run } from "./models";

export type RequestCost = { usd: number; source: "provider" | "catalog"; estimated: boolean; catalogDate?: string };
const valid = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;

/** Calculate only when the actual model and both token rates are available. */
export function requestCost(attempt: Attempt | undefined, provider?: string): RequestCost | undefined {
  if (!attempt) return undefined;
  if (attempt.cost && valid(attempt.cost.usd)) return attempt.cost;
  if (provider !== "opencode-console" || attempt.status !== "succeeded" || !attempt.actualModel) return undefined;
  const model = catalog.find((item) => item.id === attempt.actualModel);
  const usage = attempt.usage;
  if (!model || model.unit !== "per 1M tokens" || !valid(model.price.input) || !valid(model.price.output) || !valid(usage?.input) || !valid(usage?.output)) return undefined;
  const cached = usage.cachedInput;
  if (cached !== undefined && (!valid(cached) || cached > usage.input || !valid(model.price.cacheRead))) return undefined;
  const input = usage.input - (cached ?? 0);
  const usd = (input * model.price.input + usage.output * model.price.output + (cached ?? 0) * (model.price.cacheRead ?? 0)) / 1_000_000;
  return { usd, source: "catalog", estimated: true, catalogDate: model.date };
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
