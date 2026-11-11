import type { Attempt, Expert, Result, Run } from "./models";

/** Group only identical captured expert configurations and actual model identities. */
export function comparisonGroupKey(run: Run, result: Result, attempt: Attempt | undefined, expert: Expert | undefined): string {
  if (!expert) return JSON.stringify(["missing-snapshot", run.id, result.id]);
  return JSON.stringify([
    expert.id, expert.name, expert.roleLabel, expert.description, expert.rolePrompt,
    expert.provider, expert.model, expert.maxTokens, expert.reasoning,
    expert.parameters?.map(({ key, value, enabled }) => [key, value, enabled]),
    attempt?.actualModel || expert.model, run.snapshot.validationPolicy,
    expert.provider ? run.snapshot.providerEndpoints?.[expert.provider] : undefined,
  ]);
}
