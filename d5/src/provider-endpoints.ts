export type BuiltinEndpointId = "openai" | "opencode-console" | "opencode-go" | "gemini";
export const DEFAULT_ENDPOINTS: Record<BuiltinEndpointId, string> = {
  openai: "https://api.openai.com/v1/responses",
  "opencode-console": "https://opencode.ai/inference/openai/v1/chat/completions",
  "opencode-go": "https://opencode.ai/inference/go/openai/v1/chat/completions",
  gemini: "https://generativelanguage.googleapis.com/v1beta/models",
};

export function validateEndpoint(id: BuiltinEndpointId, endpoint: string): string | undefined {
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || /[?#]/.test(endpoint) || endpoint.trim() !== endpoint)
      return "Use an HTTPS URL without credentials, query, or fragment.";
    if (url.pathname !== new URL(DEFAULT_ENDPOINTS[id]).pathname)
      return `Keep the required path ${new URL(DEFAULT_ENDPOINTS[id]).pathname}.`;
    return undefined;
  } catch { return "Enter a valid HTTPS endpoint URL."; }
}

export function discoveryEndpoint(id: "opencode-console" | "opencode-go", endpoint: string): string {
  const problem = validateEndpoint(id, endpoint);
  if (problem) throw new Error(problem);
  return new URL(id === "opencode-console" ? "/inference/v1/models" : "/inference/go/v1/models", endpoint).href;
}
