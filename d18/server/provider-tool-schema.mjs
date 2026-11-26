import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { executionError } from "../src/execution-policy.ts";

import { supportedPattern } from "./schema-pattern.mjs";

const scalar = { type: ["string", "number", "boolean", "null"] };
const count = { type: "integer", minimum: 0 };
const child = { $ref: "#" };
const dialects = new Set([
  "http://json-schema.org/draft-07/schema#",
  "https://json-schema.org/draft/2020-12/schema",
]);
// Positive list for our three function-declaration transports. Only dialect-neutral
// constraints with identical local validation semantics are admitted. Unknown
// keywords (including remote refs and custom formats) fail closed.
const profile = {
  type: "object",
  additionalProperties: false,
  properties: {
    type: {
      enum: [
        "object",
        "array",
        "string",
        "number",
        "integer",
        "boolean",
        "null",
      ],
    },
    title: { type: "string" },
    description: { type: "string" },
    default: {},
    examples: { type: "array" },
    // Common nullable field form emitted by Pydantic catalogs.
    anyOf: {type:"array",minItems:2,maxItems:2,items:child,contains:{type:"object",required:["type"],properties:{type:{const:"null"}},additionalProperties:false}},
    properties: { type: "object", additionalProperties: child },
    required: { type: "array", uniqueItems: true, items: { type: "string" } },
    additionalProperties: { anyOf: [{ type: "boolean" }, child] },
    items: child,
    enum: { type: "array", minItems: 1, uniqueItems: true, items: scalar },
    const: scalar,
    minimum: { type: "number" },
    maximum: { type: "number" },
    exclusiveMinimum: { type: "number" },
    exclusiveMaximum: { type: "number" },
    multipleOf: { type: "number", exclusiveMinimum: 0 },
    format: { const: "date-time" },
    pattern: { type: "string", maxLength: 2048 },
    minLength: count,
    maxLength: count,
    minItems: count,
    maxItems: count,
    minProperties: count,
    maxProperties: count,
    uniqueItems: { type: "boolean" },
  },
};
const checkProfile = new AjvJsonSchemaValidator().getValidator(profile);

// Validate JSON trees before compiling untrusted catalogs or validating arguments.
// The SDK's AJV uses JavaScript property lookup. Reject reserved object keys and
// use null-prototype objects so inherited properties cannot satisfy a required key.
const pointer = (path, key) => path + "/" + String(key).replaceAll("~", "~0").replaceAll("/", "~1");
function incompatible(path, rule) {
  const error = new Error(rule);
  error.schemaPath = path;
  throw error;
}
function jsonTree(value, depth = 0, budget = { remaining: 12000 }, path = "") {
  if (depth > 48 || --budget.remaining < 0) incompatible(path, "JSON depth or node limit exceeded.");
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return value;
  if (Array.isArray(value))
    return Array.from(value, (item, i) => jsonTree(item, depth + 1, budget, pointer(path, i)));
  if (
    !value ||
    typeof value !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    incompatible(path, "Expected a JSON value.");
  const out = Object.create(null);
  for (const [key, item] of Object.entries(value)) {
    if (Object.hasOwn(Object.prototype, key) || key === "prototype")
      incompatible(pointer(path, key), "Reserved object key.");
    out[key] = jsonTree(item, depth + 1, budget, pointer(path, key));
  }
  return out;
}

// Ask the same profile about individual keywords only on the rejection path.
function explainProfile(schema, path = "") {
  for (const [key, value] of Object.entries(schema)) {
    const at = pointer(path, key);
    if (!Object.hasOwn(profile.properties, key)) incompatible(at, "Keyword is outside the supported profile.");
    const check = checkProfile({ [key]: value });
    if (check.valid) continue;
    if (key === "anyOf" && Array.isArray(value)) {
      if (value.length !== 2 || !value.some(v => v?.type === "null" && Object.keys(v).length === 1))
        incompatible(at, "Expected exactly two alternatives including a null-only branch.");
    }
    let children = [];
    if ((key === "properties" && value && typeof value === "object" && !Array.isArray(value)) ||
        (key === "anyOf" && Array.isArray(value))) children = Object.entries(value);
    else if (key === "items" || key === "additionalProperties") children = [["", value]];
    for (const [name, child] of children) {
      const childPath = key === "properties" || key === "anyOf" ? pointer(at, name) : at;
      if (!child || typeof child !== "object" || Array.isArray(child))
        incompatible(childPath, key === "additionalProperties" ? "Expected a boolean or schema object." : "Expected a schema object.");
      if (!checkProfile(child).valid) explainProfile(child, childPath);
    }
    const rule = profile.properties[key];
    if (rule.const !== undefined) incompatible(at, `Only ${JSON.stringify(rule.const)} is supported.`);
    if (key === "type") incompatible(at, "Expected a single JSON Schema primitive type name.");
    incompatible(at, check.errorMessage?.replace(/^data[^ ]* /, "") ?? "Invalid keyword value.");
  }
  incompatible(path, "Expected a schema object.");
}

function checkPatterns(schema, path = "") {
  if (!schema || typeof schema !== "object") return;
  if (Object.hasOwn(schema, "pattern") && !supportedPattern(schema.pattern))
    incompatible(pointer(path, "pattern"), "Pattern is outside the bounded regular expression profile.");
  for (const [key, child] of Object.entries(schema.properties ?? {}))
    checkPatterns(child, pointer(path + "/properties", key));
  for (const [index, child] of (schema.anyOf ?? []).entries()) checkPatterns(child, path + "/anyOf/" + index);
  checkPatterns(schema.items, path + "/items");
  checkPatterns(schema.additionalProperties, path + "/additionalProperties");
}

// Each compiled catalog is scoped to the run. No global cache of untrusted schemas.
export function createProviderInputValidator(provider) {
  const compiler = new AjvJsonSchemaValidator();
  return function prepareProviderInput(schema, now) {
    let diagnostic = "Unsupported provider or root schema.";
    try {
      if (!["openai", "opencode-console", "opencode-go"].includes(provider)) incompatible("", "Unsupported provider profile.");
      if (schema?.type !== "object") incompatible("/type", "The root schema must declare type object.");
      diagnostic = "Schema exceeds the admitted JSON structure or dialect.";
      const json = jsonTree(schema);
      // The admitted assertion keywords have the same semantics in both
      // dialects. Remove the declaration only on the private AJV compile copy.
      // The provider and catalog retain the full original declaration.
      if (Object.hasOwn(json, "$schema")) {
        if (!dialects.has(json.$schema)) incompatible("/$schema", "Unsupported JSON Schema dialect.");
        delete json.$schema;
      }
      diagnostic = "Schema keyword or keyword value is outside the supported profile.";
      if (!checkProfile(json).valid) explainProfile(json);
      diagnostic = "Pattern is outside the bounded regular expression profile.";
      checkPatterns(json);
      diagnostic = "Schema could not be compiled.";
      const validate = compiler.getValidator(json);
      return {
        ok: true,
        data: (args) => {
          try {
            return validate(jsonTree(args)).valid;
          } catch {
            return false;
          }
        },
      };
    } catch (failure) {
      const schemaPath = failure.schemaPath ?? "";
      return {
        ok: false,
        error: {...executionError(
          "unsupported_schema",
          "provider-adapter",
          "compatibility",
          now,
        ), schemaPath, diagnostic: failure.schemaPath !== undefined ? failure.message : diagnostic},
      };
    }
  };
}
