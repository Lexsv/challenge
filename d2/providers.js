/* Documented, non-streaming provider wire formats. No credentials are retained. */
"use strict";
window.ExplorerProviders = (() => {
  const C = window.ExplorerCore;
  const schema = () => C.clone(C.defaultFormat.json_schema.schema);
  const presets = {
    openai: {
      name: "OpenAI", defaultModel: "gpt-4.1-mini", available: true,
      models: [["gpt-4o-mini", "Small · GPT-4o mini"], ["gpt-4.1-mini", "Medium · GPT-4.1 mini"], ["gpt-4.1", "Large · GPT-4.1"]],
      note: "Stop + JSON Schema supported by listed models. These models are deprecated; shutdown January 14, 2027. Custom model compatibility is unverified.",
      reserved: ["model", "messages", "stream"],
      endpoint: () => "https://api.openai.com/v1/chat/completions",
      headers: key => ({ Authorization: `Bearer ${key}` }),
      defaults: () => [["max_completion_tokens", "300", false], ["stop", '["END"]', false], ["response_format", JSON.stringify(C.defaultFormat, null, 2), false]],
      body: (model, prompt, parameters) => C.requestBody(model, prompt, parameters),
      verify: model => ({ model, messages: [{ role: "user", content: "Reply OK." }], max_completion_tokens: 8, stream: false }),
      format: body => body.response_format,
      outputs: (raw, format) => C.completions(raw, format),
      usage: raw => raw?.usage ?? null
    },
    gemini: {
      name: "Google Gemini", defaultModel: "gemini-3.5-flash-lite", available: true,
      models: [["gemini-3.5-flash-lite", "Small · Gemini 3.5 Flash-Lite"], ["gemini-3.8-flash", "Medium · Gemini 3.8 Flash"], ["gemini-4-argon", "Large · Gemini 4 Argon"]],
      note: "Rows are generationConfig fields. Stop sequences are API-level. JSON Schema also requires responseMimeType: \"application/json\". Schema support is provider-specific; there is no OpenAI strict flag. Custom model support is unverified.",
      reserved: ["model", "contents", "generationConfig", "systemInstruction", "tools", "toolConfig", "cachedContent", "stream", "messages", "safetySettings"],
      endpoint: model => `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      headers: key => ({ "x-goog-api-key": key }),
      defaults: () => [["maxOutputTokens", "300", false], ["stopSequences", '["END"]', false], ["responseMimeType", '"application/json"', false], ["responseJsonSchema", JSON.stringify(schema(), null, 2), false]],
      body: (model, prompt, parameters) => C.freeze(C.clone({ contents: [{ role: "user", parts: [{ text: prompt }] }], ...(Object.keys(parameters).length ? { generationConfig: parameters } : {}) })),
      verify: () => ({ contents: [{ role: "user", parts: [{ text: "Reply OK." }] }], generationConfig: { maxOutputTokens: 16 } }),
      format: body => Object.hasOwn(body.generationConfig || {}, "responseJsonSchema") ? { type: "json_schema", json_schema: { schema: body.generationConfig.responseJsonSchema } } : undefined,
      outputs: geminiOutputs,
      usage: raw => raw?.usageMetadata ?? null
    },
    anthropic: {
      name: "Anthropic Claude", defaultModel: "claude-haiku-5-5", available: false,
      models: [["claude-haiku-5-5", "Small · Claude Haiku 5.5"], ["claude-sonnet-5-5", "Medium · Claude Sonnet 5.5"], ["claude-opus-5-5", "Large · Claude Opus 5.5"]],
      note: "Unavailable for live requests: Anthropic browser access requires an explicit browser-risk opt-in, which is not enabled. Adapter is mock-tested only. max_tokens is mandatory: keep its row enabled. Stop uses stop_sequences; JSON Schema uses output_config.format.",
      reserved: ["model", "messages", "stream", "system", "tools", "tool_choice"],
      endpoint: () => "https://api.anthropic.com/v1/messages",
      headers: key => ({ "x-api-key": key, "anthropic-version": "2023-06-01" }),
      defaults: () => [["max_tokens", "300", true], ["stop_sequences", '["END"]', false], ["output_config", JSON.stringify({ format: { type: "json_schema", schema: schema() } }, null, 2), false]],
      body: (model, prompt, parameters) => C.freeze(C.clone({ ...parameters, model, messages: [{ role: "user", content: prompt }], stream: false })),
      verify: model => ({ model, max_tokens: 64, messages: [{ role: "user", content: "Reply OK." }], stream: false }),
      format: body => body.output_config?.format?.type === "json_schema" ? { type: "json_schema", json_schema: { schema: body.output_config.format.schema } } : undefined,
      outputs: anthropicOutputs,
      usage: raw => raw?.usage ?? null
    }
  };
  function output(index, text, reason, state, format, refusal = null, error = null, truncated = false) {
    return { index, text, reason, state, refusal, error, truncated, checks: C.outputChecks(text, format) };
  }
  function geminiOutputs(raw, format) {
    if (!Array.isArray(raw?.candidates) || !raw.candidates.length) {
      if (raw?.promptFeedback?.blockReason) return [output(0, null, raw.promptFeedback.blockReason, "Refused — prompt blocked", format, raw.promptFeedback.blockReason)];
      return null;
    }
    return raw.candidates.map((candidate, index) => {
      const parts = candidate?.content?.parts;
      const malformed = !Array.isArray(parts) || parts.some(part => !part || typeof part !== "object" || (Object.hasOwn(part, "text") && typeof part.text !== "string"));
      const texts = malformed ? [] : parts.filter(part => typeof part.text === "string" && part.thought !== true).map(part => part.text);
      const text = texts.length ? texts.join("") : null;
      const reason = typeof candidate?.finishReason === "string" ? candidate.finishReason : "unknown";
      const refused = ["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY"].includes(reason);
      const state = reason === "MAX_TOKENS" ? "Incomplete — token limit reached" : refused ? "Refused — provider content restriction" : malformed ? "Malformed response — missing candidate text parts" : text === null ? "Unexpected response — no textual content" : reason === "STOP" ? "Complete" : "Completion status unknown";
      return output(index, text, reason, state, format, refused ? candidate.finishMessage || reason : null, C.explicitError(candidate), reason === "MAX_TOKENS");
    });
  }
  function anthropicOutputs(raw, format) {
    if (raw?.type !== "message" || !Array.isArray(raw.content)) return null;
    const invalid = raw.content.some(block => !block || typeof block.type !== "string" || (block.type === "text" && typeof block.text !== "string"));
    const texts = raw.content.filter(block => block?.type === "text" && typeof block.text === "string").map(block => block.text);
    const text = texts.length ? texts.join("") : null;
    const reason = typeof raw.stop_reason === "string" ? raw.stop_reason : "unknown";
    const state = reason === "max_tokens" ? "Incomplete — token limit reached" : reason === "refusal" ? "Refused" : reason === "tool_use" ? "Tool call — no final assistant answer" : invalid ? "Malformed response — invalid content block" : text === null ? "Unexpected response — no textual content" : ["end_turn", "stop_sequence"].includes(reason) ? "Complete" : "Completion status unknown";
    return [output(0, text, reason, state, format, reason === "refusal" ? text || "Provider refused the request." : null, null, reason === "max_tokens")];
  }
  function issues(provider, model, parameters) {
    const errors = new Map();
    const fail = (key, message) => errors.set(key, message);
    if (provider === "openai" && /^(o3|o4-mini)(-|$)/.test(model) && Object.hasOwn(parameters, "stop")) fail("stop", "This model does not support stop sequences. Disable the row explicitly.");
    if (provider === "gemini") {
      if (Object.hasOwn(parameters, "responseJsonSchema") && parameters.responseMimeType !== "application/json") fail("responseJsonSchema", 'Enable responseMimeType with "application/json" when requesting a schema.');
      if (/^gemini-(?:3\.[6-9]|[4-9])/.test(model)) for (const key of ["temperature", "topP", "topK"]) if (Object.hasOwn(parameters, key)) fail(key, "This model ignores this sampling control; disable it explicitly instead of sending an ineffective control.");
    }
    if (provider === "anthropic" && (!Number.isInteger(parameters.max_tokens) || parameters.max_tokens <= 0)) fail("max_tokens", "A positive integer max_tokens budget is mandatory. Enable or add that row.");
    const legacy = provider === "gemini" ? ["stop", "max_completion_tokens", "max_tokens", "response_format"] : provider === "anthropic" ? ["stop", "max_completion_tokens", "response_format"] : ["stopSequences", "maxOutputTokens", "responseJsonSchema", "output_config"];
    for (const key of legacy) if (Object.hasOwn(parameters, key)) fail(key, `This is not a ${presets[provider].name} parameter. Use the documented provider-specific field.`);
    return errors;
  }
  function httpError(provider, status, raw) {
    if (provider === "openai") return C.httpError(status, raw);
    if (status === 400 && /API_KEY_INVALID|API_KEY_EXPIRED/.test(JSON.stringify(raw?.error?.details || []))) return "Authentication failed. Check your provider API key.";
    if (status === 401) return "Authentication failed. Check your provider API key.";
    if (status === 403) return "Permission denied. Check API enablement, key restrictions, and model access.";
    if (status === 404) return "Model/resource unavailable. Check the provider-specific model ID and access.";
    if (status === 429) return "Rate limit or quota exhausted. Check provider limits and billing; the available response may not distinguish them.";
    if (status === 529 || status >= 500) return "Provider server error or overload. Try again later.";
    return "Provider rejected the request. Check its parameter support and API error details.";
  }
  return { presets, issues, httpError };
})();
