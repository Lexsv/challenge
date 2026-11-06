import { type Settings } from "./models";
import {
  validSettings,
  initialParameters,
  validateNewOpenAISettings,
} from "./openai-model-compat";
import { capabilities, catalog as openAICatalog } from "./openai-model-catalog";
import { respond } from "./openai";
import type { Adapter } from "./provider-contract";
import { validateParameters, type ApiParameter } from "./api-parameters";
import { openCodeAdapter } from "./opencode-adapter";
import {
  catalog,
  discoverModels,
  type DiscoveredModel,
} from "./opencode-catalog";

export type ParameterSupport = "supported" | "unsupported" | "unknown";
export function parameterSupport(
  metadata: Readonly<Record<string, boolean>> | undefined,
  key: string,
): ParameterSupport {
  return metadata?.[key] === true
    ? "supported"
    : metadata?.[key] === false
      ? "unsupported"
      : "unknown";
}
export type ProviderModelCapabilities = {
  structuredOutput: boolean;
  reasoningEfforts?: readonly string[];
  defaultReasoning?: string;
  maxOutputTokens: number;
  supportedParameters: Readonly<Record<string, boolean>>;
};
export type ProviderAdapter = {
  id: string;
  catalog: () => readonly string[];
  discover?: () => Promise<readonly DiscoveredModel[]>;
  capabilities: (model: string) => ProviderModelCapabilities | undefined;
  validate: (settings: Settings) => string | undefined;
  validateHistorical?: (settings: Settings) => string | undefined;
  initialParameters?: (model: string, maxTokens: number) => ApiParameter[];
  execute: Adapter;
};
export class ProviderRegistry {
  private readonly providers = new Map<string, ProviderAdapter>();
  constructor(providers: readonly ProviderAdapter[] = []) {
    providers.forEach((provider) => this.register(provider));
  }
  register(provider: ProviderAdapter) {
    if (this.providers.has(provider.id))
      throw new Error("Provider already registered.");
    this.providers.set(provider.id, provider);
  }
  get(id: string) {
    return this.providers.get(id);
  }
  modelOptionsFor(providerId: string | undefined): readonly string[] {
    const provider = providerId ? this.providers.get(providerId) : undefined;
    return provider
      ? provider.catalog().filter((model) => !!provider.capabilities(model))
      : [];
  }
  initialParametersFor(
    providerId: string | undefined,
    modelId: string,
    maxTokens: number,
  ): ApiParameter[] {
    const provider = providerId ? this.providers.get(providerId) : undefined;
    return provider?.initialParameters?.(modelId, maxTokens) ?? [];
  }
  capabilitiesFor(providerId: string | undefined, modelId: string) {
    return providerId
      ? this.providers.get(providerId)?.capabilities(modelId)
      : undefined;
  }
}
export function createProviderRegistry(
  openAI: Adapter = respond,
  overrides: Record<string, Adapter> = {},
) {
  const registry = new ProviderRegistry();
  registry.register({
    id: "openai",
    catalog: () => openAICatalog,
    capabilities: (model) => {
      const c = capabilities(model);
      return c
        ? {
            structuredOutput: c.structuredOutput,
            reasoningEfforts: c.reasoningEfforts,
            defaultReasoning: c.defaultReasoning,
            maxOutputTokens: c.maxOutputTokens,
            supportedParameters: c.parameterSupport ?? {},
          }
        : undefined;
    },
    initialParameters: (model, maxTokens) =>
      capabilities(model) ? initialParameters(maxTokens) : [],
    validate: validateNewOpenAISettings,
    validateHistorical: (config) =>
      validSettings(config) ? undefined : "Invalid historical OpenAI settings.",
    execute: openAI,
  });
  for (const mode of ["console", "go"] as const) {
    const id = `opencode-${mode}`;
    const discovered = new Map<string, DiscoveredModel>();
    registry.register({
      id,
      catalog: () => catalog.map((model) => model.id),
      discover: async () => {
        const models = await discoverModels(mode);
        models.forEach((model) => discovered.set(model.id, model));
        return models;
      },
      capabilities: (model) => {
        const data = discovered.get(model);
        if (
          !data ||
          data.structuredOutput === undefined ||
          data.maxOutputTokens === undefined
        )
          return undefined;
        return {
          structuredOutput: data.structuredOutput,
          maxOutputTokens: data.maxOutputTokens,
          supportedParameters: data.parameterSupport ?? {},
        };
      },
      validate: (config) => {
        const data = discovered.get(config.model);
        if (!data || data.maxOutputTokens === undefined)
          return "OpenCode model capabilities are unknown. Discover the model before execution.";
        const invalid = validateParameters(config.parameters ?? []);
        if (invalid) return invalid;
        if (config.reasoning)
          return "OpenCode reasoning support is unknown for this model.";
        const outputSupport = parameterSupport(
          data.parameterSupport,
          "max_completion_tokens",
        );
        if (outputSupport === "unsupported")
          return "The model does not support the OpenCode output limit.";
        if (
          !Number.isInteger(config.maxTokens) ||
          config.maxTokens < 16 ||
          config.maxTokens > data.maxOutputTokens
        )
          return "Output limit is unsupported for this model.";
        for (const parameter of config.parameters ?? []) {
          if (!parameter.enabled) continue;
          if (
            [
              "model",
              "messages",
              "response_format",
              "max_completion_tokens",
            ].includes(parameter.key)
          )
            return `The '${parameter.key}' field is managed by OpenCode.`;
          if (parameter.key === "max_output_tokens") {
            const value = Number(parameter.value);
            if (
              !Number.isInteger(value) ||
              value < 16 ||
              value > data.maxOutputTokens
            )
              return "Output limit is unsupported for this model.";
          } else {
            const support = parameterSupport(
              data.parameterSupport,
              parameter.key,
            );
            if (support === "unsupported")
              return `Parameter is unsupported by this model: ${parameter.key}.`;
          }
        }
        return undefined;
      },
      execute: overrides[id] ?? openCodeAdapter(mode),
    });
  }
  return registry;
}
