/* Dependency-free request and output checks; classic script for file:// use. */
"use strict";
window.ExplorerCore = (() => {
  const endpoint = "https://api.openai.com/v1/chat/completions";
  const defaultFormat = {
    type: "json_schema",
    json_schema: {
      name: "answer", strict: true,
      schema: {
        type: "object",
        properties: { answer: { type: "string" }, items: { type: "array", items: { type: "string" } } },
        required: ["answer", "items"], additionalProperties: false
      }
    }
  };
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
  const clone = value => JSON.parse(JSON.stringify(value));
  function freeze(value) {
    if (value && typeof value === "object") {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
    return value;
  }
  const label = prompt => Array.from(prompt).slice(0, 20).join("") + (Array.from(prompt).length > 20 ? "…" : "");

  // Never retain authentication fields or an echoed submitted key in history.
  function redact(value, key = "") {
    function text(input) {
      let result = input;
      if (key) result = result.split(key).join("[REDACTED]");
      return result.replace(/\bsk-[a-zA-Z0-9_-]+/g, "[REDACTED]");
    }
    function walk(input) {
      if (typeof input === "string") return text(input);
      if (Array.isArray(input)) return input.map(walk);
      if (isObject(input)) return Object.fromEntries(Object.entries(input).map(([name, child]) => [text(name), /^(authorization|api[-_]?key|x-(?:goog-)?api-key|access[-_]?token|password|secret)$/i.test(name) ? "[REDACTED]" : walk(child)]));
      return input;
    }
    return walk(value);
  }

  function parameters(rows, reserved = ["model", "messages", "stream"]) {
    const values = Object.create(null), errors = new Map(), seen = new Map();
    rows.forEach((row, index) => {
      if (!row.enabled) return;
      const key = row.key.trim(), raw = row.value.trim();
      if (!key && !raw) return;
      if (!key || !raw) { errors.set(index, "Enter both a key and a JSON value, or disable this row."); return; }
      if (reserved.includes(key)) errors.set(index, `${key} is controlled by the application.`);
      if (/^(authorization|api[-_]?key|x-(?:goog-)?api-key|access[-_]?token|password|secret)$/i.test(key)) errors.set(index, "Credentials belong only in the API Key field.");
      if (seen.has(key)) {
        errors.set(index, "Duplicate enabled key.");
        errors.set(seen.get(key), "Duplicate enabled key.");
      }
      seen.set(key, index);
      try {
        const parsed = JSON.parse(raw);
        JSON.stringify(parsed, (_, value) => {
          if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Nonfinite number");
          return value;
        });
        values[key] = parsed;
      }
      catch { errors.set(index, "Invalid or unrepresentable JSON. Quote strings; check commas, brackets, quotes, and number ranges."); }
    });
    return { values, errors };
  }
  function requestBody(model, prompt, controls) {
    // Object spread preserves literal keys such as __proto__ as ordinary own data.
    return freeze(clone({ ...controls, model, messages: [{ role: "user", content: prompt }], stream: false }));
  }

  // Explicit JSON Schema 2020-12 subset. Audit the entire schema before validating
  // any value, including unused branches. Unknown or malformed features never pass.
  const types = ["object", "array", "string", "number", "integer", "boolean", "null"];
  const keywords = new Set(["$schema", "title", "description", "type", "properties", "required", "additionalProperties", "items", "enum", "const", "minItems", "maxItems", "minLength", "maxLength", "minimum", "maximum"]);
  function schemaIssues(schema, path = "$", depth = 0) {
    if (depth > 64) return ["Schema nesting exceeds the local validator limit (64)."];
    if (typeof schema === "boolean") return [];
    if (!isObject(schema)) return [`${path}: expected a schema object or boolean.`];
    const issues = [];
    for (const key of Object.keys(schema)) if (!keywords.has(key)) issues.push(`${path}: unsupported keyword ${key}.`);
    if (own(schema, "$schema") && !["https://json-schema.org/draft/2020-12/schema", "https://json-schema.org/draft/2020-12/schema#"].includes(schema.$schema)) issues.push(`${path}: unsupported schema dialect.`);
    if (own(schema, "type")) {
      const list = Array.isArray(schema.type) ? schema.type : [schema.type];
      if (!list.length || new Set(list).size !== list.length || list.some(t => !types.includes(t))) issues.push(`${path}: invalid type declaration.`);
    }
    for (const name of ["title", "description"]) if (own(schema, name) && typeof schema[name] !== "string") issues.push(`${path}: ${name} must be a string.`);
    if (own(schema, "properties")) {
      if (!isObject(schema.properties)) issues.push(`${path}: properties must be an object.`);
      else for (const [key, child] of Object.entries(schema.properties)) issues.push(...schemaIssues(child, `${path}.properties.${key}`, depth + 1));
    }
    if (own(schema, "required") && (!Array.isArray(schema.required) || schema.required.some(x => typeof x !== "string") || new Set(schema.required).size !== schema.required.length)) issues.push(`${path}: required must be an array of unique strings.`);
    if (own(schema, "additionalProperties")) issues.push(...schemaIssues(schema.additionalProperties, `${path}.additionalProperties`, depth + 1));
    if (own(schema, "items")) issues.push(...schemaIssues(schema.items, `${path}.items`, depth + 1));
    if (own(schema, "enum") && (!Array.isArray(schema.enum) || !schema.enum.length || schema.enum.some((x, i) => schema.enum.slice(0, i).some(y => equal(x, y))))) issues.push(`${path}: enum must contain unique values and be nonempty.`);
    for (const key of ["minItems", "maxItems", "minLength", "maxLength"]) if (own(schema, key) && (!Number.isInteger(schema[key]) || schema[key] < 0)) issues.push(`${path}: ${key} must be a nonnegative integer.`);
    for (const key of ["minimum", "maximum"]) if (own(schema, key) && (typeof schema[key] !== "number" || !Number.isFinite(schema[key]))) issues.push(`${path}: ${key} must be a finite number.`);
    return issues;
  }
  function equal(a, b) {
    if (a === b) return true;
    if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((value, i) => equal(value, b[i]));
    if (isObject(a) && isObject(b)) return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(key => own(b, key) && equal(a[key], b[key]));
    return false;
  }
  function matchesType(value, type) {
    if (type === "object") return isObject(value);
    if (type === "array") return Array.isArray(value);
    if (type === "null") return value === null;
    if (type === "integer") return Number.isInteger(value);
    return typeof value === type;
  }
  function validate(value, schema, path = "$", errors = [], depth = 0) {
    if (depth > 128) { errors.push(`${path}: value nesting exceeds local limit (128).`); return errors; }
    if (schema === false) { errors.push(`${path}: disallowed by schema.`); return errors; }
    if (schema === true) return errors;
    if (own(schema, "type") && !(Array.isArray(schema.type) ? schema.type : [schema.type]).some(t => matchesType(value, t))) { errors.push(`${path}: expected ${[].concat(schema.type).join(" or ")}.`); return errors; }
    if (own(schema, "enum") && !schema.enum.some(item => equal(item, value))) errors.push(`${path}: value is outside enum.`);
    if (own(schema, "const") && !equal(value, schema.const)) errors.push(`${path}: value differs from const.`);
    if (isObject(value)) {
      for (const key of schema.required || []) if (!own(value, key)) errors.push(`${path}.${key}: required property missing.`);
      for (const [key, child] of Object.entries(value)) {
        if (schema.properties && own(schema.properties, key)) validate(child, schema.properties[key], `${path}.${key}`, errors, depth + 1);
        else if (own(schema, "additionalProperties")) validate(child, schema.additionalProperties, `${path}.${key}`, errors, depth + 1);
      }
    }
    if (Array.isArray(value)) {
      if (own(schema, "minItems") && value.length < schema.minItems) errors.push(`${path}: too few items.`);
      if (own(schema, "maxItems") && value.length > schema.maxItems) errors.push(`${path}: too many items.`);
      if (own(schema, "items")) value.forEach((item, i) => validate(item, schema.items, `${path}[${i}]`, errors, depth + 1));
    }
    if (typeof value === "string") {
      const length = Array.from(value).length;
      if (own(schema, "minLength") && length < schema.minLength) errors.push(`${path}: string is too short.`);
      if (own(schema, "maxLength") && length > schema.maxLength) errors.push(`${path}: string is too long.`);
    }
    if (typeof value === "number") {
      if (own(schema, "minimum") && value < schema.minimum) errors.push(`${path}: below minimum.`);
      if (own(schema, "maximum") && value > schema.maximum) errors.push(`${path}: above maximum.`);
    }
    return errors;
  }
  function outputChecks(text, format) {
    const requested = format?.type === "json_schema";
    const result = {
      parse: "Not checked: no generated text.",
      schema: requested ? "Not performed — no generated text." : "Not requested (no JSON Schema submitted).",
      formatStatus: requested ? "Format validation not performed — no generated text." : null,
      formatError: false
    };
    if (typeof text !== "string") return result;
    let parsed;
    try { parsed = JSON.parse(text); result.parse = "Pass — exact generated text is valid JSON."; }
    catch (error) {
      // Browser SyntaxError may quote generated content; only expose its position.
      const position = /position (\d+)/i.exec(String(error.message));
      result.parse = `Fail — invalid JSON${position ? ` at position ${position[1]}` : ""}. No fences were removed and no repairs were attempted.`;
      if (requested) {
        result.schema = "Not performed — invalid JSON";
        result.formatStatus = "Response format error";
        result.formatError = true;
      }
      return result;
    }
    if (requested) {
      try {
        const schema = format.json_schema?.schema, issues = schemaIssues(schema);
        if (issues.length) {
          result.schema = `Unsupported — local validator cannot check this schema: ${issues.join(" ")}`;
          result.formatStatus = "Format validation unsupported";
        }
        else {
          const errors = validate(parsed, schema);
          if (errors.some(error => error.includes("exceeds local limit"))) {
            result.schema = `Unsupported — ${errors.join(" ")}`;
            result.formatStatus = "Format validation unsupported";
          } else {
            result.schema = errors.length ? `Fail — ${errors.join(" ")}` : "Pass — matches the submitted schema (supported local subset).";
            result.formatError = errors.length > 0;
            result.formatStatus = errors.length ? "Response format error" : "Format valid";
          }
        }
      } catch {
        result.schema = "Unsupported — schema or data exceeds local validator limits.";
        result.formatStatus = "Format validation unsupported";
      }
    }
    return result;
  }
  function httpError(status, data) {
    const code = data?.error?.code, type = data?.error?.type;
    if (status === 401) return "Authentication failed. Invalid API key. Check the key and try again.";
    if (status === 403) return "Permission denied. Check project permissions and model access.";
    if (status === 404) return "Model or resource unavailable. Check the model ID and your project's access.";
    if (status === 429) return ["insufficient_quota", "billing_hard_limit_reached"].includes(code) || type === "insufficient_quota" ? "Quota or billing limit reached. Check billing and project limits." : "Rate limit reached. Wait before trying again; check project limits if it persists.";
    if (status === 408 || status === 504) return "The API timed out. Try again manually.";
    if (status >= 500) return "OpenAI server error. Try again later.";
    return "API rejected the request. Check parameters and model compatibility.";
  }
  function explicitError(data) {
    if (!isObject(data) || !own(data, "error") || data.error == null) return null;
    const error = data.error;
    return `API error: ${typeof error === "string" ? error : typeof error?.message === "string" ? error.message : JSON.stringify(error)}`;
  }
  function completions(data, format) {
    if (!Array.isArray(data?.choices) || !data.choices.length) return null;
    return data.choices.map((choice, index) => {
      const message = choice?.message, text = message?.content, refusal = message?.refusal;
      const reason = typeof choice?.finish_reason === "string" ? choice.finish_reason : "unknown";
      const error = explicitError(choice) || explicitError(message);
      let state = "Complete";
      if (reason === "length") state = "Incomplete — token limit reached";
      else if (explicitError(data) || error) state = "API error";
      else if (typeof refusal === "string" && refusal) state = "Refused";
      else if (reason === "content_filter") state = "Incomplete — content filtered";
      else if (["tool_calls", "function_call"].includes(reason)) state = "Tool call — no final assistant answer";
      else if (!isObject(message) || message.role !== "assistant") state = "Malformed response — expected an assistant message";
      else if (refusal != null && typeof refusal !== "string") state = "Malformed response — invalid refusal information";
      else if (typeof text !== "string") state = "Unexpected response — no textual content";
      else if (reason !== "stop") state = "Completion status unknown";
      return { index, text: typeof text === "string" ? text : null, refusal: typeof refusal === "string" ? refusal : null, reason, state, error, truncated: reason === "length", checks: outputChecks(typeof text === "string" ? text : null, format) };
    });
  }
  return { endpoint, defaultFormat, clone, freeze, label, redact, parameters, requestBody, schemaIssues, outputChecks, httpError, explicitError, completions };
})();
