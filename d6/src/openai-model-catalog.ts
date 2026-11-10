// Capabilities checked against official OpenAI model pages on 2026-11-04.
export type ModelCapabilities = {
  structuredOutput: boolean;
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
    reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
    defaultReasoning: "low",
    verificationReasoning: "none",
    verificationTokens: 128,
  },
  "gpt-5.6-luna": {
    structuredOutput: true,
    maxOutputTokens: 128000,
    reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
    defaultReasoning: "low",
    verificationReasoning: "none",
    verificationTokens: 128,
  },
  "gpt-6.1-terra": {
    structuredOutput: true,
    maxOutputTokens: 128000,
    reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
    defaultReasoning: "medium",
    verificationReasoning: "none",
    verificationTokens: 128,
  },
  "gpt-6.1-sol": {
    structuredOutput: true,
    maxOutputTokens: 128000,
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
