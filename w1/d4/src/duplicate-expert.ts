import type { Expert } from "./models";

export function duplicateExpert(experts: Expert[], sourceId: string): Expert[] {
  const index = experts.findIndex((expert) => expert.id === sourceId);
  if (index < 0) return experts;
  const source = experts[index];
  const names = new Set(experts.map((expert) => expert.name));
  let suffix = 1;
  let name = `${source.name} (copy)`;
  while (names.has(name)) name = `${source.name} (copy ${++suffix})`;
  // Copy only the expert definition; request state and historical results never belong here.
  const copy: Expert = structuredClone({
    id: crypto.randomUUID(),
    name,
    roleLabel: source.roleLabel,
    description: source.description,
    rolePrompt: source.rolePrompt,
    model: source.model,
    reasoning: source.reasoning,
    maxTokens: source.maxTokens,
    parameters: source.parameters,
  });
  return [...experts.slice(0, index + 1), copy, ...experts.slice(index + 1)];
}
