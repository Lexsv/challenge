import type { AppResult } from "./app-result";

export type OperationSafety = "read-only" | "idempotent" | "side-effecting";
export type ErrorSource = "llm" | "mcp" | "internal" | "storage" | "manager" | "resolver" | "router" | "provider-adapter";
const messages = {
  provider: "The model request failed.",
  refusal: "The model declined the request.",
  connection: "The connection failed.",
  protocol: "The server returned an incompatible response.",
  execution_error: "Tool execution failed.",
  invalid_arguments: "Tool arguments are invalid.",
  schema: "The result did not match the required schema.",
  unknown_tool: "The tool is unavailable.",
  authentication: "Authentication failed.",
  authorization: "Tool access was denied.",
  timeout: "The operation timed out.",
  cancelled: "The operation was cancelled.",
  unavailable: "The service is temporarily unavailable.",
  rate_limit: "The service is rate limited.",
  incomplete: "The model response was incomplete.",
  persistence: "Execution state could not be saved.",
  recovery: "The operation requires review.",
  dependency: "A required input or successful prerequisite was unavailable.",
  capacity: "The execution queue is full.",
  invalid_definition: "The tool definition is invalid.",
  ambiguous_tool: "The tool identity is ambiguous.",
  route_changed: "The tool catalog changed. Resolve the tools again.",
  unsupported_schema: "The declared schema is unsupported.",
} as const;
export const dependencyMessages = {
  batch_independence_unproven: "Batch independence was not established. Propose one operation at a time using the preceding result.",
  prerequisite_missing: "A required input or current-run prerequisite is missing.",
  prerequisite_failed: "The required current-run prerequisite failed or its verification is stale.",
  independence_after_failure_unproven: "Independence from an earlier failed or uncertain operation was not established.",
} as const;
export type DependencyReason = keyof typeof dependencyMessages;
export type ErrorCode = keyof typeof messages;
export type ExecutionError = {
  code: ErrorCode;
  message: string;
  diagnostic?: string;
  reportedFailure?: boolean;
  skipReason?: DependencyReason;
  source: ErrorSource;
  category:
    | "provider"
    | "refusal"
    | "connection"
    | "protocol"
    | "execution"
    | "validation"
    | "access"
    | "timeout"
    | "cancellation"
    | "persistence"
    | "recovery"
    | "dependency";
  stage: "resolution" | "compatibility" | "routing" | "validation" | "dispatch" | "response" | "checkpoint" | "recovery";
  retryable: boolean;
  certainty: "known" | "unknown";
  at: number;
  sessionId?: string;
  requestId?: string;
  llmCallId?: string;
  toolCallId?: string;
  connectionId?: string;
  toolId?: string;
  runId?: string;
  callId?: string;
  attemptId?: string;
};
export type AttemptResult<T> = AppResult<T, ExecutionError>;

export function executionError(
  code: ErrorCode,
  source: ErrorSource,
  stage: ExecutionError["stage"],
  at: number,
  certainty: ExecutionError["certainty"] = "known",
): ExecutionError {
  const safeCode = Object.hasOwn(messages, code) ? code : "execution_error";
  const categories: Record<ErrorCode, ExecutionError["category"]> = {
    provider: "provider",
    refusal: "refusal",
    unavailable: source === "llm" ? "provider" : "connection",
    rate_limit: "access",
    incomplete: "validation",
    connection: "connection",
    protocol: "protocol",
    execution_error: "execution",
    invalid_arguments: "validation",
    schema: "validation",
    unsupported_schema: "validation",
    invalid_definition: "validation",
    ambiguous_tool: "access",
    route_changed: "access",
    unknown_tool: "access",
    authentication: "access",
    authorization: "access",
    timeout: "timeout",
    cancelled: "cancellation",
    persistence: "persistence",
    recovery: "recovery",
    dependency: "dependency",
    capacity: "execution",
  };
  return {
    code: safeCode,
    category: categories[safeCode],
    source,
    stage,
    message: messages[safeCode],
    at,
    certainty,
    retryable:
      certainty === "known" &&
      ["connection", "unavailable", "rate_limit", "timeout"].includes(code),
  };
}

export function statusCode(status: number): ErrorCode {
  if (status === 401) return "authentication";
  if (status === 403) return "authorization";
  if (status === 429) return "rate_limit";
  if (status === 408 || status === 504) return "timeout";
  if ([500, 502, 503].includes(status)) return "unavailable";
  return "provider";
}

/** Tool observations can enter both restored history and a subsequent provider request. */
export function safeToolObservation(value: unknown, depth = 0): unknown {
  if (depth > 16) return "[omitted]";
  if (typeof value === "string") {
    if (/^\s*[[{]/.test(value)) {
      try {
        const parsed = JSON.parse(value);
        const cleaned = JSON.stringify(safeToolObservation(parsed, depth + 1));
        return cleaned === JSON.stringify(parsed) ? value : cleaned;
      } catch { /* Ordinary text may begin with a bracket. */ }
    }
    // Redact values locally so a credential example in a long API guide cannot
    // erase the guide. Unquoted assignments cover the line and any folded lines.
    // Unterminated quoted or compound values fail closed through the end of text.
    return value
      .replace(/-----BEGIN [^-\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\n]*PRIVATE KEY-----|$)/gi, "[redacted]")
      .replace(/([?&][^=&\s]*(?:key|token|secret|password)[^=&\s]*=)[^&#\s]*/gi, "$1[redacted]")
      .replace(/(?<![?&])\b(authorization|cookie|password|(?:access|refresh|user)?[_-]?token|api[_-]?key|(?:client[_-]?)?secret)(["']?\s*[:=])\s*(?:"(?:\\[\s\S]|[^"\\])*(?:"|$)|'(?:\\[\s\S]|[^'\\])*(?:'|$)|[[{][\s\S]*$|[^\r\n]*(?:\r?\n[ \t]+[^\r\n]*)*)/gi, "$1$2 [redacted]")
      .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi,"$1[redacted]@")
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,"[redacted]")
      .replace(/\b(?:Bearer|Basic)\s+[\w+/=.~-]+/gi, "[redacted]")
      .replace(/\b(?:sk-[\w-]{10,}|gh[pousr]_[\w]{10,})\b/g, "[redacted]")
      .replace(
        /([?&][^=&\s]*(?:key|token|secret|password)[^=&\s]*=)[^&#\s]+/gi,
        "$1[redacted]",
      );
  }
  if (Array.isArray(value))
    return value.map((item) => safeToolObservation(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, v]) => [
      key,
      !(typeof v === "number" && /^(?:(?:input|output|total|estimated|cached)[_-]?tokens?|tokens?[_-]?(?:count|limit|usage))$/i.test(key)) &&
      !/^header(?:Text|Height|Color|Title)$/i.test(key) &&
      /authorization|credential|secret|password|token|api[_-]?key|private[_-]?key|cookie|header/i.test(key)
        ? "[redacted]"
        : safeToolObservation(v, depth + 1),
    ]),
  );
}

export function retryAfterMs(value: string | null, now: number): number {
  if (!value) return 0;
  if (/^\d+$/.test(value))
    return Math.min(Number.MAX_SAFE_INTEGER, Number(value) * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : 0;
}

export const runTransitions = {
  Pending: ["Running", "Cancelled", "Interrupted"],
  Running: [
    "WaitingForRetry",
    "Interrupted",
    "Completed",
    "PartialSuccess",
    "Failed",
    "RequiresReview",
    "Cancelled",
  ],
  WaitingForRetry: [
    "Running",
    "Interrupted",
    "Failed",
    "PartialSuccess",
    "Cancelled",
    "RequiresReview",
  ],
  Interrupted: ["Running", "RequiresReview", "Cancelled"],
  Completed: [],
  PartialSuccess: [],
  Failed: [],
  RequiresReview: [],
  Cancelled: [],
} as const;
export const callTransitions = {
  Pending: ["Running", "Skipped", "Failed", "Cancelled"],
  Running: ["WaitingForRetry", "Success", "Failed", "Unknown", "Cancelled"],
  WaitingForRetry: ["Running", "Failed", "Cancelled", "Skipped"],
  Success: [],
  Failed: [],
  Skipped: [],
  Unknown: [],
  Cancelled: [],
} as const;
export function assertTransition(
  kind: "run" | "call",
  from: string,
  to: string,
) {
  const transitions: Record<string, readonly string[]> =
    kind === "run" ? runTransitions : callTransitions;
  if (!Object.hasOwn(transitions, from) || !transitions[from].includes(to))
    throw new Error("Invalid execution transition.");
}
