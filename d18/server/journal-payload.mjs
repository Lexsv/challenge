import { isDeepStrictEqual } from "node:util";
import { safeToolObservation } from "../src/execution-policy.ts";
export function containsCredential(value, values) {
  const json = JSON.stringify(value);
  return values.some((v) =>
    [
      v,
      encodeURIComponent(v),
      new URLSearchParams({ v }).toString().slice(2),
      JSON.stringify(v).slice(1, -1),
    ].some((s) => json.includes(s)),
  );
}

// Retain original formatting for unchanged JSON. Omit a payload entirely if it
// echoes a configured credential, including when JSON escapes its characters.
export function sanitizedCapture(text, credentials = [], allow = () => true) {
  if (typeof text !== "string" || Buffer.byteLength(text) > 65536) return null;
  try {
    const original = JSON.parse(text);
    if (!allow(original) || (credentials.length && containsCredential(original, credentials)))
      return null;
    const safe = safeToolObservation(original);
    return isDeepStrictEqual(original, safe) ? text : JSON.stringify(safe);
  } catch {
    return null;
  }
}

// A rejected result can still contain useful textual diagnostics. Keep binary
// and unrecognized blocks out of both decoded and wire-format journal entries.
export function journalableMcpContent(result) {
  return Array.isArray(result?.content) && result.content.every(block =>
    block?.type === "text" && typeof block.text === "string" &&
    Object.keys(block).every(key => ["type", "text", "annotations", "_meta"].includes(key)));
}

export function safeResourceUri(uri, credentials = []) {
  if (typeof uri !== "string" || uri.length > 2048 || /[\s\x00-\x1f]/u.test(uri) ||
      !URL.canParse(uri) || safeToolObservation(uri) !== uri || containsCredential(uri, credentials)) return false;
  const url = new URL(uri);
  return !url.username && !url.password;
}
