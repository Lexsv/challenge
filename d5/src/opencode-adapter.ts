import { parameterPayload } from "./api-parameters";
import { captureExecutionParameters } from "./execution-parameters";
import type { Adapter, Request } from "./provider-contract";

export type OpenCodeMode = "console" | "go";
export const INFERENCE_ENDPOINTS = {
  console: "https://opencode.ai/inference/openai/v1/chat/completions",
  go: "https://opencode.ai/inference/go/openai/v1/chat/completions",
} as const;

// Separate boundary: never forward credentials to arbitrary or redirected URLs.
export function openCodeAdapter(
  mode: OpenCodeMode,
  fetcher: typeof fetch = fetch,
): Adapter {
  return async (key: string, request: Request) => {
    const started = performance.now();
    if (!key.trim() || !request.settings.model.trim())
      return {
        status: "failed",
        text: "",
        error: "OpenCode key or model is missing.",
        ms: performance.now() - started,
      };
    const abort = new AbortController();
    let timeout = false;
    const timer = setTimeout(() => {
      timeout = true;
      abort.abort();
    }, 120000);
    try {
      const params = request.settings.parameters
        ? parameterPayload(request.settings.parameters)
        : {};
      const reserved = [
        "model",
        "messages",
        "response_format",
        "max_completion_tokens",
      ];
      if (reserved.some((name) => Object.hasOwn(params, name)))
        return {
          status: "failed",
          text: "",
          error: "A parameter conflicts with fields managed by OpenCode.",
          ms: performance.now() - started,
        };
      const { max_output_tokens, ...rest } = params;
      const body = {
        ...rest,
        max_completion_tokens: max_output_tokens ?? request.settings.maxTokens,
        model: request.settings.model,
        messages: [
          { role: "system", content: request.instructions },
          { role: "user", content: request.input },
        ],
        ...(request.schema
          ? {
              response_format: {
                type: "json_schema",
                json_schema: {
                  name: "lab_output",
                  strict: true,
                  schema: request.schema,
                },
              },
            }
          : {}),
      };
      const { messages: _messages, ...configuration } = body;
      const executionParameters = captureExecutionParameters(
        configuration,
        key,
      );
      const response = await fetcher(INFERENCE_ENDPOINTS[mode], {
        method: "POST",
        redirect: "error",
        credentials: "omit",
        signal: abort.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        let detail = "";
        try {
          const payload: unknown = await response.json();
          if (payload && typeof payload === "object" && "error" in payload) {
            const error = (payload as { error?: unknown }).error;
            const message =
              typeof error === "string"
                ? error
                : error && typeof error === "object" && "message" in error
                  ? (error as { message?: unknown }).message
                  : undefined;
            if (typeof message === "string")
              detail = message
                .split(key)
                .join("[redacted]")
                .replace(/bearer\s+[^\s,;]+/gi, "Bearer [redacted]")
                .replace(
                  /(?:sk-|ghp_|opencode-)[a-zA-Z0-9_-]{8,}/gi,
                  "[redacted]",
                )
                .replace(
                  /(authorization|x-api-key|api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|client[_-]?secret|secret|credential|cookie)["']?\s*[=:]\s*["']?[^\s,;"']+/gi,
                  "$1=[redacted]",
                )
                .replace(
                  /https?:\/\/[^\s/@:]+:[^\s/@]+@/gi,
                  "https://[redacted]@",
                )
                .replace(/[\u0000-\u001f\u007f]/g, " ")
                .trim()
                .slice(0, 500);
          }
        } catch {
          /* Use the status-only fallback. */
        }
        return {
          status: "failed",
          text: "",
          error: detail
            ? `OpenCode request failed (${response.status}): ${detail}`
            : `OpenCode request failed (${response.status}). Check account access, model and settings.`,
          ms: performance.now() - started,
          executionParameters,
        };
      }
      const data = await response.json();
      const choice = data.choices?.[0];
      const text =
        typeof choice?.message?.content === "string"
          ? choice.message.content
          : "";
      const number = (v: unknown) =>
        typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
      const usage = data.usage
        ? {
            input: number(data.usage.prompt_tokens),
            output: number(data.usage.completion_tokens),
            reasoning: number(
              data.usage.completion_tokens_details?.reasoning_tokens,
            ),
          }
        : undefined;
      const common = {
        text,
        usage,
        ms: performance.now() - started,
        actualModel:
          typeof data.model === "string" ? data.model : request.settings.model,
        executionParameters,
      };
      if (choice?.finish_reason === "length")
        return {
          ...common,
          status: "incomplete",
          incompleteReason: "max_output_tokens",
          error: "The response reached its output limit.",
        };
      if (choice?.finish_reason === "content_filter")
        return {
          ...common,
          status: "incomplete",
          incompleteReason: "content_filter",
          error: "The response was restricted by a content filter.",
        };
      if (!text.trim() || choice?.finish_reason !== "stop")
        return {
          ...common,
          status: "failed",
          error: "No complete text answer was returned.",
        };
      return { ...common, status: "succeeded" };
    } catch {
      return {
        status: timeout ? "timed-out" : "failed",
        text: "",
        error: timeout
          ? "OpenCode request timed out; the remote request may still be billable."
          : "OpenCode request could not complete. Check the network and settings.",
        ms: performance.now() - started,
      };
    } finally {
      clearTimeout(timer);
    }
  };
}
