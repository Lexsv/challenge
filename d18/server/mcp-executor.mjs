import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  safeToolObservation,
  executionError,
} from "../src/execution-policy.ts";
import { containsCredential, sanitizedCapture } from "./journal-payload.mjs";
import { McpProblem } from "./mcp-configuration.mjs";

export function mcpFailure(toolId, error, signal, stage = "dispatch") {
  let code = "protocol";
  if (signal?.aborted) code = "cancelled";
  else if (error instanceof McpProblem) {
    code =
      {
        credential: "authentication",
        authentication: "authentication",
        permission: "authorization",
        missing: "authorization",
        deleting: "authorization",
        conflict: "authorization",
        sensitive: "schema",
        timeout: "timeout",
        tls: "connection",
        tls_config: "connection",
        transport: "connection",
        redirect: "authorization",
        busy: "capacity",
        result: "schema",
        tool: "execution_error",
      }[error.code] ?? "protocol";
    if (error.httpStatus === 429) code = "rate_limit";
    else if ([500, 502, 503, 504].includes(error.httpStatus))
      code = "unavailable";
    else if (error.httpStatus === 408) code = "timeout";
    else if (error.httpStatus && error.code === "transport") code = "protocol";
  } else if (error?.code === -32602) code = "invalid_arguments";
  else if (error?.code === -32001) code = "timeout";
  return {
    ok: false,
    toolId,
    error: {
      ...executionError(code, "mcp", stage, Date.now()),
      ...(error instanceof McpProblem && ["tls", "tls_config"].includes(error.code) && {retryable: false, diagnostic: error.message}),
      ...(error instanceof McpProblem && ["tool", "result"].includes(error.code) && error.diagnostic && {diagnostic:error.diagnostic}),
      ...(code === "execution_error" && error.reportedFailure && {reportedFailure:true}),
      ...(error?.retryAfter > 0 && { retryAfterMs: error.retryAfter }),
    },
  };
}

function toolFailure(result, envelope, credentials) {
  const problem = new McpProblem("tool");
  problem.reportedFailure = result.isError === true;
  const message = envelope?.error?.message ?? envelope?.message ??
    (typeof envelope?.error === "string" ? envelope.error : result.content?.find(b => b.type === "text")?.text);
  if (typeof message !== "string") return problem;
  // Sanitize the entire string before taking a bounded excerpt, including
  // credential echoes recognized by this connection. Drop unsafe diagnostics.
  const capture = sanitizedCapture(JSON.stringify(message), credentials);
  if (capture) problem.diagnostic = JSON.parse(capture).replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu, " ").trim().slice(0, 512);
  return problem;
}

// Only protocol-defined type labels and counts are safe to copy from a
// rejected block. An unknown discriminator can itself contain private data.
const contentTypes = new Set(["text", "image", "audio", "resource", "resource_link"]);
function invalidResult(reason, result, responseBytes) {
  const blocks = Array.isArray(result?.content) ? result.content : [];
  const contentBlockTypes = {};
  for (const block of blocks) {
    const type = contentTypes.has(block?.type) ? block.type : "unrecognized";
    contentBlockTypes[type] = (contentBlockTypes[type] ?? 0) + 1;
  }
  const problem = new McpProblem("result");
  problem.resultDetails = {reason, contentBlocks:blocks.length, contentBlockTypes, responseBytes};
  problem.diagnostic = reason + " " + blocks.length + " content block(s) " +
    JSON.stringify(contentBlockTypes) + ", " + responseBytes + " decoded response bytes.";
  return problem;
}

// Formatting a link for the model and durably accepting it as a watch are
// distinct. Keep missing-evidence semantics even when every link was handled.
export function recordConsumedLinks(output, count) {
  const warning = output?.compatibilityWarning;
  if (!count || !warning?.omitted || !(warning.omitted.resource_link >= count)) return;
  output.watchedResourceLinks = count;
  warning.omitted.resource_link -= count;
  if (!warning.omitted.resource_link) delete warning.omitted.resource_link;
  if (!Object.keys(warning.omitted).length) {
    output.evidenceIncomplete = warning.evidenceIncomplete;
    delete output.compatibilityWarning;
  }
}

export function normalizeMcpResult(result, destination, values) {
  // Validate here so malformed results can still leave sanitized diagnostics
  // for both HTTP transports before returning a structured failure.
  const bytes = Buffer.byteLength(JSON.stringify(result) ?? "");
  const invalid = reason => invalidResult(reason, result, bytes);
  if (!CallToolResultSchema.safeParse(result).success)
    throw invalid("Invalid MCP CallToolResult envelope.");
  // The SDK has correlated the JSON-RPC reply with this invocation. In a
  // valid CallToolResult, omitted isError means success. HTTP 200 alone does
  // not reach this boundary. Keep operational errors ahead of format fallback.
  const blocks = result.content ?? [];
  const texts = blocks.filter(block => block.type === "text");
  const failedEnvelope = value => value?.success === false || value?.ok === false ||
    (value?.error && (value.status === "error" || Object.keys(value).length === 1));
  if (result.isError === true || failedEnvelope(result.structuredContent))
    throw toolFailure(result, result.structuredContent, values);
  // Keep the existing interpretation of ordinary structured/text replies.
  // In a mixed format, also check accompanying text for a tool-level failure.
  const mixed = texts.length < blocks.length;
  const inspectText = mixed || (texts.length === 1 && !Object.keys(result.structuredContent ?? {}).length);
  for (const block of inspectText ? texts : []) {
    const text = block.text.trim();
    if (/^(?:tool execution failed\s*:|error executing (?:tool|code)\b|no (?:[\w-]+ ){0,3}(?:instance|document|client|session) (?:is )?connected\b)/i.test(text))
      throw toolFailure({ content:[block] }, undefined, values);
    if (text.startsWith("{")) {
      let parsed;
      try { parsed = JSON.parse(text); } catch { /* Ordinary text. */ }
      if (failedEnvelope(parsed)) throw toolFailure(result, parsed, values);
    }
  }
  if (!Array.isArray(result.content) || (!result.content.length && !result.structuredContent))
    throw invalid("Missing tool result content.");
  if (result.task) throw invalid("Asynchronous task results are unsupported.");
  if (destination.checkOutput && !destination.checkOutput(result.structuredContent))
    throw invalid("Structured content did not match the declared output schema.");

  if (destination.resultProof) {
    let evidence = result.structuredContent;
    if (!evidence && texts.length === 1) {
      try {
        evidence = JSON.parse(texts[0].text);
      } catch {
        throw invalid("The required result proof is not JSON.");
      }
    }
    if (!destination.resultProof(evidence)) throw invalid("Tool result did not satisfy the required success proof.");
  }
  const output = {
    content: texts.map(({ type, text, annotations, _meta }) => ({
      type,
      text,
      ...(annotations && { annotations }),
      ...(_meta && { _meta }),
    })),
    ...(result.structuredContent && {
      structuredContent: result.structuredContent,
    }),
    ...(result._meta && { _meta: result._meta }),
  };
  if (mixed) {
    const omitted = {};
    for (const block of blocks) {
      if (block.type === "text") continue;
      omitted[block.type] = (omitted[block.type] ?? 0) + 1;
      // Preserve an explicitly returned web reference, without fetching a
      // resource or passing embedded blobs, data URIs or local paths onward.
      const uri = block.type === "resource_link" ? block.uri : block.resource?.uri;
      if (typeof uri === "string" && /^https?:\/\//i.test(uri) && URL.canParse(uri)) {
        const url = new URL(uri);
        if (!url.username && !url.password)
          output.content.push({type:"text", text:JSON.stringify({url:uri, ...(block.type === "resource_link" && {name:block.name})})});
      }
    }
    output.compatibilityWarning = {
      code: "unsupported_content", omitted, responseBytes: bytes,
      // A completion alone cannot satisfy a dependent operation's result
      // requirement. Mixed results may supply a reviewed proof in their
      // retained structured/text portion, never in an omitted block.
      evidenceIncomplete: !destination.resultProof,
      message: "The operation completed, but some returned content is unavailable in this application. It may be available in the connected service.",
    };
  }
  if (Buffer.byteLength(JSON.stringify(output)) > 1024 * 1024)
    throw invalid("Tool result exceeds the 1 MiB limit.");
  // Scrub known credential echoes in individual JSON string leaves, including
  // encoded forms. Preserve verified independent fields and artifact references.
  const safe = safeToolObservation(output);
  if (!values.length || !containsCredential(safe, values)) return safe;
  const forms = [
    ...new Set(
      values.flatMap((v) => [
        v,
        encodeURIComponent(v),
        new URLSearchParams({ v }).toString().slice(2),
        JSON.stringify(v).slice(1, -1),
      ]),
    ),
  ].sort((a, b) => b.length - a.length);
  const scrub = (value) => {
    if (typeof value === "string") {
      for (const form of forms) value = value.replaceAll(form, "[redacted]");
      return value;
    }
    if (Array.isArray(value)) return value.map(scrub);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value)
          .filter(([key]) => !forms.some((form) => key.includes(form)))
          .map(([key, v]) => [key, scrub(v)]),
      );
    return value;
  };
  const sanitized = scrub(safe);
  if (containsCredential(sanitized, values)) throw new McpProblem("sensitive");
  return sanitized;
}
