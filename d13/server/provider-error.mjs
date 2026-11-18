// Whitelisted metadata only: never return raw provider messages, bodies or headers.
export function providerError(status, payload) {
  const error = payload?.providerError ?? payload?.error ?? payload;
  const actualStatus =
    status === 502 &&
    payload?.providerError &&
    Number.isInteger(payload.providerError.status)
      ? payload.providerError.status
      : status;
  const code =
    typeof error?.code === "string"
      ? error.code
      : typeof error?.type === "string"
        ? error.type
        : "";
  const message = typeof error?.message === "string" ? error.message : "";
  const overflow =
    [400, 413, 422].includes(actualStatus) &&
    ([
      "context_length_exceeded",
      "context_window_exceeded",
      "max_context_length_exceeded",
    ].includes(code) ||
      /(?:maximum context length|context (?:window|length|limit)).{0,80}(?:exceed|too long)|(?:exceed).{0,80}(?:context window|context length)/i.test(
        message,
      ));
  return {
    kind: overflow
      ? "context-overflow"
      : actualStatus === 401 || actualStatus === 403
        ? "authentication"
        : actualStatus === 429
          ? "rate-limit"
          : "request",
    status: actualStatus,
    ...(overflow ? { code: "context_length_exceeded" } : {}),
  };
}
