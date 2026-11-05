import {
  capabilities,
  resolveExpert,
  validSettings,
  type Expert,
} from "./models";
import { validateParameters } from "./api-parameters";

// Match the existing Save and execution validation while explaining any blocker.
export function expertSettingsError(
  expert: Expert,
  defaultModel: string,
): string | undefined {
  if (!expert.name.trim()) return "Enter an expert name.";
  if (!expert.description.trim()) return "Enter an expert description.";
  if (!expert.rolePrompt.trim()) return "Enter a role prompt.";
  const resolved = resolveExpert(expert, defaultModel);
  if (!resolved.model.trim()) return "Select a model.";
  const parameterError = validateParameters(resolved.parameters ?? []);
  if (parameterError) return parameterError;
  const capability = capabilities(resolved.model);
  if (
    resolved.reasoning &&
    !capability?.reasoningEfforts.includes(resolved.reasoning)
  )
    return "Choose a reasoning level supported by the selected model.";
  if (!validSettings(resolved))
    return `Check max_output_tokens: the limit for this model is ${capability?.maxOutputTokens ?? 4096}.`;
  return undefined;
}
