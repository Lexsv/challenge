import {
  last,
  evaluationRequested,
  capabilities,
  settings,
  resolveExpert,
  validSettings,
  type Run,
  type Expert,
  type Settings,
  type Attempt,
} from "./models";
import { respond, type Adapter } from "./openai";
import {
  evaluationSchema,
  validateEvaluation,
  evaluatorInstructions,
} from "./evaluation";
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    Object.values(value).forEach(freeze);
  }
  return value;
}
export function createRun(
  question: string,
  reference: string,
  experts: Expert[],
  defaultModel: string,
): Run {
  const resolved = experts.map((expert) => resolveExpert(expert, defaultModel));
  const evaluator = settings(defaultModel);
  if (
    !question.trim() ||
    !resolved.length ||
    resolved.some((e) => !validSettings(e)) ||
    !capabilities(defaultModel)?.structuredOutput
  )
    throw new Error(
      "Complete the question, team, and supported shared model configuration.",
    );
  const snapshot = freeze(
    structuredClone({
      question,
      reference,
      evaluationRequested: !!reference.trim(),
      experts: resolved,
      evaluator,
    }),
  );
  return {
    id: crypto.randomUUID(),
    snapshot,
    results: snapshot.experts.map((expert) => ({
      id: crypto.randomUUID(),
      expert,
      attempts: [],
    })),
    evaluations: [],
    evaluationStatus: reference.trim() ? "pending" : "not_evaluated",
    started: Date.now(),
    busy: false,
  };
}
type CredentialSource = string | (() => string);
const resolveKey = (source: CredentialSource) =>
  typeof source === "function" ? source() : source;
export class Engine {
  active = false;
  constructor(
    private notify: () => void,
    private adapter: Adapter = respond,
  ) {}
  private async attempt(
    key: CredentialSource,
    settings: Settings,
    instructions: string,
    input: string,
    schema?: object,
  ): Promise<Attempt> {
    try {
      const currentKey = resolveKey(key);
      if (!currentKey.trim())
        return {
          id: crypto.randomUUID(),
          status: "failed",
          text: "",
          ms: 0,
          error: "API key missing. Open connection settings before retrying.",
        };
      return {
        id: crypto.randomUUID(),
        ...(await this.adapter(currentKey, {
          settings,
          instructions,
          input,
          schema,
        })),
      };
    } catch {
      return {
        id: crypto.randomUUID(),
        status: "failed",
        text: "",
        error: "Operation failed. Check configuration before retrying.",
        ms: 0,
      };
    }
  }
  private async participant(run: Run, index: number, key: CredentialSource) {
    const r = run.results[index];
    const pending: Attempt = {
      id: crypto.randomUUID(),
      status: "running",
      text: "",
      ms: 0,
    };
    r.attempts.push(pending);
    this.notify();
    const a = await this.attempt(
      key,
      r.expert,
      r.expert.rolePrompt,
      run.snapshot.question,
    );
    Object.assign(pending, { ...a, id: pending.id });
    this.notify();
  }
  private async evaluate(run: Run, key: CredentialSource) {
    if (!evaluationRequested(run)) {
      run.evaluationStatus = "not_evaluated";
      this.notify();
      return;
    }
    const answers = run.results
      .filter((r) => last(r.attempts)?.status === "succeeded")
      .map((r) => ({ resultId: r.id, answer: last(r.attempts)!.text }));
    if (!answers.length) {
      run.evaluationStatus = "skipped";
      this.notify();
      return;
    }
    run.evaluationStatus = "running";
    const pending: Attempt = {
      id: crypto.randomUUID(),
      status: "running",
      text: "",
      ms: 0,
    };
    run.evaluations.push(pending);
    this.notify();
    const a = await this.attempt(
      key,
      run.snapshot.evaluator,
      evaluatorInstructions,
      JSON.stringify({
        question: run.snapshot.question,
        referenceAnswer: run.snapshot.reference,
        answers,
      }),
      evaluationSchema,
    );
    Object.assign(pending, { ...a, id: pending.id });
    if (a.status === "succeeded") {
      try {
        run.evaluations.at(-1)!.judgments = validateEvaluation(
          a.text,
          answers.map((v) => v.resultId),
        );
        run.evaluationStatus = "completed";
      } catch {
        pending.status = "failed";
        pending.error =
          "Invalid structured evaluation: missing, duplicate, unknown, or malformed result IDs.";
        run.evaluationStatus = "failed";
      }
    } else run.evaluationStatus = "failed";
    this.notify();
  }
  async execute(
    run: Run,
    key: CredentialSource,
    retryIndex?: number,
    evaluationOnly = false,
  ) {
    if (this.active || run.busy || !resolveKey(key).trim()) return;
    if (
      retryIndex !== undefined &&
      (!run.results[retryIndex] ||
        last(run.results[retryIndex].attempts)?.status === "succeeded")
    )
      return;
    this.active = true;
    run.busy = true;
    run.ended = undefined;
    try {
      if (evaluationOnly) await this.evaluate(run, key);
      else if (retryIndex !== undefined) {
        const previousStatus = run.evaluationStatus;
        if (evaluationRequested(run)) run.evaluationStatus = "stale";
        this.notify();
        await this.participant(run, retryIndex, key);
        if (last(run.results[retryIndex].attempts)?.status === "succeeded")
          await this.evaluate(run, key);
        else {
          run.evaluationStatus = previousStatus;
          this.notify();
        }
      } else {
        let next = 0;
        await Promise.all(
          Array.from({ length: Math.min(3, run.results.length) }, async () => {
            while (next < run.results.length) {
              const index = next++;
              await this.participant(run, index, key);
            }
          }),
        );
        await this.evaluate(run, key);
      }
    } finally {
      run.busy = false;
      run.ended = Date.now();
      this.active = false;
      this.notify();
    }
  }
}
