export type McpParameter = {
  key: string;
  enabled: boolean;
  secret: boolean;
  value?: string;
};
export type ParameterAuth =
  | { type: "none" | "bearer" }
  | { type: "query"; parameter: string }
  | { type: "headers"; headers: string[] }
  | { type: "query" | "headers"; rows: McpParameter[] };

export function parameterRows(auth: ParameterAuth): McpParameter[] {
  if ("rows" in auth) return auth.rows;
  const keys =
    "headers" in auth
      ? auth.headers
      : "parameter" in auth
        ? [auth.parameter]
        : auth.type === "bearer"
          ? ["Authorization"]
          : [];
  return keys.map((key) => ({ key, enabled: true, secret: true }));
}

export const sensitiveParameter = (key: string) =>
  /authorization|credential|secret|password|token|api[-_]?key|cookie|signature|private[-_]?key|^(?:key|auth|access)$/i.test(
    key,
  );

// Include active public query values in the existing endpoint uniqueness check.
// Preserve spelling and ordering of unrelated query parameters.
export function parameterEndpoint(input: string, auth: ParameterAuth): string | undefined {
  if (auth.type !== "query" || !("rows" in auth)) return input;
  try {
    const url = new URL(input);
    for (const row of auth.rows) {
      const existing = url.searchParams.getAll(row.key);
      if (existing.length) {
        if (row.secret || !row.enabled || existing.length !== 1 || existing[0] !== row.value) return;
      } else if (row.enabled && !row.secret) {
        url.search += (url.search ? "&" : "?") + new URLSearchParams([[row.key, row.value ?? ""]]).toString();
      }
    }
    return url.href;
  } catch { return; }
}

export function editableEndpoint(endpoint: string, auth: ParameterAuth): string {
  if (auth.type !== "query" || !("rows" in auth)) return endpoint;
  const publicKeys = new Set(auth.rows.filter(row => row.enabled && !row.secret).map(row => row.key));
  const url = new URL(endpoint);
  url.search = url.search.slice(1).split("&").filter(part =>
    !publicKeys.has(new URLSearchParams(part).keys().next().value ?? "")).join("&");
  return url.href;
}
