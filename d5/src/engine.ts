import { requestCost } from "./request-cost";
import {
  last,
  evaluationRequested,
  resolveExpert,
  type Run,
  type Expert,
  type Settings,
  type Attempt,
} from "./models";
import { validateExpertConfiguration, type ProviderRegistry } from "./provider-registry";
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
export class ConfigurationError extends Error {}
function sanitizedConfigText(value: string, config?: Settings): string {
  let text = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/bearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/(?:sk-|ghp_|opencode-)[a-zA-Z0-9_-]{8,}/gi, "[redacted]")
    .replace(
      /(authorization|api[_-]?key|token|password|secret|credential)["']?\s*[=:]\s*["']?[^\s,;"']+/gi,
      "$1=[redacted]",
    )
    .replace(/https?:\/\/[^\s/@:]+:[^\s/@]+@/gi, "https://[redacted]@");
  for (const parameter of config?.parameters ?? []) {
    if (parameter.value.length >= 4)
      text = text.split(parameter.value).join("[redacted]");
  }
  return text.slice(0, 400);
}
export function configurationProblem(
  registry: ProviderRegistry,
  config: Settings,
  role: string,
  structured: boolean,
): string | undefined {
  if (!config.provider?.trim())
    return `${role}: provider identity is required.`;
  if (!config.model.trim())
    return `${role}: select a model configured for provider ${sanitizedConfigText(config.provider, config)}.`;
  const context = `${role} (provider ${sanitizedConfigText(config.provider, config)}, model ${sanitizedConfigText(config.model, config)})`;
  const provider = registry.get(config.provider);
  if (!provider) return `${context}: unsupported provider.`;
  let invalid: string | undefined;
  try {
    invalid = role === "Expert" ? validateExpertConfiguration(provider, config) : provider.validate(config);
  } catch {
    return `${context}: provider validation failed.`;
  }
  if (invalid) return `${context}: ${sanitizedConfigText(invalid, config)}`;
  if (
    structured &&
    provider.capabilities(config.model)?.structuredOutput !== true
  )
    return `${context}: structured output support is unknown or unsupported.`;
  return undefined;
}
export function createRun(
  question: string,
  reference: string,
  experts: Expert[],
  defaultModel: string,
  defaultProvider: string,
  registry: ProviderRegistry,
  evaluatorSettings: Settings,
  policy: "current-v1",
): Run {
  if (policy !== "current-v1")
    throw new Error("Current validation policy is required for new runs.");
  if (!question.trim()) throw new ConfigurationError("Enter a question.");
  if (!experts.length) throw new ConfigurationError("Add at least one expert.");
  if (experts.some((expert) => !expert.provider))
    throw new ConfigurationError(
      "Provider identity is required for new configurations.",
    );
  if (!evaluatorSettings.provider)
    throw new ConfigurationError("Evaluator provider identity is required.");
  const resolved = experts.map((expert) =>
    resolveExpert(expert, defaultModel, defaultProvider),
  );
  const evaluator = { ...evaluatorSettings };
  for (const expert of resolved) {
    const problem = configurationProblem(registry, expert, "Expert", false);
    if (problem) throw new ConfigurationError(problem);
  }
  const evaluatorProblem = configurationProblem(
    registry,
    evaluator,
    "Evaluator",
    true,
  );
  if (evaluatorProblem) throw new ConfigurationError(evaluatorProblem);
  const snapshot = freeze(
    structuredClone({
      validationPolicy: policy,
      providerEndpoints: Object.fromEntries([...new Set([...resolved.map((e) => e.provider!), evaluator.provider!])].flatMap((id) => {
        const endpoint = registry.endpointFor(id);
        return endpoint ? [[id, endpoint]] : [];
      })),
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
export type CredentialSource = (provider: string) => string;
export class Engine {
  active = false;
  constructor(
    private notify: () => void,
    private registry: ProviderRegistry,
  ) {}
  private async attempt(
    key: CredentialSource,
    settings: Settings,
    instructions: string,
    input: string,
    schema?: object,
    policy?: "current-v1" | "historical-openai-v0",
    recordedEndpoints?: Readonly<Record<string, string>>,
  ): Promise<Attempt> {
    try {
      const provider = settings.provider;
      if (!provider)
        return {
          id: crypto.randomUUID(),
          status: "failed",
          text: "",
          ms: 0,
          error: "Provider missing in run configuration.",
        };
      const providerAdapter = this.registry.get(provider);
      const selectedAdapter = providerAdapter?.execute;
      if (!selectedAdapter)
        return {
          id: crypto.randomUUID(),
          status: "failed",
          text: "",
          ms: 0,
          error: "Unsupported provider. Check expert settings.",
        };
      const currentEndpoint = this.registry.endpointFor(provider);
      const expectedEndpoint = recordedEndpoints?.[provider] ?? this.registry.originalEndpointFor(provider);
      if (currentEndpoint && expectedEndpoint && currentEndpoint !== expectedEndpoint)
        return { id: crypto.randomUUID(), status: "failed", text: "", ms: 0, error: "The provider endpoint changed since this run. Restore its recorded endpoint before retrying." };
      if (!policy)
        return {
          id: crypto.randomUUID(),
          status: "failed",
          text: "",
          ms: 0,
          error:
            "Run validation policy is missing. Import historical runs before retrying.",
        };
      const validate =
        policy === "historical-openai-v0"
          ? (providerAdapter!.validateHistorical ?? providerAdapter!.validate)
          : schema ? providerAdapter!.validate : (config: Settings) => validateExpertConfiguration(providerAdapter!, config);
      if (!validate)
        return {
          id: crypto.randomUUID(),
          status: "failed",
          text: "",
          ms: 0,
          error: "Historical provider validation is unavailable.",
        };
      const invalid = validate(settings);
      const structured =
        schema &&
        providerAdapter!.capabilities(settings.model)?.structuredOutput !==
          true;
      if (invalid || structured)
        return {
          id: crypto.randomUUID(),
          status: "failed",
          text: "",
          ms: 0,
          error: invalid
            ? sanitizedConfigText(invalid, settings)
            : "Structured output support is unknown or unsupported.",
        };
      const currentKey = key(provider);
      if (!currentKey.trim())
        return {
          id: crypto.randomUUID(),
          status: "failed",
          text: "",
          ms: 0,
          error: "API key missing. Open connection settings before retrying.",
        };
      const outcome = await selectedAdapter(currentKey, { settings, instructions, input, schema });
      const attempt: Attempt = { id: crypto.randomUUID(), ...outcome };
      const cost = requestCost(attempt, provider);
      if (cost) attempt.cost = cost;
      return attempt;
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
      undefined,
      run.snapshot.validationPolicy,
      run.snapshot.providerEndpoints,
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
      run.snapshot.validationPolicy,
      run.snapshot.providerEndpoints,
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
    if (this.active || run.busy) return;
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
