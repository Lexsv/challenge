import { validateEndpoint } from "./provider-endpoints";
import { catalog, type DiscoveredModel } from "./opencode-catalog";
import { consoleTransportUrl } from "./opencode-console-transport";

// Exact model IDs and native API families from OpenCode's Console model table.
// https://opencode.ai/docs/console/models
const responses = new Set(["gpt-6-astra", "gpt-6.1-sol", "gpt-6-luna", "gpt-5.6-terra", "gpt-5.5", "gpt-5.5-pro", "gpt-5.4-mini", "gpt-5.4-nano", "gpt-5.3-codex", "gpt-5.3-codex-spark", "grok-4.7", "grok-build-0.1", "muse-wonder-1.0", "crouton-alpha-free"]);
const chat = new Set(["beam-free", "big-pickle", "deepseek-v4-pro", "deepseek-v4.1-flash", "deepseek-v4.1-flash-free", "flint-40b-free", "glm-5.3", "glm-5.3-flash", "glm-5.3-flash-free", "kimi-k2.7-code", "kimi-k3", "minimax-m3", "mistral-large-4", "mimo-v2.6-flash-free", "nemotron-3.5-lightning-free", "nemotron-3.5-super-vl-free"]);
export type ConsoleVerificationPlan = { model: string; endpoint: string; protocol: "responses" | "chat"; protectedAuthentication: boolean };

export function consoleVerificationPlan(model: string, configuredEndpoint: string): ConsoleVerificationPlan | undefined {
  if (!model || validateEndpoint("opencode-console", configuredEndpoint)) return undefined;
  const protocol = responses.has(model) ? "responses" : chat.has(model) ? "chat" : undefined;
  if (!protocol) return undefined;
  const path = protocol === "responses" ? "/inference/openai/v1/responses" : "/inference/openai/v1/chat/completions";
  const entry = catalog.find((item) => item.id === model);
  const protectedAuthentication = new URL(configuredEndpoint).origin === "https://opencode.ai" && !!entry && entry.unit === "per 1M tokens" && entry.price.input !== null && entry.price.input > 0 && entry.price.output !== null && entry.price.output > 0;
  return { model, protocol, endpoint: new URL(path, configuredEndpoint).href, protectedAuthentication };
}

/** Filter only known restrictions; an untested paid model remains selectable. */
export function consoleModelSelectable(id: string, metadata?: Pick<DiscoveredModel, "disabled" | "available" | "price">): boolean {
  if (metadata?.disabled === true || metadata?.available === false || id.endsWith("-free")) return false;
  const bundled = catalog.find((entry) => entry.id === id);
  const input = metadata?.price?.input ?? bundled?.price.input;
  const output = metadata?.price?.output ?? bundled?.price.output;
  if (input === 0 && output === 0) return false;
  return !!consoleVerificationPlan(id, "https://opencode.ai/inference/openai/v1/chat/completions");
}

/** Free Console models are restricted to the OpenCode client. Unknown eligibility is skipped. */
export function selectConsoleVerificationPlan(models: readonly DiscoveredModel[], endpoint: string): ConsoleVerificationPlan | undefined {
  for (const model of models) {
    if (!consoleModelSelectable(model.id, model)) continue;
    const bundled = catalog.find((entry) => entry.id === model.id);
    const input = model.price?.input ?? bundled?.price.input;
    const output = model.price?.output ?? bundled?.price.output;
    if (model.id.endsWith("-free") || input == null || output == null || input <= 0 || output <= 0) continue;
    const plan = consoleVerificationPlan(model.id, endpoint);
    if (plan) return plan;
  }
  return undefined;
}

export async function verifyConsoleModel(key: string, plan: ConsoleVerificationPlan, fetcher: typeof fetch = fetch): Promise<string> {
  if (!key.trim()) return "Authentication: not checked. Enter an API key.";
  const body = plan.protocol === "responses"
    ? { model: plan.model, input: "Reply with OK." }
    : { model: plan.model, messages: [{ role: "user", content: "Reply with OK." }] };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetcher(consoleTransportUrl(plan.endpoint), { method: "POST", redirect: "error", credentials: "omit", signal: controller.signal, headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` }, body: JSON.stringify(body) });
    if (response.status === 401) return "Authentication failed (401). Check the key privately. Model: not verified.";
    if (response.status === 403) return "Authentication: not established. Model access or permission denied (403).";
    if (response.status === 400 || response.status === 422) return `Authentication: not established. Model request rejected (${response.status}); check model and request compatibility.`;
    if (!response.ok) return `Authentication: inconclusive. Model request failed (${response.status}).`;
    let complete = false;
    try {
      const data: unknown = await response.json();
      if (data && typeof data === "object") {
        const result = data as { status?: unknown; output?: unknown; choices?: unknown; model?: unknown };
        const hasResponseText = Array.isArray(result.output) && result.output.some((item: { content?: unknown }) => Array.isArray(item?.content) && item.content.some((part: { type?: unknown; text?: unknown }) => part?.type === "output_text" && typeof part.text === "string" && !!part.text.trim()));
        const hasChatText = Array.isArray(result.choices) && result.choices.some((choice: { message?: { content?: unknown } }) => typeof choice?.message?.content === "string" && !!choice.message.content.trim());
        complete = result.model === plan.model && (plan.protocol === "responses" ? result.status === "completed" && hasResponseText : hasChatText);
      }
    } catch { /* A successful HTTP response does not guarantee a usable model result. */ }
    const authentication = plan.protectedAuthentication ? "Authentication verified for this operation." : "Authentication: inconclusive; this endpoint or model may not require a credential.";
    return complete
      ? `${authentication} Model verified: ${plan.model}. Endpoint: ${plan.endpoint}. Other models are not verified.`
      : `${authentication} Model result inconclusive: ${plan.model}. Endpoint: ${plan.endpoint}.`;
  } catch {
    return "Authentication: inconclusive. The model request could not be completed; check the network and try again manually.";
  } finally { clearTimeout(timer); }
}
