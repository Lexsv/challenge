import type { ExecutionParameters } from "./execution-parameters";
import type { ApiParameter } from "./api-parameters";
export type Settings = {
  provider?: string;
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
// Resolve only the explicit model identity; provider policy lives at the boundary.
export const resolveExpert = (
  expert: Expert,
  defaultModel: string,
  defaultProvider?: string,
): Expert => ({
  ...expert,
  model:
    expert.model ||
    (expert.provider && expert.provider === defaultProvider
      ? defaultModel
      : ""),
});
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
    validationPolicy?: "current-v1" | "historical-openai-v0";
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
