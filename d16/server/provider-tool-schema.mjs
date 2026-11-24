import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { executionError } from "../src/execution-policy.ts";

const scalar = { type: ["string", "number", "boolean", "null"] };
const count = { type: "integer", minimum: 0 };
const child = { $ref: "#" };
const dialects = new Set([
  "http://json-schema.org/draft-07/schema#",
  "https://json-schema.org/draft/2020-12/schema",
]);
// Positive list for our three function-declaration transports. Only dialect-neutral
// constraints with identical local validation semantics are admitted. Unknown
// keywords (including remote refs, regexes and custom formats) fail closed.
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
function jsonTree(value, depth = 0, budget = { remaining: 12000 }) {
  if (depth > 48 || --budget.remaining < 0) throw Error();
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return value;
  if (Array.isArray(value))
    return Array.from(value, (item) => jsonTree(item, depth + 1, budget));
  if (
    !value ||
    typeof value !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw Error();
  const out = Object.create(null);
  for (const [key, item] of Object.entries(value)) {
    if (Object.hasOwn(Object.prototype, key) || key === "prototype")
      throw Error();
    out[key] = jsonTree(item, depth + 1, budget);
  }
  return out;
}

// Each compiled catalog is scoped to the run. No global cache of untrusted schemas.
export function createProviderInputValidator(provider) {
  const compiler = new AjvJsonSchemaValidator();
  return function prepareProviderInput(schema, now) {
    try {
      if (
        !["openai", "opencode-console", "opencode-go"].includes(provider) ||
        schema?.type !== "object"
      )
        throw Error();
      const json = jsonTree(schema);
      // The admitted assertion keywords have the same semantics in both
      // dialects. Remove the declaration only on the private AJV compile copy.
      // The provider and catalog retain the full original declaration.
      if (Object.hasOwn(json, "$schema")) {
        if (!dialects.has(json.$schema)) throw Error();
        delete json.$schema;
      }
      if (!checkProfile(json).valid) throw Error();
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
    } catch {
      return {
        ok: false,
        error: executionError(
          "unsupported_schema",
          "provider-adapter",
          "compatibility",
          now,
        ),
      };
    }
  };
}
