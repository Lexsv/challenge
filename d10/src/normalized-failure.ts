/** Provider-neutral failure metadata. Never store request headers or raw payloads. */
export type FailureCategory = "request" | "authentication" | "payment" | "permission" | "not_found" | "timeout" | "conflict" | "gone" | "request_too_large" | "rate_limit" | "service" | "transport" | "unsupported_protocol" | "malformed_response" | "http_error";
export type NormalizedFailure = { category: FailureCategory; summary: string; httpStatus?: number; providerMessage?: string; retryAfter?: string };

export function sanitizeFailureText(text: string, credential: string): string {
  return (credential ? text.split(credential).join("[redacted]") : text)
    .replace(/bearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/(?:oc_sk_|sk-|ghp_|opencode-)[a-zA-Z0-9_-]{8,}/gi, "[redacted]")
    .replace(/(authorization|x-api-key|api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|client[_-]?secret|secret|credential|cookie)["']?\s*[=:]\s*["']?[^\s,;"']+/gi, "$1=[redacted]")
    .replace(/https?:\/\/[^\s/@:]+:[^\s/@]+@/gi, "https://[redacted]@")
    .replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 500);
}

export function httpFailure(status: number, message?: string, retryAfter?: string | null): NormalizedFailure {
  const definitions: Record<number, [FailureCategory, string]> = {
    400: ["request", "The provider rejected the request."], 401: ["authentication", "Authentication was rejected."],
    402: ["payment", "The provider requires payment or account action."], 403: ["permission", "The provider denied access."],
    404: ["not_found", "The requested resource was not found."], 408: ["timeout", "The request timed out."],
    409: ["conflict", "The provider reported a request conflict."], 410: ["gone", "The requested resource is no longer available."],
    413: ["request_too_large", "The provider rejected the request size."], 422: ["request", "The provider could not process the request."],
    429: ["rate_limit", "The provider limited the request."], 500: ["service", "The provider or an intermediary reported a server error."],
    502: ["service", "The provider or an intermediary reported a gateway error."], 503: ["service", "The provider or an intermediary is unavailable."],
    504: ["service", "The provider or an intermediary reported a gateway timeout."],
  };
  const [category, summary] = definitions[status] ?? ["http_error", "The provider returned an HTTP error."];
  const retry = retryAfter?.trim();
  const safeRetry = retry && (/^\d{1,10}$/.test(retry) || (/^[A-Za-z0-9,:+\- ]{1,80}$/.test(retry) && Number.isFinite(Date.parse(retry)))) ? retry : undefined;
  return { category, summary, httpStatus: status, ...(message ? { providerMessage: message } : {}), ...(safeRetry ? { retryAfter: safeRetry } : {}) };
}
