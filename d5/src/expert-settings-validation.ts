import { resolveExpert, type Expert } from "./models";
import { validateParameters } from "./api-parameters";
import type { ProviderRegistry } from "./provider-registry";

export function expertSettingsError(
  expert: Expert,
  defaultModel: string,
  registry?: ProviderRegistry,
  defaultProvider?: string,
): string | undefined {
  if (!expert.name.trim()) return "Enter an expert name.";
  if (!expert.description.trim()) return "Enter an expert description.";
  if (!expert.rolePrompt.trim()) return "Enter a role prompt.";
  if (!registry) return "Provider registry is required.";
  if (!expert.provider) return "Provider identity is required.";
  const resolved = resolveExpert(expert, defaultModel, defaultProvider);
  if (!resolved.model.trim()) return "Select a model.";
  const error = validateParameters(resolved.parameters ?? []);
  if (error) return error;
  if (!resolved.provider) return "Provider identity is required.";
  const provider = registry.get(resolved.provider);
  if (!provider) return "Unsupported provider.";
  if (!provider.capabilities(resolved.model)) {
    if (provider.allowUndiscoveredSelection && provider.catalog().includes(resolved.model)) return undefined;
    return "Model capabilities are unknown.";
  }
  if (provider.executionAvailable === false && provider.catalog().includes(resolved.model)) return undefined;
  return provider.validate(resolved);
}
