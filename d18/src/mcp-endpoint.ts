// Shared identity for the stored endpoint, before any authentication is applied.
export function normalizedMcpEndpoint(
  input: string,
  authParameter?: string,
): string | undefined {
  if (typeof input !== "string" || input.length > 2048) return;
  const text = input.trim();
  if (!text || text.includes("#") || /[\\\s]/.test(text)) return;
  try {
    const url = new URL(text);
    if (
      url.username ||
      url.password ||
      !["http:", "https:"].includes(url.protocol)
    )
      return;
    for (const key of url.searchParams.keys()) {
      if (
        key === authParameter ||
        /(?:(?:token|password|secret|credentials?|signature|api[-_]?key)$|^(?:key|auth|authorization)$)/i.test(
          key,
        )
      )
        return;
    }
    // URL normalizes hosts and default ports. Preserve path case, trailing slashes,
    // query order, repeated keys and escaping exactly as serialized by URL.
    return url.href;
  } catch {
    return;
  }
}
