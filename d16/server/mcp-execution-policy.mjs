import { createHash } from "node:crypto";
import { openSync, fstatSync, readFileSync, closeSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";

export function policyDigest(value) {
  return createHash("sha256")
    .update(
      JSON.stringify(value, (_, v) =>
        v && typeof v === "object" && !Array.isArray(v)
          ? Object.fromEntries(
              Object.keys(v)
                .sort()
                .map((k) => [k, v[k]]),
            )
          : v,
      ),
    )
    .digest("hex");
}

// A scope authorizes a family of calls. A receipt or prerequisite identifies
// one concrete invocation, including its target arguments.
export function invocationGrantId(grant, args, runId) {
  // A new deliberate turn can use a persistent connection grant again; a replay
  // of the same turn retains the one-shot reservation for that invocation.
  if (grant.catalogScope) return policyDigest([policyDigest(grant), runId, args]);
  return grant.argumentSchema ? policyDigest([policyDigest(grant), args]) : policyDigest(grant);
}

// Operator-owned deployment configuration. Session permissions cannot edit or
// override it. Discovery and model output cannot issue grants.
export function readMcpPolicy() {
  const path = process.env.DAY16_MCP_EXECUTION_POLICY_FILE;
  if (!path) return [];
  let fd;
  try {
    fd = openSync(path, "r");
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.size > 262144 ||
      stat.mode & 0o022 ||
      (process.getuid && ![0, process.getuid()].includes(stat.uid))
    )
      return [];
    return JSON.parse(readFileSync(fd, "utf8"));
  } catch {
    return [];
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function attachedCreate(grant, row) {
  // The operator attests to the semantics of this catalog revision. A multiplexed
  // operation must also pin its selector. Discovery hints never issue permission.
  if (grant.sessionScope !== "attached-create" || grant.safety !== "side-effecting" ||
      !grant.argumentSchema || grant.codeTemplate) return false;
  const remote = JSON.parse(row.document).inputSchema;
  const scope = grant.argumentSchema;
  const selectors = Object.keys({...remote.properties,...scope.properties})
    .filter(key => /^(?:action|operation|method|command)$/i.test(key));
  return selectors.every(key => scope.required?.includes(key) &&
    typeof scope.properties?.[key]?.const === "string");
}

export function readGrants(row, read, sessionId, args) {
  try {
    const policy = read(row, args);
    if (!Array.isArray(policy) || policy.length > 512) return [];
    const definition = policyDigest(JSON.parse(row.document));
    return policy.filter(
      (p) =>
        // Reusable capabilities are an explicit deployment choice. The caller
        // supplies only rows attached to this session and rechecks membership.
        (p?.sessionId === sessionId || (p?.sessionId === undefined &&
          ((p?.sessionScope === "attached-read" && p.safety === "read-only") || attachedCreate(p, row)))) &&
        ["read-only", "side-effecting"].includes(p.safety) &&
        // Optional operator-attested, disjoint state domain within this connection.
        // Omitted on legacy and catalog-wide grants: uncertainty then covers the connection.
        (p.stateScope === undefined || (!p.catalogScope && typeof p.stateScope === "string" &&
          /^[a-zA-Z0-9_-]{1,64}$/.test(p.stateScope))) &&
        (p.requires === undefined ||
          (Array.isArray(p.requires) &&
            p.requires.every(
              (id) => typeof id === "string" && /^[0-9a-f]{64}$/.test(id),
            ))) &&
        p.connectionId === row.connectionId &&
        p.toolId === row.toolId &&
        p.revision === row.revision &&
        p.definition === definition &&
        (p.catalogScope !== undefined
          ? p.catalogScope === true && (row.autoApprove ? row.approvedDefinition === definition : p.attachedCatalog === true) &&
            p.sessionId === sessionId && p.safety === "side-effecting" && !p.codeTemplate &&
            p.arguments === undefined && p.argumentSchema === undefined
          : (p.argumentSchema === undefined && !p.codeTemplate && p.arguments &&
            typeof p.arguments === "object" && !Array.isArray(p.arguments)) ||
            (p.arguments === undefined && p.argumentSchema?.type === "object" &&
              p.argumentSchema.additionalProperties === false)),
    );
  } catch {
    return [];
  }
}

// Advertise only reviewed parameter names and narrow scalar choices. Some
// function-declaration APIs reject object-valued enums. The exact tuple and
// original catalog schema are still checked together on every dispatch.
export function approvedInputSchema(schema, grants) {
  if (grants.length === 1 && grants[0].catalogScope) return schema;
  if (grants.some((g) => g.argumentSchema)) {
    // Multiple action scopes may overlap. The original declaration remains valid;
    // the router checks the complete, unique authorization again at dispatch.
    if (grants.length !== 1) return schema;
    const scope = grants[0].argumentSchema;
    const properties = Object.fromEntries(
      Object.entries(scope.properties ?? {}).map(([key, rule]) => {
        const original = schema.properties?.[key] ?? schema.additionalProperties ?? {};
        if (original === false || rule === false) return [key, false];
        return [
          key,
          {
            ...(rule.type && { type: rule.type }),
            ...original,
            ...(Object.hasOwn(rule, "const") && { const: rule.const }),
            description: [
              original.description,
              "Authorized scope: " + JSON.stringify(rule),
            ]
              .filter(Boolean)
              .join(" "),
          },
        ];
      }),
    );
    return {
      ...schema,
      properties,
      additionalProperties: false,
      required: [
        ...new Set([...(schema.required ?? []), ...(scope.required ?? [])]),
      ],
    };
  }
  const tuples = grants.map((g) => g.arguments);
  const keys = new Set(tuples.flatMap(Object.keys));
  const properties = Object.fromEntries(
    [...keys].map((key) => {
      const original =
        schema.properties?.[key] ??
        (typeof schema.additionalProperties === "object"
          ? schema.additionalProperties
          : {});
      const values = tuples
        .filter((a) => Object.hasOwn(a, key))
        .map((a) => a[key]);
      return [
        key,
        values.every((v) => v === null || typeof v !== "object")
          ? { ...original, enum: [...new Set(values)] }
          : original,
      ];
    }),
  );
  return {
    ...schema,
    properties,
    additionalProperties: false,
    required: [...keys].filter((k) => tuples.every((a) => Object.hasOwn(a, k))),
  };
}

// Dynamic grants are operator-reviewed data contracts. For executable source the
// only variable substring is a JSON literal assigned before a fixed reviewed body.
export function compileScope(grant, remoteName, prepare, now) {
  const schema = grant.argumentSchema;
  const scope = prepare(schema, now);
  if (!scope.ok) return;
  const template = grant.codeTemplate;
  if (!template) {
    if (
      remoteName === "execute_code" ||
      Object.keys(schema.properties ?? {}).some((k) =>
        /^(code|script|command)$/i.test(k),
      )
    )
      return;
    return scope.data;
  }
  if (
    typeof template.body !== "string" ||
    !template.body.trim() ||
    schema.properties?.code?.type !== "string" ||
    !schema.required?.includes("code")
  )
    return;
  const input = prepare(template.inputSchema, now);
  if (!input.ok) return;
  const prefix = "const input = ";
  const suffix = ";\n" + template.body;
  return (args) => {
    if (
      !scope.data(args) ||
      !args.code.startsWith(prefix) ||
      !args.code.endsWith(suffix)
    )
      return false;
    try {
      const literal = args.code.slice(prefix.length, -suffix.length);
      const data = JSON.parse(literal);
      return JSON.stringify(data) === literal && input.data(data);
    } catch {
      return false;
    }
  };
}

export function matchGrant(grants, args, scopes) {
  const matches = grants.filter((p) =>
    p.catalogScope || (p.argumentSchema
      ? scopes?.get(policyDigest(p))?.(args)
      : isDeepStrictEqual(p.arguments, args)),
  );
  return matches.length === 1 ? matches[0] : undefined;
}
