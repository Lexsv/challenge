import type { ManagerConversationState } from "./manager-agent";
import type { ProviderRegistry } from "./provider-registry";

export type SessionModelPair = {
  provider: "openai" | "opencode-console";
  model: string;
  notice?: string;
};

/** Request insertion order is retained when later usage snapshots update a request. */
export function restoreSessionModelPair(
  state: ManagerConversationState,
  registry: ProviderRegistry,
  defaultModel: string,
): SessionModelPair {
  const last = state.requestMeters
    ?.filter((meter) => meter.sessionId === state.conversation.id)
    .at(-1);
  if (!last) return { provider: "openai", model: defaultModel };
  if (
    (last.provider === "openai" || last.provider === "opencode-console") &&
    registry.modelOptionsFor(last.provider).includes(last.model)
  )
    return { provider: last.provider, model: last.model };
  const options = registry.modelOptionsFor("openai");
  const fallback: SessionModelPair = options.length
    ? {
        provider: "openai",
        model: options.includes(defaultModel) ? defaultModel : options[0],
      }
    : {
        provider: "opencode-console",
        model: registry.modelOptionsFor("opencode-console")[0] ?? "",
      };
  return {
    ...fallback,
    notice: `Saved provider/model ${last.provider} · ${last.model} is unavailable. ${fallback.model ? `Using ${fallback.provider === "openai" ? "OpenAI" : "OpenCode Console"} · ${fallback.model}. Review chat settings before sending.` : "Select an available provider and model before sending."}`,
  };
}
