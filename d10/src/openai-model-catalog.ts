// Capabilities checked against official OpenAI model pages on 2026-11-04.
export type ModelCapabilities = {
  structuredOutput: boolean;
  contextWindow?: number;
  maxInputTokens?: number;
  maxOutputTokens: number;
  reasoningEfforts: readonly string[];
  parameterSupport?: Readonly<Record<string, boolean>>;
  defaultReasoning?: string;
  verificationReasoning?: string;
  verificationTokens: number;
};
export const modelCatalog: Record<string, ModelCapabilities> = {
  "gpt-5.6-terra": {
    structuredOutput: true,
    maxOutputTokens: 128000,
    contextWindow: 1050000,
    maxInputTokens: 922000,
    reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
    defaultReasoning: "low",
    verificationReasoning: "none",
    verificationTokens: 128,
  },
  "gpt-5.6-luna": {
    structuredOutput: true,
    maxOutputTokens: 128000,
    contextWindow: 1050000,
    maxInputTokens: 922000,
    reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
    defaultReasoning: "low",
    verificationReasoning: "none",
    verificationTokens: 128,
  },
  "gpt-6.1-terra": {
    structuredOutput: true,
    maxOutputTokens: 128000,
    contextWindow: 1050000,
    maxInputTokens: 922000,
    reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
    defaultReasoning: "medium",
    verificationReasoning: "none",
    verificationTokens: 128,
  },
  "gpt-6.1-sol": {
    structuredOutput: true,
    maxOutputTokens: 128000,
    contextWindow: 1050000,
    maxInputTokens: 922000,
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    defaultReasoning: "medium",
    verificationReasoning: "low",
    verificationTokens: 2048,
  },
};
export const catalog = Object.keys(modelCatalog).filter(
  (id) => modelCatalog[id].structuredOutput,
);
export const capabilities = (model: string): ModelCapabilities | undefined =>
  Object.hasOwn(modelCatalog, model) ? modelCatalog[model] : undefined;
export const known = (model: string) => capabilities(model) !== undefined;

// Verified 2026-11-10 against https://developers.openai.com/api/docs/models/<model>.
// Exact IDs only; never infer a new model's limits from its name.
export function openAIContextLimits(model: string): { contextWindow: number; maxOutputTokens: number; maxInputTokens?: number } | undefined {
  const c = capabilities(model);
  if (c?.contextWindow) return { contextWindow: c.contextWindow, maxOutputTokens: c.maxOutputTokens, maxInputTokens: c.maxInputTokens };
  if (['gpt-4o', 'gpt-4o-mini', 'gpt-4o-mini-2024-07-18', 'gpt-4o-2024-08-06', 'gpt-4o-2024-11-20'].includes(model)) return { contextWindow: 128000, maxOutputTokens: 16384 };
  if (['gpt-4.1', 'gpt-4.1-2025-04-14'].includes(model)) return { contextWindow: 1047576, maxOutputTokens: 32768 };
  return undefined;
}
