export type ApiParameter = {
  id: string;
  enabled: boolean;
  key: string;
  value: string;
};
export function newParameter(): ApiParameter {
  return { id: crypto.randomUUID(), enabled: false, key: "", value: "" };
}
export function parseParameterValue(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    if (/^[\[{]/.test(trimmed))
      throw new Error("Invalid JSON object or array.");
    return value;
  }
}
export function validateParameters(
  parameters: ApiParameter[],
): string | undefined {
  const keys = new Set<string>();
  for (const row of parameters) {
    if (!row.enabled) continue;
    const key = row.key.trim();
    if (!key) return "Enabled parameters need a key.";
    if (key !== row.key)
      return "Parameter keys cannot start or end with whitespace.";
    if (keys.has(key)) return `Duplicate active parameter: ${key}.`;
    keys.add(key);
    try {
      parseParameterValue(row.value);
    } catch {
      return `Invalid JSON object or array for '${key}'.`;
    }
  }
  return undefined;
}
export function parameterPayload(
  parameters: ApiParameter[],
): Record<string, unknown> {
  const error = validateParameters(parameters);
  if (error) throw new Error(error);
  return Object.fromEntries(
    parameters
      .filter((p) => p.enabled)
      .map((p) => [p.key, parseParameterValue(p.value)]),
  );
}
