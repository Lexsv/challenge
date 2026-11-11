import { type Settings } from "./models";
import {
  validSettings,
  initialParameters,
  validateNewOpenAISettings,
} from "./openai-model-compat";
import { capabilities, catalog as openAICatalog } from "./openai-model-catalog";
import { respond, respondAtEndpoint } from "./openai";
import { DEFAULT_ENDPOINTS, discoveryEndpoint, validateEndpoint, type BuiltinEndpointId } from "./provider-endpoints";
import type { Adapter } from "./provider-contract";
import { validateParameters, type ApiParameter } from "./api-parameters";
import { consoleModelSelectable } from "./opencode-console-verification";
import { openCodeAdapter } from "./opencode-adapter";
import {
  catalog,
  discoverModels,
  type DiscoveredModel,
} from "./opencode-catalog";

// Documented Go IDs that are also present in the existing bundled catalog.
// https://opencode.ai/docs/console/go/
const goModelIds = new Set(["grok-4.7", "gpt-6-luna", "claude-haiku-5-5", "gemini-4-argon", "glm-5.3-flash", "glm-5.3", "kimi-k3", "kimi-k2.7-code", "deepseek-v4.1-flash", "deepseek-v4-pro", "minimax-m3", "qwen3.8-flash", "crouton-alpha-free", "beam-free"]);

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
  contextWindow?: number;
  supportedParameters: Readonly<Record<string, boolean>>;
};
export type ProviderAdapter = {
  id: string;
  allowUndiscoveredSelection?: boolean;
  executionAvailable?: boolean;
  catalog: () => readonly string[];
  discover?: () => Promise<readonly DiscoveredModel[]>;
  capabilities: (model: string) => ProviderModelCapabilities | undefined;
  limits?: (model: string) => { contextWindow?: number; maxOutputTokens?: number; maxInputTokens?: number } | undefined;
  validate: (settings: Settings) => string | undefined;
  validateHistorical?: (settings: Settings) => string | undefined;
  initialParameters?: (model: string, maxTokens: number) => ApiParameter[];
  execute: Adapter;
  onEndpointChanged?: () => void;
};
/** Expert rows are experiments: validate their structure, not model support. */
export function validateExpertConfiguration(provider: ProviderAdapter, config: Settings): string | undefined {
  const error = validateParameters(config.parameters ?? []);
  if (error) return error;
  return provider.validate({ ...config, parameters: undefined });
}
export class ProviderRegistry {
  private readonly providers = new Map<string, ProviderAdapter>();
  private readonly endpoints: Record<BuiltinEndpointId, string> = { ...DEFAULT_ENDPOINTS };
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
  endpointFor(id: string): string | undefined {
    return Object.hasOwn(this.endpoints, id) ? this.endpoints[id as BuiltinEndpointId] : undefined;
  }
  originalEndpointFor(id: string): string | undefined {
    return Object.hasOwn(DEFAULT_ENDPOINTS, id) ? DEFAULT_ENDPOINTS[id as BuiltinEndpointId] : undefined;
  }
  setEndpoint(id: BuiltinEndpointId, endpoint: string, confirmed = false): void {
    const problem = validateEndpoint(id, endpoint);
    if (problem) throw new Error(problem);
    if (endpoint !== DEFAULT_ENDPOINTS[id] && !confirmed) throw new Error("Confirm the custom endpoint before applying it.");
    if (this.endpoints[id] !== endpoint) {
      this.endpoints[id] = endpoint;
      this.get(id)?.onEndpointChanged?.();
    }
  }
  modelOptionsFor(providerId: string | undefined): readonly string[] {
    const provider = providerId ? this.providers.get(providerId) : undefined;
    return provider
      ? provider.catalog().filter((model) => provider.allowUndiscoveredSelection || !!provider.capabilities(model))
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
    execute: openAI === respond ? (key, request) => respondAtEndpoint(key, request, registry.endpointFor("openai")!) : openAI,
  });
  for (const mode of ["console", "go"] as const) {
    const id: "opencode-console" | "opencode-go" = `opencode-${mode}`;
    const discovered = new Map<string, DiscoveredModel>();
    let endpointVersion = 0;
    registry.register({
      id,
      allowUndiscoveredSelection: true,
      limits: (model) => discovered.get(model),
      catalog: () => mode === "console" ? Array.from(new Set([...catalog.map((model) => model.id), ...discovered.keys()])).filter((model) => consoleModelSelectable(model, discovered.get(model))) : Array.from(new Set([...catalog.map((model) => model.id).filter((model) => goModelIds.has(model)), ...discovered.keys()])),
      discover: async () => {
        const version = endpointVersion;
        const models = await discoverModels(mode, fetch, discoveryEndpoint(id, registry.endpointFor(id)!));
        if (version !== endpointVersion) throw new Error("Endpoint changed during model discovery.");
        discovered.clear();
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
      onEndpointChanged: () => { endpointVersion++; discovered.clear(); },
      execute: overrides[id] ?? openCodeAdapter(mode, fetch, () => registry.endpointFor(id)!),
    });
  }
  const geminiModels = ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.5-pro"];
  registry.register({
    id: "gemini",
    executionAvailable: false,
    catalog: () => geminiModels,
    // Google Gemini API model documentation: structured output and 65,536 output tokens.
    capabilities: (model) => geminiModels.includes(model)
      ? { structuredOutput: true, maxOutputTokens: 65536, supportedParameters: {} }
      : undefined,
    validate: () => "Gemini execution is not available yet.",
    execute: async () => ({ status: "failed", text: "", ms: 0, error: "Gemini execution is not available yet." }),
  });
  return registry;
}
