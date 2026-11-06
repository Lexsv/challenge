// Explicit compatibility behavior for existing OpenAI configurations.
import { capabilities, known } from "./openai-model-catalog";
import {
  validateParameters,
  parseParameterValue,
  type ApiParameter,
} from "./api-parameters";
import type { Settings, Expert } from "./models";
export {
  capabilities,
  known,
  catalog,
  modelCatalog,
} from "./openai-model-catalog";
export function initialParameters(maxTokens: number): ApiParameter[] {
  return [
    {
      id: crypto.randomUUID(),
      enabled: true,
      key: "max_output_tokens",
      value: String(maxTokens),
    },
    { id: crypto.randomUUID(), enabled: false, key: "temperature", value: "0" },
  ];
}
const openAIReserved = new Set([
  "model",
  "store",
  "instructions",
  "input",
  "reasoning",
  "text",
]);
export function validateOpenAIParameters(
  parameters: ApiParameter[],
): string | undefined {
  const error = validateParameters(parameters);
  if (error) return error;
  for (const row of parameters) {
    if (!row.enabled) continue;
    if (openAIReserved.has(row.key))
      return `The '${row.key}' field is managed by the application.`;
    if (row.key === "max_output_tokens") {
      const value = parseParameterValue(row.value);
      if (!Number.isInteger(value) || (value as number) < 16)
        return "max_output_tokens must be an integer of at least 16.";
    }
  }
  return undefined;
}
export const settings = (model: string): Settings => ({
  provider: "openai",
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
export const resolveLegacyExpert = (
  expert: Expert,
  defaultModel: string,
): Expert => {
  const model = expert.model || defaultModel;
  return {
    ...expert,
    parameters: expert.parameters ?? initialParameters(expert.maxTokens),
    model,
    reasoning:
      expert.provider && expert.provider !== "openai"
        ? expert.reasoning
        : known(model)
          ? (expert.reasoning ?? capabilities(model)?.defaultReasoning)
          : undefined,
  };
};
export function validSettings(s: Settings) {
  const capability = capabilities(s.model);
  return (
    !!s.model.trim() &&
    (!s.parameters || !validateOpenAIParameters(s.parameters)) &&
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

export { resolveLegacyExpert as resolveExpert };

/** Unknown manually enabled parameters may be forwarded; they are not confirmed supported. */
export function validateNewOpenAISettings(s: Settings): string | undefined {
  if (!capabilities(s.model))
    return "OpenAI model capabilities are unknown. Select a confirmed model.";
  const error = s.parameters
    ? validateOpenAIParameters(s.parameters)
    : undefined;
  if (error) return error;
  if (!validSettings(s)) return "Invalid OpenAI model settings.";
  const support = capabilities(s.model)?.parameterSupport;
  for (const row of s.parameters ?? []) {
    if (row.enabled && support?.[row.key] === false)
      return `Parameter is unsupported by this OpenAI model: ${row.key}.`;
  }
  return undefined;
}
