import type { ExecutionParameters } from "./execution-parameters";
import {
  initialParameters,
  validateParameters,
  type ApiParameter,
} from "./api-parameters";
// Capabilities checked against official OpenAI model pages on 2026-11-04.
export type ModelCapabilities = {
  structuredOutput: boolean;
  maxOutputTokens: number;
  reasoningEfforts: readonly string[];
  defaultReasoning?: string;
  verificationReasoning?: string;
  verificationTokens: number;
};
export const modelCatalog: Record<string, ModelCapabilities> = {
  "gpt-5.6-terra": {
    structuredOutput: true,
    maxOutputTokens: 128000,
    reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
    defaultReasoning: "low",
    verificationReasoning: "none",
    verificationTokens: 128,
  },
  "gpt-5.6-luna": {
    structuredOutput: true,
    maxOutputTokens: 128000,
    reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
    defaultReasoning: "low",
    verificationReasoning: "none",
    verificationTokens: 128,
  },
  "gpt-6.1-terra": {
    structuredOutput: true,
    maxOutputTokens: 128000,
    reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
    defaultReasoning: "medium",
    verificationReasoning: "none",
    verificationTokens: 128,
  },
  "gpt-6.1-sol": {
    structuredOutput: true,
    maxOutputTokens: 128000,
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    defaultReasoning: "medium",
    verificationReasoning: "low",
    verificationTokens: 2048,
  },
};
export const catalog = Object.keys(modelCatalog).filter(
  (id) => modelCatalog[id].structuredOutput,
);
export const capabilities = (model: string): ModelCapabilities | undefined =>
  Object.hasOwn(modelCatalog, model) ? modelCatalog[model] : undefined;
export const known = (model: string) => capabilities(model) !== undefined;
export type Settings = {
  model: string;
  maxTokens: number;
  reasoning?: string;
  parameters?: ApiParameter[];
};
export type Expert = Settings & {
  id: string;
  name: string;
  roleLabel?: string;
  description: string;
  rolePrompt: string;
};
export const settings = (model: string): Settings => ({
  model,
  maxTokens: model && !known(model) ? 4096 : 8192,
  ...(capabilities(model)?.defaultReasoning
    ? { reasoning: capabilities(model)!.defaultReasoning }
    : {}),
});
export const verificationSettings = (model: string): Settings => ({
  model,
  maxTokens: capabilities(model)?.verificationTokens ?? 128,
  ...(capabilities(model)?.verificationReasoning
    ? { reasoning: capabilities(model)!.verificationReasoning }
    : {}),
});
export const resolveExpert = (expert: Expert, defaultModel: string): Expert => {
  const model = expert.model || defaultModel;
  return {
    ...expert,
    parameters: expert.parameters ?? initialParameters(expert.maxTokens),
    model,
    reasoning: known(model)
      ? (expert.reasoning ?? capabilities(model)?.defaultReasoning)
      : undefined,
  };
};
export function validSettings(s: Settings) {
  const capability = capabilities(s.model);
  return (
    !!s.model.trim() &&
    (!s.parameters || !validateParameters(s.parameters)) &&
    (s.parameters
      ? s.parameters
          .filter((p) => p.enabled && p.key === "max_output_tokens")
          .every(
            (p) => Number(p.value) <= (capability?.maxOutputTokens ?? 4096),
          )
      : Number.isInteger(s.maxTokens) &&
        s.maxTokens >= 16 &&
        s.maxTokens <= (capability?.maxOutputTokens ?? 4096)) &&
    (!s.reasoning || !!capability?.reasoningEfforts.includes(s.reasoning))
  );
}
export type Usage = { input?: number; output?: number; reasoning?: number };
export type IncompleteReason =
  "max_output_tokens" | "content_filter" | "max_messages" | "steered";
export type Attempt = {
  id: string;
  executionParameters?: ExecutionParameters;
  actualModel?: string;
  status: "running" | "succeeded" | "failed" | "timed-out" | "incomplete";
  text: string;
  error?: string;
  incompleteReason?: IncompleteReason;
  usage?: Usage;
  ms: number;
  manual?: Verdict;
};
export type Verdict = "correct" | "incorrect" | "unable_to_assess";
export type Judgment = {
  resultId: string;
  verdict: Verdict;
  explanation: string;
};
export type Result = { id: string; expert: Expert; attempts: Attempt[] };
export type EvaluationAttempt = Attempt & { judgments?: Judgment[] };
export type Run = {
  id: string;
  snapshot: Readonly<{
    question: string;
    reference: string;
    evaluationRequested?: boolean;
    experts: Expert[];
    evaluator: Settings;
  }>;
  results: Result[];
  evaluations: EvaluationAttempt[];
  evaluationStatus:
    | "pending"
    | "running"
    | "completed"
    | "failed"
    | "skipped"
    | "stale"
    | "not_evaluated";
  started: number;
  ended?: number;
  busy: boolean;
};
export const evaluationRequested = (run: Run) =>
  run.snapshot.evaluationRequested ?? !!run.snapshot.reference.trim();
export const last = <T>(items: T[]) => items.at(-1);
export function totals(attempts: Attempt[]) {
  const sum = (field: "input" | "output") => {
    const values = attempts.flatMap((a) =>
      a.usage?.[field] === undefined ? [] : [a.usage[field]!],
    );
    return values.length
      ? values.reduce((total, value) => total + value, 0)
      : undefined;
  };
  return {
    input: sum("input"),
    output: sum("output"),
    partial: attempts.some(
      (a) => a.usage?.input === undefined || a.usage?.output === undefined,
    ),
  };
}
