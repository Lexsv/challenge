// Omit credentials and request content; retain only the options actually sent.
const secretName =
  /(?:authorization|password|secret|credential|api[_-]?key|private[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|headers|cookie)|^token$/i;
const privateField = new Set([
  "model",
  "input",
  "instructions",
  "store",
  "text",
]);
export type ExecutionParameters = Readonly<Record<string, unknown>>;
export function captureExecutionParameters(
  body: Record<string, unknown>,
  credential: string,
): ExecutionParameters {
  const sanitize = (value: unknown): unknown => {
    if (typeof value === "string") {
      if (
        (credential && value.includes(credential)) ||
        /\b(?:sk-[A-Za-z0-9_-]{8,}|bearer\s+\S+|ghp_[A-Za-z0-9_]+)\b/i.test(
          value,
        )
      )
        return "[redacted]";
      return value;
    }
    if (Array.isArray(value)) return Object.freeze(value.map(sanitize));
    if (value && typeof value === "object")
      return Object.freeze(
        Object.fromEntries(
          Object.entries(value)
            .filter(([key]) => !secretName.test(key))
            .map(([key, item]) => [key, sanitize(item)]),
        ),
      );
    return value;
  };
  return Object.freeze(
    Object.fromEntries(
      Object.entries(body)
        .filter(([key]) => !privateField.has(key) && !secretName.test(key))
        .map(([key, value]) => [key, sanitize(value)]),
    ),
  );
}
