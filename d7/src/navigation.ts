import type { ProviderRegistry } from "./provider-registry";
import type { Settings } from "./models";
export type LabTab = "lab" | "settings";
export function initialLabTab(
  key: string,
  config: Settings,
  registry: ProviderRegistry,
): LabTab {
  if (!key.trim() || !config.provider) return "settings";
  const provider = registry.get(config.provider);
  return provider &&
    !provider.validate(config) &&
    provider.capabilities(config.model)?.structuredOutput === true
    ? "lab"
    : "settings";
}
