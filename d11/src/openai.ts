import { capabilities } from "./openai-model-catalog";
import {
  captureExecutionParameters,
  type ExecutionParameters,
} from "./execution-parameters";
import { parameterPayload, validateParameters } from "./api-parameters";
import { incompleteExplanation } from "./result-explanations";
import { type Usage, type IncompleteReason } from "./models";
import { validSettings } from "./openai-model-compat";
import { sanitizeFailureText } from "./normalized-failure";
import type { Adapter, Request } from "./provider-contract";
import type { Attempt } from "./models";
export type { Adapter, Request } from "./provider-contract";
const statusError = (status: number) =>
  status === 401
    ? "Authentication failed (401). Check your key privately in connection settings."
    : status === 429
      ? "Rate limit or quota exceeded (429). Check your account quota and request limits before retrying."
      : status === 403
        ? "Access denied (403). Check project and model permissions."
        : status === 400
          ? "Request rejected (400). Check model capabilities, input length, and settings."
          : status === 404
            ? "Model unavailable (404). Check the model ID and project access."
            : `OpenAI request failed (${status}). Check service status before retrying.`;
async function respondInternal(
  key: string,
  request: Request,
  onDispatch: (body: Record<string, unknown>) => void,
  endpoint: string,
): Promise<Omit<Attempt, "id">> {
  const start = performance.now();
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 120000);
  let usage: Usage | undefined;
  let text = "";
  try {
    if (!key.trim() || !validSettings({ ...request.settings, parameters: undefined }))
      return {
        status: "failed",
        text: "",
        error:
          "Invalid model settings. Check the selected model’s reasoning options and output token limit.",
        ms: performance.now() - start,
      };
    if (
      request.schema &&
      !capabilities(request.settings.model)?.structuredOutput
    )
      return {
        status: "failed",
        text: "",
        error:
          "Structured generation requires a catalog model. Custom model capabilities are unverified.",
        ms: performance.now() - start,
      };
    const parameterError = validateParameters(request.settings.parameters ?? []);
    if (parameterError) return { status: "failed", text: "", error: parameterError, ms: performance.now() - start };
    const parameters = request.settings.parameters ? parameterPayload(request.settings.parameters) : { max_output_tokens: request.settings.maxTokens };
    const reserved = ["model", "store", "instructions", "input", "text", "reasoning"];
    if (reserved.some((name) => Object.hasOwn(parameters, name)))
      return { status: "failed", text: "", error: "A parameter conflicts with fields managed by OpenAI.", ms: performance.now() - start };
    const effort = parameters.reasoning_effort;
    if (effort !== undefined && request.settings.reasoning)
      return { status: "failed", text: "", error: "A parameter conflicts with the configured OpenAI reasoning setting.", ms: performance.now() - start };
    const { reasoning_effort: _effort, ...otherParameters } = parameters;
    const body: Record<string, unknown> = {
      model: request.settings.model,
      store: false,
      instructions: request.instructions,
      input: request.input,
      ...otherParameters,
      ...(effort !== undefined ? { reasoning: { effort } } : {}),
      ...(capabilities(request.settings.model)?.reasoningEfforts.includes(
        request.settings.reasoning || "",
      ) && request.settings.reasoning
        ? { reasoning: { effort: request.settings.reasoning } }
        : {}),
      ...(request.schema
        ? {
            text: {
              format: {
                type: "json_schema",
                name: "lab_output",
                strict: true,
                schema: request.schema,
              },
            },
          }
        : {}),
    };
    onDispatch(body);
    const res = await fetch(endpoint, {
      method: "POST",
      redirect: "error",
      credentials: "omit",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      let detail = "";
      {
        try {
          const payload = await res.json();
          const message = typeof payload?.error === "string" ? payload.error : payload?.error?.message ?? payload?.message;
          if (typeof message === "string") detail = sanitizeFailureText(message, key);
        } catch {
          /* Use the sanitized status message. */
        }
      }
      return {
        status: "failed",
        text: "",
        error: detail ? `OpenAI request failed (${res.status}): ${detail}` : statusError(res.status),
        ms: performance.now() - start,
      };
    }
    const data = await res.json();
    const number = (n: unknown) =>
      typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : undefined;
    if (data.usage)
      usage = {
        input: number(data.usage.input_tokens),
        output: number(data.usage.output_tokens),
        reasoning: number(data.usage.output_tokens_details?.reasoning_tokens),
      };
    const content = (Array.isArray(data.output) ? data.output : []).flatMap(
      (v: { content?: unknown[] }) =>
        Array.isArray(v.content) ? v.content : [],
    ) as { type: string; text?: string }[];
    text = content
      .filter((c) => c.type === "output_text" && typeof c.text === "string")
      .map((c) => c.text)
      .join("\n");
    if (content.some((c) => c.type === "refusal"))
      return {
        status: "failed",
        text: "",
        error:
          "The model refused this request. Review the input before retrying.",
        usage,
        ms: performance.now() - start,
      };
    if (data.status === "incomplete") {
      const rawReason: unknown = data.incomplete_details?.reason;
      const incompleteReason =
        typeof rawReason === "string" &&
        [
          "max_output_tokens",
          "content_filter",
          "max_messages",
          "steered",
        ].includes(rawReason)
          ? (rawReason as IncompleteReason)
          : undefined;
      return {
        status: "incomplete",
        text,
        usage,
        incompleteReason,
        error: incompleteExplanation(incompleteReason),
        ms: performance.now() - start,
      };
    }
    if (data.status !== "completed" || !text.trim())
      return {
        status: "failed",
        text,
        usage,
        error: "No complete text answer was returned.",
        ms: performance.now() - start,
      };
    return {
      status: "succeeded",
      text,
      usage,
      actualModel:
        typeof data.model === "string" ? data.model : request.settings.model,
      ms: performance.now() - start,
    };
  } catch {
    return {
      status: timedOut ? "timed-out" : "failed",
      text,
      usage,
      error: timedOut
        ? "Request timed out after 120 seconds. A remote request may still be billable."
        : "Request could not complete. Check network, browser restrictions, and configuration. No automatic retry was made.",
      ms: performance.now() - start,
    };
  } finally {
    clearTimeout(timer);
  }
}

export const respondAtEndpoint = async (key: string, request: Request, endpoint: string) => {
  let executionParameters: ExecutionParameters | undefined;
  const result = await respondInternal(key, request, (body) => {
    executionParameters = captureExecutionParameters(body, key);
  }, endpoint);
  return executionParameters === undefined
    ? result
    : { ...result, executionParameters };
};
export const respond: Adapter = (key, request) => respondAtEndpoint(key, request, "https://api.openai.com/v1/responses");
