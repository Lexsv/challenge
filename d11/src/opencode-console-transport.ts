/// <reference types="vite/client" />
/** Vite development proxy; exact official inference URLs only. */
export const CONSOLE_PROXY_PREFIX = "/__d5_opencode_console";
export function consoleTransportUrl(endpoint: string, useProxy = import.meta.env.DEV && typeof window !== "undefined"): string {
  if (!useProxy) return endpoint;
  if (endpoint === "https://opencode.ai/inference/v1/models") return `${CONSOLE_PROXY_PREFIX}/models`;
  if (endpoint === "https://opencode.ai/inference/openai/v1/chat/completions") return `${CONSOLE_PROXY_PREFIX}/chat/completions`;
  if (endpoint === "https://opencode.ai/inference/openai/v1/responses") return `${CONSOLE_PROXY_PREFIX}/responses`;
  return endpoint;
}
