// The local owner verifies the semantics of each enabled operation. The catalog
// supplies its shape; neither discovery hints nor model output can grant access.
import {
  policyDigest,
  readMcpPolicy,
  readGrants,
} from "./mcp-execution-policy.mjs";
import { sessionCatalogRows } from "./mcp-repository.mjs";
import { createProviderInputValidator } from "./provider-tool-schema.mjs";
import { localUiRequest, readConfig } from "./mcp-routes.mjs";

const readActions = new Set([
  "list",
  "get",
  "retrieve",
  "search",
  "count",
  "lookup",
  "retrieve_by_identifier",
]);
// Credential, role and policy management stay interactive even when a service
// exposes them through an otherwise ordinary create or list selector.
const privileged =
  /(?:^|[_-])(?:admin|auth|credential|key|permission|policy|role|secret|token|webhook|workspace_settings)s?(?:$|[_-])/i;
const selectorNames = new Set(["action", "operation", "method"]);
const restrictedField =
  /(?:password|secret|token|authorization|credential|permission|privilege|admin|roles?|script|command|code|sql|url|headers?)(?:_|$)/i;

export function deploymentManaged(policy = readMcpPolicy) {
  const grants = policy();
  return (
    !!process.env.DAY16_MCP_EXECUTION_POLICY_FILE ||
    !Array.isArray(grants) ||
    grants.length > 0
  );
}

export function sessionPolicy(db, session, policy, localExecution = false) {
  // Only needed when a deployment policy and a narrower session policy coexist.
  // Reuse the same backend JSON Schema validator used by the tool router.
  let compile;
  const validators = new Map();
  return (row, args) => {
    const definition =
      row.document && policyDigest(JSON.parse(row.document));
    if (
      row.autoApprove &&
      (!definition || row.approvedDefinition !== definition)
    )
      return [];
    const deployment = policy();
    const managed =
      !!process.env.DAY16_MCP_EXECUTION_POLICY_FILE ||
      !Array.isArray(deployment) ||
      deployment.length > 0;
    const saved = db
      .prepare(
        "SELECT grants FROM session_mcp_permissions WHERE session_id=? AND connection_id=?",
      )
      .get(session, row.connectionId);
    if (managed) {
      if (saved) {
        const grants = readGrants(row, () => JSON.parse(saved.grants), session);
        if (
          !grants.some((grant) => {
            if (args === undefined) return true;
            const key = policyDigest(grant.argumentSchema);
            if (!validators.has(key)) {
              compile ??= createProviderInputValidator("openai"); // All supported providers share this validation profile.
              validators.set(key, compile(grant.argumentSchema, Date.now()));
            }
            const result = validators.get(key);
            return result.ok && result.data(args);
          })
        )
          return [];
      }
      return deployment;
    }
    // An explicit session scope (including an empty one) narrows connection consent.
    if (saved) return JSON.parse(saved.grants);
    if (!row.autoApprove && !localExecution) return [];
    return [
      {
        sessionId: session,
        connectionId: row.connectionId,
        toolId: row.toolId,
        revision: row.revision,
        definition,
        catalogScope: true,
        ...(!row.autoApprove && { attachedCatalog: true }),
        safety: "side-effecting",
      },
    ];
  };
}

function choices(row) {
  if (
    !row.toolId ||
    privileged.test(row.originalName.replace(/([a-z])([A-Z])/g, "$1_$2")) ||
    row.deleting ||
    row.endpointConflict ||
    row.needsRefresh ||
    row.syncError
  )
    return [];
  const doc = JSON.parse(row.document);
  const schema = doc.inputSchema;
  const props = schema?.properties ?? {};
  const selectors = Object.keys(props).filter((key) => selectorNames.has(key));
  if (
    selectors.length !== 1 ||
    Object.keys(props).some((key) => /^(?:code|script|command)$/i.test(key))
  )
    return [];
  const [selector] = selectors;
  const verbs = props[selector]?.enum;
  if (
    !Array.isArray(verbs) ||
    !Array.isArray(schema.required) ||
    !schema.required.includes(selector)
  )
    return [];
  const fields = Object.entries(props)
    .filter(
      ([key, value]) =>
        key !== selector &&
        /^[a-zA-Z][\w-]{0,63}$/.test(key) &&
        !Object.hasOwn(Object.prototype, key) &&
        !selectorNames.has(key) &&
        !/^(?:mode|verb|op)$/i.test(key) &&
        !restrictedField.test(key) &&
        !privileged.test(key) &&
        ["integer", "number", "boolean", "string"].includes(value?.type),
    )
    .map(([key]) => key);
  const pinnable = fields.filter((key) => props[key].type === "string");
  const required = schema.required.filter((key) => key !== selector);
  if (!required.every((key) => fields.includes(key))) return [];
  return verbs
    .filter((action) => readActions.has(action) || action === "create")
    .map((action) => ({
      toolId: row.toolId,
      name: row.originalName,
      selector,
      action,
      fields,
      pinnable,
      required,
      safety: action === "create" ? "side-effecting" : "read-only",
      revision: row.revision,
      definition: policyDigest(doc),
    }));
}

export function createSessionPermissionRoute(db, policy = readMcpPolicy) {
  const saved = db.prepare(
    "SELECT grants FROM session_mcp_permissions WHERE session_id=? AND connection_id=?",
  );
  function snapshot(session, connection) {
    const rows = sessionCatalogRows(db, session).filter(
      (row) => row.connectionId === connection,
    );
    if (!rows.length) return;
    const autoApprove = !!rows[0].autoApprove;
    const options = rows
      .filter(
        (row) =>
          !autoApprove ||
          (row.document &&
            row.approvedDefinition === policyDigest(JSON.parse(row.document))),
      )
      .flatMap(choices);
    const stored = saved.get(session, connection);
    const grants = JSON.parse(stored?.grants ?? "[]");
    const inherit = autoApprove && !stored;
    const selected = options.flatMap((o) => {
      const g = grants.find(
        (g) =>
          g.toolId === o.toolId &&
          g.revision === o.revision &&
          g.definition === o.definition &&
          g.argumentSchema.properties[o.selector]?.const === o.action,
      );
      return g
        ? [
            {
              toolId: o.toolId,
              action: o.action,
              fields: Object.keys(g.argumentSchema.properties).filter(
                (k) => k !== o.selector,
              ),
              fixed: Object.fromEntries(
                Object.entries(g.argumentSchema.properties)
                  .filter(
                    ([k, v]) => k !== o.selector && Object.hasOwn(v, "const"),
                  )
                  .map(([k, v]) => [k, v.const]),
              ),
            },
          ]
        : [];
    });
    return {
      revision: policyDigest([
        options,
        grants,
        autoApprove,
        inherit,
        rows.map((r) => r.approvedDefinition),
      ]),
      options,
      selected,
      autoApprove,
      inherit,
    };
  }
  function update(session, connection, body, state) {
    const send = (status, data) => [status, data];
    if (body?.revision !== state.revision)
      return send(409, {
        error: "Catalog or permissions changed. Reopen permissions.",
      });
    if (!Array.isArray(body.selected) || body.selected.length > 64)
      return send(400, { error: "Invalid permission selection." });
    if (body.inherit === true) {
      if (!state.autoApprove || body.selected.length)
        return send(400, { error: "Invalid connection scope selection." });
      db.prepare(
        "DELETE FROM session_mcp_permissions WHERE session_id=? AND connection_id=?",
      ).run(session, connection);
      return send(200, { saved: true });
    }
    const grants = [],
      unique = new Set();
    for (const item of body.selected) {
      const o = state.options.find(
        (o) => o.toolId === item?.toolId && o.action === item.action,
      );
      const key = o && o.toolId + "/" + o.action;
      if (
        !o ||
        unique.has(key) ||
        !Array.isArray(item.fields) ||
        !item.fields.every((k) => o.fields.includes(k)) ||
        !o.required.every((k) => item.fields.includes(k))
      )
        return send(400, { error: "Unsupported operation or argument scope." });
      unique.add(key);
      const fixed = item.fixed ?? {};
      if (
        typeof fixed !== "object" ||
        Array.isArray(fixed) ||
        !Object.entries(fixed).every(
          ([k, v]) =>
            item.fields.includes(k) &&
            o.pinnable.includes(k) &&
            typeof v === "string" &&
            /^[\p{L}\p{N}._ -]{1,128}$/u.test(v),
        )
      )
        return send(400, { error: "Invalid fixed argument." });
      const properties = Object.fromEntries(
        item.fields.map((k) => [
          k,
          Object.hasOwn(fixed, k) ? { const: fixed[k] } : {},
        ]),
      );
      properties[o.selector] = { type: "string", const: o.action };
      grants.push({
        sessionId: session,
        connectionId: connection,
        toolId: o.toolId,
        revision: o.revision,
        definition: o.definition,
        safety: o.safety,
        argumentSchema: {
          type: "object",
          properties,
          required: [
            ...new Set([o.selector, ...o.required, ...Object.keys(fixed)]),
          ],
          additionalProperties: false,
        },
      });
    }
    db.prepare(
      `INSERT INTO session_mcp_permissions VALUES(?,?,?)
      ON CONFLICT(session_id,connection_id) DO UPDATE SET grants=excluded.grants`,
    ).run(session, connection, JSON.stringify(grants));
    return send(200, { saved: true });
  }
  return async (req, path, reply) => {
    const match = path.match(
      /^\/api\/week4\/sessions\/([a-f0-9-]{36})\/mcp-connections\/([a-f0-9-]{36})\/permissions$/,
    );
    if (!match) return false;
    const [, session, connection] = match;
    const send = (status, body) => {
      reply(status, body);
      return true;
    };
    if (deploymentManaged(policy))
      return send(403, {
        error: "The deployment policy manages these permissions.",
      });
    if (req.method !== "GET" && req.method !== "PUT")
      return send(405, { error: "Unsupported method." });
    if (
      !localUiRequest(req, "permissions") ||
      req.headers["x-day16-ui"] !== "permissions" ||
      (req.method === "PUT" &&
        req.headers.origin !== "http://" + req.headers.host)
    )
      return send(403, {
        error: "Open permissions in the local session settings.",
      });
    let body;
    if (req.method === "PUT") {
      try {
        body = await readConfig(req);
      } catch {
        return send(400, { error: "Invalid permission settings." });
      }
    }
    const missing = { error: "Connection is not attached to this session." };
    if (req.method === "GET") {
      const state = snapshot(session, connection);
      return state ? send(200, state) : send(404, missing);
    }
    if (deploymentManaged(policy))
      return send(403, {
        error: "The deployment policy manages these permissions.",
      });
    db.exec("BEGIN IMMEDIATE");
    let result;
    try {
      const state = snapshot(session, connection);
      result = state
        ? update(session, connection, body, state)
        : [404, missing];
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return send(...result);
  };
}
