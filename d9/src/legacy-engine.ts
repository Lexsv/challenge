// OpenAI compatibility is isolated at the application composition boundary.
import {
  createRun as createProviderRun,
  ConfigurationError,
  Engine as ProviderEngine,
  type CredentialSource,
} from "./engine";
import {
  createProviderRegistry,
  type ProviderRegistry,
} from "./provider-registry";
import { respond } from "./openai";
import type { Adapter } from "./provider-contract";
import { type Expert, type Settings, type Run } from "./models";
import { settings } from "./openai-model-compat";
export function createRun(
  question: string,
  reference: string,
  experts: Expert[],
  defaultModel: string,
  defaultProvider = "openai",
  registry = createProviderRegistry(),
  evaluatorSettings?: Settings,
  batchTask?: Readonly<{ id: string; version: number }>,
) {
  if (experts.some((expert) => !expert.provider))
    throw new ConfigurationError(
      "Provider identity is required for new configurations.",
    );
  if (reference.trim() && !evaluatorSettings && defaultProvider !== "openai")
    throw new ConfigurationError(
      "Evaluator configuration is required for this provider; no provider-scoped defaults are configured.",
    );
  if (reference.trim() && !evaluatorSettings && !defaultModel.trim())
    throw new ConfigurationError("Select a model for the evaluator.");
  return createProviderRun(
    question,
    reference,
    experts,
    defaultModel,
    defaultProvider,
    registry,
    evaluatorSettings ?? {
      ...settings(defaultModel),
      provider: defaultProvider,
    },
    "current-v1",
    batchTask,
  );
}
export class Engine extends ProviderEngine {
  constructor(
    notify: () => void,
    adapter: Adapter = respond,
    overrides: Record<string, Adapter> = {},
    registry: ProviderRegistry = createProviderRegistry(adapter, overrides),
  ) {
    super(notify, registry);
  }
  execute(
    run: Run,
    key: string | CredentialSource,
    retryIndex?: number,
    evaluationOnly = false,
  ) {
    const resolve =
      typeof key === "string"
        ? (provider: string) => (provider === "openai" ? key : "")
        : key;
    return super.execute(run, resolve, retryIndex, evaluationOnly);
  }
}

// Call only at an explicit historical import boundary; current runs must not enter here.
export function importHistoricalOpenAIRun(source: Run): Run {
  if (source.snapshot.validationPolicy !== undefined)
    throw new Error("Run already has a validation policy.");
  if (
    source.snapshot.experts.some(
      (e) => e.provider && e.provider !== "openai",
    ) ||
    (source.snapshot.evaluator.provider &&
      source.snapshot.evaluator.provider !== "openai")
  )
    throw new Error("Historical OpenAI import cannot accept another provider.");
  const run = structuredClone(source);
  run.snapshot.experts.forEach((e) => {
    e.provider = "openai";
  });
  run.snapshot.evaluator.provider = "openai";
  (
    run.snapshot as { validationPolicy?: "historical-openai-v0" }
  ).validationPolicy = "historical-openai-v0";
  const freeze = (value: unknown): void => {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
  };
  freeze(run.snapshot);
  run.results.forEach((result, index) => {
    result.expert = run.snapshot.experts[index] ?? result.expert;
  });
  return run;
}
