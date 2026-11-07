import { httpFailure, sanitizeFailureText, type NormalizedFailure } from "./normalized-failure";
import { parameterPayload } from "./api-parameters";
import { captureExecutionParameters } from "./execution-parameters";
import { consoleTransportUrl } from "./opencode-console-transport";
import { consoleVerificationPlan } from "./opencode-console-verification";
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
  endpoint: () => string = () => INFERENCE_ENDPOINTS[mode],
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
      const plan = mode === "console" ? consoleVerificationPlan(request.settings.model, endpoint()) : undefined;
      if (mode === "console" && !plan) return { status: "failed", text: "", error: "OpenCode Console protocol is unavailable for this model or endpoint.", failure: { category: "unsupported_protocol", summary: "The model protocol is unavailable for this endpoint." } satisfies NormalizedFailure, ms: performance.now() - started };
      const params = request.settings.parameters
        ? parameterPayload(request.settings.parameters)
        : {};
      const reserved = [
        "model",
        "messages",
        "response_format",
        "max_completion_tokens",
        ...(plan?.protocol === "responses" ? ["input", "instructions", "text"] : []),
      ];
      if (reserved.some((name) => Object.hasOwn(params, name)))
        return {
          status: "failed",
          text: "",
          error: "A parameter conflicts with fields managed by OpenCode.",
          ms: performance.now() - started,
        };
      const { max_output_tokens, ...rest } = params;
      const effort = plan?.protocol === "responses" ? rest.reasoning_effort : undefined;
      if (effort !== undefined && Object.hasOwn(rest, "reasoning")) return { status: "failed", text: "", error: "A parameter conflicts with fields managed by OpenCode.", ms: performance.now() - started };
      const responseParams = { ...rest };
      if (effort !== undefined) delete responseParams.reasoning_effort;
      const body = plan?.protocol === "responses" ? {
        ...responseParams,
        ...(effort !== undefined ? { reasoning: { effort } } : {}),
        max_output_tokens: Object.hasOwn(params, "max_output_tokens") ? max_output_tokens : request.settings.maxTokens,
        model: request.settings.model,
        instructions: request.instructions,
        input: request.input,
        ...(request.schema ? { text: { format: { type: "json_schema", name: "lab_output", strict: true, schema: request.schema } } } : {}),
      } : {
        ...rest,
        max_completion_tokens: Object.hasOwn(params, "max_output_tokens") ? max_output_tokens : request.settings.maxTokens,
        model: request.settings.model,
        messages: [
          { role: "system", content: request.instructions },
          { role: "user", content: request.input },
        ],
        ...(request.schema ? { response_format: { type: "json_schema", json_schema: { name: "lab_output", strict: true, schema: request.schema } } } : {}),
      };
      const configuration = { ...body };
      delete (configuration as Record<string, unknown>).messages;
      delete (configuration as Record<string, unknown>).input;
      delete (configuration as Record<string, unknown>).instructions;
      const executionParameters = captureExecutionParameters(
        configuration,
        key,
      );
      const response = await fetcher(plan ? consoleTransportUrl(plan.endpoint) : endpoint(), {
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
        let reportedFailureCost: number | undefined;
        let reportedFailureEstimated = false;
        try {
          const payload: unknown = await response.json();
          if (payload && typeof payload === "object") {
            const billing = (payload as { usage?: { cost?: unknown; opencode?: { estimated?: unknown } } }).usage;
            if (mode === "console" && new URL(endpoint()).origin === "https://opencode.ai" && typeof billing?.cost === "number" && Number.isFinite(billing.cost) && billing.cost >= 0) {
              reportedFailureCost = billing.cost;
              reportedFailureEstimated = billing.opencode?.estimated === true;
            }
            const record = payload as { error?: unknown; message?: unknown; error_description?: unknown };
            const error = record.error ?? record.message ?? record.error_description;
            const message =
              typeof error === "string"
                ? error
                : error && typeof error === "object" && "message" in error
                  ? (error as { message?: unknown }).message
                  : undefined;
            if (typeof message === "string") detail = sanitizeFailureText(message, key);
          }
        } catch {
          /* Use the status-only fallback. */
        }
        const failure = httpFailure(response.status, detail, response.headers?.get("retry-after"));
        return {
          status: "failed",
          text: "",
          failure,
          ...(reportedFailureCost !== undefined ? { cost: { usd: reportedFailureCost, source: "provider" as const, estimated: reportedFailureEstimated } } : {}),
          error: detail
            ? `OpenCode request failed (${response.status}): ${detail}`
            : `OpenCode request failed (${response.status}). Check account access, model and settings.`,
          ms: performance.now() - started,
          executionParameters,
        };
      }
      let data: any;
      try { data = await response.json(); }
      catch { return { status: "failed", text: "", error: "The provider returned an invalid response.", failure: { category: "malformed_response", summary: "The provider returned an invalid response.", httpStatus: response.status }, ms: performance.now() - started, executionParameters }; }
      if (!data || typeof data !== "object" || Array.isArray(data)) return { status: "failed", text: "", error: "The provider returned an invalid response.", failure: { category: "malformed_response", summary: "The provider returned an invalid response.", httpStatus: response.status }, ms: performance.now() - started, executionParameters };
      const choice = data.choices?.[0];
      const text = plan?.protocol === "responses"
        ? (Array.isArray(data.output) ? data.output.flatMap((item: { content?: unknown }) => Array.isArray(item.content) ? item.content : []).filter((part: { type?: string; text?: unknown }) => part?.type === "output_text" && typeof part.text === "string").map((part: { text: string }) => part.text).join("") : "")
        : typeof choice?.message?.content === "string" ? choice.message.content : "";
      const number = (v: unknown) =>
        typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
      const usage = data.usage
        ? {
            input: number(plan?.protocol === "responses" ? data.usage.input_tokens : data.usage.prompt_tokens),
            output: number(plan?.protocol === "responses" ? data.usage.output_tokens : data.usage.completion_tokens),
            reasoning: number(
              (plan?.protocol === "responses" ? data.usage.output_tokens_details : data.usage.completion_tokens_details)?.reasoning_tokens,
            ),
            cachedInput: number((plan?.protocol === "responses" ? data.usage.input_tokens_details : data.usage.prompt_tokens_details)?.cached_tokens),
          }
        : undefined;
      const reportedCost = mode === "console" && new URL(endpoint()).origin === "https://opencode.ai" ? number(data.usage?.cost) : undefined;
      const common = {
        text,
        ...(reportedCost !== undefined ? { cost: { usd: reportedCost, source: "provider" as const, estimated: data.usage?.opencode?.estimated === true } } : {}),
        usage,
        ms: performance.now() - started,
        actualModel:
          typeof data.model === "string" ? data.model : undefined,
        executionParameters,
      };
      if (choice?.finish_reason === "length" || (plan?.protocol === "responses" && data.status === "incomplete" && data.incomplete_details?.reason === "max_output_tokens"))
        return {
          ...common,
          status: "incomplete",
          incompleteReason: "max_output_tokens",
          error: "The response reached its output limit.",
        };
      if (choice?.finish_reason === "content_filter" || (plan?.protocol === "responses" && data.status === "incomplete" && data.incomplete_details?.reason === "content_filter"))
        return {
          ...common,
          status: "incomplete",
          incompleteReason: "content_filter",
          error: "The response was restricted by a content filter.",
        };
      if (!text.trim() || (plan?.protocol === "responses" ? data.status !== "completed" : choice?.finish_reason !== "stop"))
        return {
          ...common,
          status: "failed",
          error: "No complete text answer was returned.",
          failure: { category: "malformed_response", summary: "No complete text answer was returned.", httpStatus: response.status },
        };
      return { ...common, status: "succeeded" };
    } catch {
      return {
        status: timeout ? "timed-out" : "failed",
        text: "",
        error: timeout
          ? "OpenCode request timed out; the remote request may still be billable."
          : "OpenCode request could not complete. Check the network and settings.",
        failure: timeout
          ? { category: "timeout", summary: "The request timed out." }
          : { category: "transport", summary: "The request could not complete. A network, browser CORS, or local proxy issue may be responsible." },
        ms: performance.now() - started,
      };
    } finally {
      clearTimeout(timer);
    }
  };
}
