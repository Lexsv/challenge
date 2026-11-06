import type { Expert, Settings } from "./models";

export function generationModelFor(
  provider: string,
  openAIModel: string,
  generation: Settings | undefined,
): string {
  return provider === "openai" ? openAIModel : (generation?.model ?? "");
}

export function expertEditDraft(expert: Expert): Expert {
  return structuredClone(expert);
}

export function retryCredentialReason(
  provider: string | undefined,
  credential: (id: string) => string,
): string | undefined {
  if (!provider?.trim())
    return "The captured provider is unavailable. This result cannot be retried.";
  if (!credential(provider).trim())
    return `Add the API key for provider ${provider} in Settings before retrying.`;
  return undefined;
}
