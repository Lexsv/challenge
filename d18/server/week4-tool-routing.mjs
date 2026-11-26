import {
  compileScope,
  readGrants,
  matchGrant,
  policyDigest,
  invocationGrantId,
  approvedInputSchema,
} from "./mcp-execution-policy.mjs";
import { createProviderInputValidator } from "./provider-tool-schema.mjs";
import { buildProviderToolNameMap } from "../src/manager-llm-adapter.ts";
import { executionError } from "../src/execution-policy.ts";
import { adaptMcpTool } from "./mcp-tool-adapter.mjs";
import { sessionCatalogRows } from "./mcp-repository.mjs";

export function catalogIssue(row, now) {
  if (row.deleting || row.syncError === "permission") return "authorization";
  if (row.syncError === "authentication" || row.syncError === "credential")
    return "authentication";
  if (
    row.endpointConflict ||
    row.needsRefresh ||
    row.lastSuccess == null ||
    now - row.lastSuccess > 86400000
  )
    return "route_changed";
}

// All dependencies are server-owned and bound by createWeek4Execution.begin.
// The caller supplies the Manager's per-turn registry (including any memory tool)
// and the same session memory object used for selected-record-only requests.
export function resolveWeek4Tools({
  db,
  provider,
  registry,
  memory,
  customCurrent,
  catalog: suppliedCatalog,
  scope,
  attempt,
  policy,
  now,
}) {
  const context = scope();
  const catalog=suppliedCatalog ?? (id=>sessionCatalogRows(db,context.sessionId,id));
  const issue = (code, source, stage, ids = {}) => ({
    ok: false,
    error: {
      ...executionError(code, source, stage, now()),
      ...context,
      ...ids,
    },
  });
  if (!context || !registry)
    return issue("authorization", "resolver", "resolution");
  const permitted = () => !memory?.usesSelectedRecordsOnly;
  const entries = new Map();
  const ambiguous = new Set();
  const errors = [];
  const connections = new Map();
  function add(entry) {
    const id = entry.tool.id;
    if (entries.delete(id) || ambiguous.has(id)) {
      ambiguous.add(id);
      errors.push(
        issue("ambiguous_tool", "resolver", "resolution", { toolId: id }).error,
      );
    } else entries.set(id, entry);
  }
  if (permitted()) {
    for (const tool of registry.listExecutable()) {
      const implementation = registry.get(tool.id);
      if (!tool.executable || !tool.inputSchema || !implementation) continue;
      if (tool.kind === "user-defined") {
        try {
          if (!customCurrent(tool.id)) {
            errors.push(
              issue("authorization", "resolver", "resolution", {
                toolId: tool.id,
              }).error,
            );
            continue;
          }
        } catch {
          errors.push(
            issue("persistence", "storage", "resolution", { toolId: tool.id })
              .error,
          );
          continue;
        }
      }
      add({ tool, implementation });
    }
    let rows = [];
    try {
      rows = catalog();
    } catch {
      errors.push(issue("persistence", "storage", "resolution").error);
    }
    const skipped = new Set();
    let prepareInput;
    for (const row of rows) {
      connections.set(row.connectionId, row.connectionName);
      const ids = { connectionId: row.connectionId };
      const problem = catalogIssue(row, now());
      if (problem) {
        if (!skipped.has(row.connectionId))
          errors.push(issue(problem, "resolver", "resolution", ids).error);
        skipped.add(row.connectionId);
        continue;
      }
      if (!row.toolId) continue;
      ids.toolId = row.toolId;
      const adapted = adaptMcpTool(row, now());
      if (!adapted.ok) {
        errors.push({ ...adapted.error, ...context, ...ids });
        continue;
      }
      prepareInput ??= createProviderInputValidator(provider);
      const prepared = prepareInput(adapted.data.inputSchema, now());
      if (!prepared.ok) {
        errors.push({ ...prepared.error, ...context, ...ids, schemaSide: "input" });
        continue;
      }
      const scopes = new Map();
      const grants =
        policy &&
        readGrants(row, policy, context.sessionId).filter((g) => {
          if (g.catalogScope) return true; // The full pinned catalog schema is validated at dispatch.
          if (!g.argumentSchema) return prepared.data(g.arguments);
          const validate = compileScope(
            g,
            row.originalName,
            prepareInput,
            now(),
          );
          if (validate) scopes.set(policyDigest(g), validate);
          return !!validate;
        });
      if (grants && !grants.length) {
        errors.push(
          issue("authorization", "resolver", "resolution", ids).error,
        );
        continue;
      }
      let checkOutput;
      if (policy && adapted.data.outputSchema) {
        const validator = prepareInput(adapted.data.outputSchema, now());
        if (!validator.ok) {
          errors.push({ ...validator.error, ...context, ...ids, schemaSide: "output" });
          continue;
        }
        checkOutput = validator.data;
      }
      // A reviewed action may need stronger proof of success than a text-only
      // protocol acknowledgement. Compile that local contract before offering it.
      const proofs = new Map();
      if (grants)
        for (let i = grants.length - 1; i >= 0; i--) {
          const grant = grants[i];
          if (grant.resultSchema === undefined) continue;
          const proof = prepareInput(grant.resultSchema, now());
          if (proof.ok) proofs.set(policyDigest(grant), proof.data);
          else {
            errors.push({ ...proof.error, ...context, ...ids });
            grants.splice(i, 1);
          }
        }
      if (grants && !grants.length) continue;
      const tool = grants
        ? {
            ...adapted.data,
            description: [
              row.connectionName + " / " + row.originalName,
              adapted.data.description,
              ...((grants.length > 1) && grants.some((g) => g.argumentSchema)
                ? [
                    "Authorized alternatives: " +
                      JSON.stringify(
                        grants.map(
                          (g) => g.argumentSchema ?? { exact: g.arguments },
                        ),
                      ),
                  ]
                : []),
              ...grants
                .filter((g) => g.codeTemplate)
                .map(
                  (g) =>
                    "Approved code format: const input = <compact JSON object>;\n" +
                    g.codeTemplate.body +
                    "\nInput contract: " +
                    JSON.stringify(g.codeTemplate.inputSchema),
                ),
            ].join("\n"),
            inputSchema: approvedInputSchema(adapted.data.inputSchema, grants),
          }
        : adapted.data;
      add({
        tool,
        row,
        validate: prepared.data,
        grants,
        scopes,
        checkOutput,
        proofs,
      });
    }
  }
  const tools = [...entries.values()].map((entry) => entry.tool);
  const { nameToId, idToName } = buildProviderToolNameMap(tools);
  // Only registered wire aliases can enter this boundary. No parsing, fallback
  // to raw UUID/name, or execution callback is available on a resolved route.
  function lookup(alias, args) {
    const id = nameToId.get(
      typeof alias === "string" ? alias : alias?.providerName,
    );
    if (alias && typeof alias === "object" && id !== alias.toolId)
      return issue("unknown_tool", "router", "routing");
    const entry = entries.get(id);
    if (!scope() || !permitted())
      return issue("authorization", "router", "routing");
    if (!entry) return issue("unknown_tool", "router", "routing");
    const { tool } = entry;
    const mcp = tool.kind === "mcp";
    const ids = {
      toolId: mcp ? tool.toolId : id,
      ...(mcp && { connectionId: tool.connectionId }),
    };
    let grant;
    if (mcp) {
      let row;
      try {
        [row] = catalog(tool.toolId);
      } catch {
        return issue("persistence", "storage", "routing", ids);
      }
      if (!row || row.connectionId !== tool.connectionId || row.deleting)
        return issue("authorization", "router", "routing", ids);
      const problem = catalogIssue(row, now());
      if (problem) return issue(problem, "router", "routing", ids);
      if (
        row.document !== entry.row.document ||
        row.revision !== entry.row.revision
      )
        return issue("route_changed", "router", "routing", ids);
      if (policy) {
        if (!entry.validate(args)) return issue("invalid_arguments", "router", "validation", ids);
        const offered = matchGrant(entry.grants, args, entry.scopes);
        grant = matchGrant(readGrants(row, policy, context.sessionId, args), args, entry.scopes);
        if (!grant || !offered || policyDigest(grant) !== policyDigest(offered))
          return {...issue("authorization", "router", "routing", ids), validation:"passed"};
      }
    } else {
      try {
        if (
          !entry.implementation ||
          registry.get(id) !== entry.implementation ||
          (tool.kind === "user-defined" && !customCurrent(id))
        )
          return issue("authorization", "router", "routing", ids);
      } catch {
        return issue("persistence", "storage", "routing", ids);
      }
    }
    return {
      ok: true,
      data: {
        id,
        ...ids,
        ...(grant && {
          grantId: invocationGrantId(grant, args, context.runId),
          approvalId: policyDigest(grant),
          repeatAfterSuccess: grant.catalogScope === true,
          authorization: context.sessionId.startsWith("task:") ? "unattended task grant" : grant.catalogScope ? "connection auto-approve" : grant.confirmedRead ? "session-approved read" : grant.runId && grant.callId ? "approved once" :
            grant.sessionScope ? "attached capability" : "session grant",
          stateScope: grant.stateScope,
          // An exact reviewed read has no model-supplied inputs. Explicit
          // restrictions and declared prerequisites always take precedence.
          independentInputs: !grant.requires?.length && (grant.independentInputs ??
            (grant.safety === "read-only" && grant.arguments !== undefined)) === true,
          requires: grant.requires ?? [],
        }),
        safety: mcp
          ? (grant?.safety ?? "side-effecting")
          : (entry.implementation.safety ?? "side-effecting"),
      },
    };
  }
  function route(alias, args, correlation) {
    const found = lookup(alias, args);
    if (!found.ok) return found;
    const { id, ...ids } = found.data;
    const entry = entries.get(id);
    const mcp = entry.tool.kind === "mcp";
    let active;
    try {
      active = attempt(
        id,
        args,
        ids.connectionId ?? id,
        correlation,
        mcp,
        ids.grantId,
      );
    } catch {
      return issue("persistence", "storage", "routing", { toolId: ids.toolId });
    }
    if (!active)
      return issue("authorization", "router", "routing", {
        toolId: ids.toolId,
      });
    const destination = { ...context, ...ids, ...active };
    if (mcp) {
      if (!entry.validate(args))
        return issue("invalid_arguments", "router", "validation", destination);
      return {
        ok: true,
        data: {
          source: "mcp",
          ...destination,
          originalName: entry.tool.originalName,
          revision: entry.row.revision,
          checkOutput: entry.checkOutput,
          resultProof: entry.proofs?.get(ids.approvalId),
          arguments: structuredClone(args),
        },
      };
    }
    const implementation = entry.implementation;
    try {
      const checked = implementation.validate(args);
      if (checked.ok)
        return {
          ok: true,
          data: {
            source: "internal",
            ...destination,
            arguments: structuredClone(checked.value),
          },
        };
    } catch {
      /* Treat a rejected validator input as an argument error. */
    }
    return issue("invalid_arguments", "router", "validation", destination);
  }
  return {
    ok: true,
    data: {
      tools: structuredClone(tools),
      providerNames: {
        scoped: true,
        idToName: new Map(idToName),
        nameToId: new Map(nameToId),
      },
      errors,
      availability: Array.from(connections, ([id, name]) => ({
        service: name,
        callable: tools.filter(tool => tool.connectionId === id).length,
        issues: [...new Set(errors.filter(error => error.connectionId === id).map(error => error.code))],
      })),
      lookup,
      route,
    },
  };
}
