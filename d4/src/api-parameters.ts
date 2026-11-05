export type ApiParameter = {
  id: string;
  enabled: boolean;
  key: string;
  value: string;
};
export function newParameter(): ApiParameter {
  return { id: crypto.randomUUID(), enabled: false, key: "", value: "" };
}
const reserved = new Set([
  "model",
  "store",
  "instructions",
  "input",
  "reasoning",
  "text",
]);
export function initialParameters(maxTokens: number): ApiParameter[] {
  return [
    {
      id: crypto.randomUUID(),
      enabled: true,
      key: "max_output_tokens",
      value: String(maxTokens),
    },
    { id: crypto.randomUUID(), enabled: false, key: "temperature", value: "0" },
  ];
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
    if (reserved.has(key))
      return `The '${key}' field is managed by the application.`;
    if (keys.has(key)) return `Duplicate active parameter: ${key}.`;
    keys.add(key);
    try {
      const value = parseParameterValue(row.value);
      if (
        key === "max_output_tokens" &&
        (!Number.isInteger(value) || (value as number) < 16)
      )
        return "max_output_tokens must be an integer of at least 16.";
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
