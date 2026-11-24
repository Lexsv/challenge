import { mcpRunSummary } from "./mcp-run-summary.mjs";
import { sessionPolicy } from "./session-mcp-permissions.mjs";
import {
  readMcpPolicy,
  readGrants,
  invocationGrantId,
} from "./mcp-execution-policy.mjs";
import { sessionCatalogRows } from "./mcp-repository.mjs";
import { sanitizedCapture } from "./journal-payload.mjs";
import { ToolRegistry } from "../src/tool-runtime.ts";
import { registryForMemory } from "../src/fact-history-tool.ts";
import { resolveWeek4Tools } from "./week4-tool-routing.mjs";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  ExecutionService,
  OperationFailure,
  hasCompleteArguments,
} from "./execution-service.mjs";
import { createBuiltInToolRegistry } from "../src/tool-runtime.ts";

// The execution context is established only by the Week 4 HTTP route.
export function createWeek4Execution(db, options = {}) {
  const local = new AsyncLocalStorage();
  const registry = createBuiltInToolRegistry();
  const version = (session) =>
    JSON.stringify(
      db
        .prepare(
          `SELECT s.updatedAt,
    (SELECT max(sequence) FROM week3_history_events WHERE sessionId=s.id) AS history,
    (SELECT revision FROM week3_session_memory WHERE sessionId=s.id) AS memory,
    (SELECT max(id) FROM invariant_audit_log WHERE session_id='week3:'||s.id) AS policy
    FROM week3_sessions s WHERE s.id=?`,
        )
        .get(session) ?? null,
    );
  const policy = options.readMcpPolicy ?? readMcpPolicy;
  function prerequisiteFailure(runId, callIds, requiredGrants = []) {
    if (!Array.isArray(callIds)) return "prerequisite_missing";
    const grants = new Set();
    for (const id of callIds) {
      if (typeof id !== "string") return "prerequisite_missing";
      const parent = db.prepare(
        `SELECT p.state,p.policy_grant,json_extract(p.display,'$.incompleteResult') AS incomplete FROM week4_operations p WHERE p.run_id=? AND p.id=? AND p.kind='tool'
           AND NOT (p.safety='read-only' AND EXISTS (SELECT 1 FROM week4_operations u
             WHERE u.run_id=p.run_id AND u.connection_key=p.connection_key AND u.rowid>p.rowid
               AND (u.state='Unknown' OR (u.state='Failed' AND json_extract(u.error,'$.certainty')='unknown'))
               AND (json_extract(p.display,'$.stateScope') IS NULL OR json_extract(u.display,'$.stateScope') IS NULL
                 OR json_extract(p.display,'$.stateScope')=json_extract(u.display,'$.stateScope'))))`,
      ).get(runId, id);
      if (parent?.state !== "Success") return "prerequisite_failed";
      if (parent.incomplete) return "prerequisite_missing";
      grants.add(parent.policy_grant);
    }
    return requiredGrants.every(grant => grants.has(grant)) ? undefined : "prerequisite_missing";
  }
  function capture(ctx, dest) {
    if (ctx.privatePayloads) return dest;
    return {
      ...dest,
      capture(field, value) {
        if (
          !["request", "response", "returned", "sent"].includes(field) ||
          value == null
        )
          return;
        service.journal.transaction(() => {
          service.journal.fence(ctx.id);
          db.prepare(
            `UPDATE week4_checkpoints SET capture=json_set(coalesce(capture,'{}'),?,?)
          WHERE run_id=? AND operation_id=? AND attempt_id=? AND event='dispatch'
          AND EXISTS(SELECT 1 FROM week4_attempts WHERE id=? AND state='Running')`,
          ).run(
            "$." + field,
            value,
            ctx.id,
            dest.toolCallId,
            dest.attemptId,
            dest.attemptId,
          );
        });
      },
    };
  }
  const service = new ExecutionService(db, {
    ...options,
    recoverTool(run, op) {
      let parents;
      try {
        parents = JSON.parse(op.display ?? "{}").prerequisites ?? [];
      } catch {
        return; // An unreadable dependency record cannot authorize a replay.
      }
      // Recover MCP arguments from their pinned operator approval. The durable
      // logical key must still match the complete tuple at dispatch.
      if (op.policy_grant) {
        if (
          op.safety !== "read-only" ||
          op.arguments === "null" ||
          !options.mcpManager
        )
          return;
        const row = sessionCatalogRows(db, run.session_id).find(
          (r) =>
            r.connectionId === op.connection_key &&
            "mcp:" + r.toolId === op.target,
        );
        if (!row) return;
        const restored = hasCompleteArguments(op) ? JSON.parse(op.arguments) : undefined;
        const effectivePolicy = sessionPolicy(db, run.session_id, policy);
        const grant = readGrants(row, effectivePolicy, run.session_id).find(g =>
          (!g.argumentSchema || restored !== undefined) &&
          invocationGrantId(g, restored) === op.policy_grant);

        if (!grant || grant.safety !== "read-only") return;
        // Replay a dynamic read only when the journal retained its complete arguments.
        const args = grant.argumentSchema ? restored : grant.arguments;
        const ctx = this.active.get(run.id);
        const scope = () =>
          !ctx.controller.signal.aborted &&
          ["Running", "WaitingForRetry"].includes(
            this.journal.fence(run.id).state,
          ) &&
          version(run.session_id) === run.context_version &&
          !db
            .prepare(
              "SELECT 1 FROM session_invariants WHERE enabled=1 AND session_id=?",
            )
            .get("week3:" + run.session_id) && {
            sessionId: run.session_id,
            runId: run.id,
            requestId: run.request_id,
          };
        // All supported providers use the same validated input-schema profile.
        const snapshot = resolveWeek4Tools({
          db,
          registry: new ToolRegistry(),
          scope,
          policy: effectivePolicy,
          provider: "openai",
          now: this.now,
          attempt: (...args) => this.routingAttempt(ctx, ...args),
        });
        if (!snapshot.ok) return;
        const resolved = snapshot.data,
          alias = resolved.providerNames.idToName.get(op.target);
        const authorize = () =>
          resolved.lookup(alias, args).data?.grantId ===
            op.policy_grant && !prerequisiteFailure(run.id, parents, grant.requires);
        if (!authorize()) return;
        return {
          authorize,
          invoke: async (signal, _key, correlation) => {
            const route = () =>
              resolved.route(alias, args, correlation);
            const dest = route();
            if (!dest.ok)
              throw new OperationFailure(dest.error.code, 0, dest.error);
            const result = await options.mcpManager.execute(
              capture(ctx, dest.data),
              signal,
              () => authorize() && route().ok,
            );
            if (!result.ok)
              throw new OperationFailure(
                result.error.code,
                result.error.retryAfterMs,
                result.error,
              );
            return result.output;
          },
        };
      }
      if (!hasCompleteArguments(op)) return;
      const tool = registry.get(op.target);
      const args = JSON.parse(op.arguments);
      const authorize = () =>
        tool?.safety === "read-only" &&
        !!tool.independentInputs &&
        !prerequisiteFailure(run.id, parents) &&
        registry.get(op.target) === tool &&
        version(run.session_id) === run.context_version &&
        tool.validate(args).ok &&
        !db
          .prepare(
            "SELECT 1 FROM session_invariants WHERE enabled=1 AND session_id=?",
          )
          .get("week3:" + run.session_id);
      if (!authorize()) return;
      return {
        authorize,
        invoke: async (signal) => {
          const result = await registry.executeById(op.target, args, signal);
          if (!result.ok)
            throw new OperationFailure(
              result.error.code,
              result.error.retryAfterMs,
            );
          return result.output;
        },
      };
    },
  });
  return {
    service,
    begin(session, input, localExecution = false) {
      const ctx = service.begin(session, input, version(session));
      let bindings;
      const scope = () => {
        if (
          local.getStore() !== ctx ||
          service.active.get(ctx.id) !== ctx ||
          ctx.controller.signal.aborted ||
          ctx.current?.() === false
        )
          return null;
        try {
          const run = service.journal.fence(ctx.id);
          if (
            !["Running", "WaitingForRetry"].includes(run.state) ||
            run.session_id !== session ||
            run.context_version !== version(session)
          )
            return null;
          return {
            sessionId: session,
            requestId: run.request_id,
            runId: run.id,
          };
        } catch {
          return null;
        }
      };
      const resolve = (policy) =>
        resolveWeek4Tools({
          db,
          provider: input.provider,
          ...bindings,
          policy,
          registry:
            bindings && registryForMemory(bindings.registry, bindings.memory),
          scope,
          now: service.now,
          attempt: (...args) => service.routingAttempt(ctx, ...args),
        });
      return {
        ctx,
        bindTurnTools(registry, memory, customCurrent) {
          if (bindings || local.getStore() !== ctx)
            throw new OperationFailure("authorization");
          bindings = { registry, memory, customCurrent };
        },
        resolveTools: () => resolve(), // catalog inspection only
        managerTools() {
          const result = resolve(sessionPolicy(db, session, policy, localExecution));
          if (!result.ok) throw new OperationFailure(result.error.code);
          const snapshot = result.data;
          return {
            tools: snapshot.tools,
            availability: snapshot.availability,
            async plan(call) {
              const offered = snapshot.tools.find((t) => t.id === call.toolId);
              const alias = call.providerName
                ? call
                : offered?.kind !== "mcp" &&
                  snapshot.providerNames.idToName.get(call.toolId);
              const check = () => snapshot.lookup(alias, call.arguments);
              const intent = check();
              const explicitParents = (call.dependsOn ?? []).map((id) =>
                db.prepare(
                  "SELECT id FROM week4_operations WHERE run_id=? AND kind='tool' AND logical_key=?",
                ).get(ctx.id, ctx.bindings.get(id) ?? null)?.id,
              );
              if (!intent.ok) return {
                allowed: false, error: intent.error, validation: intent.validation,
                prerequisiteCallIds: [...new Set(explicitParents.filter(Boolean))],
              };
              const {
                connectionId,
                grantId,
                independentInputs,
                safety,
                requires,
              } = intent.data;
              // Bind once, even if the verification failed: the journal must show
              // which call blocked this operation. Never substitute an older proof.
              const parents = [
                ...(requires ?? []).map((grant) => db.prepare(
                  "SELECT id FROM week4_operations WHERE run_id=? AND kind='tool' AND policy_grant=? ORDER BY rowid DESC LIMIT 1",
                ).get(ctx.id, grant)?.id),
                ...explicitParents,
              ];
              const prerequisiteCallIds = [...new Set(parents.filter(Boolean))];
              const dependencyError = () => parents.includes(undefined) ? "prerequisite_missing" :
                prerequisiteFailure(ctx.id, prerequisiteCallIds, requires);
              const error = dependencyError();
              return {
                allowed: true,
                authorization: intent.data.authorization ?? "internal registration",
                repeatAfterSuccess: intent.data.repeatAfterSuccess,
                connection: connectionId,
                grantId,
                safety,
                independentInputs,
                stateScope: intent.data.stateScope,
                prerequisiteCallIds,
                ready: !error,
                prerequisiteFailure: error,
                check: () => !dependencyError() && check(),
                invoke: async (signal, _key, correlation) => {
                  const route = () =>
                    snapshot.route(alias, call.arguments, correlation);
                  const destination = route();
                  if (!destination.ok)
                    return {
                      ok: false,
                      toolId: call.toolId,
                      error: destination.error,
                    };
                  if (destination.data.source === "internal") {
                    const registry = registryForMemory(
                      bindings.registry,
                      bindings.memory,
                    );
                    const record = capture(ctx, destination.data).capture;
                    record?.(
                      "sent",
                      sanitizedCapture(
                        JSON.stringify(destination.data.arguments),
                      ),
                    );
                    const result = await registry.executeById(
                      call.toolId,
                      destination.data.arguments,
                      signal,
                      _key,
                    );
                    record?.(
                      "returned",
                      sanitizedCapture(JSON.stringify(result)),
                    );
                    return result;
                  }
                  return options.mcpManager.execute(
                    capture(ctx, destination.data),
                    signal,
                    () => !dependencyError() && route().ok,
                  );
                },
              };
            },
          };
        },
        within: (fn) => local.run(ctx, fn),
        tool: (operation, ensureCurrent) => {
          const target = operation.call.toolId;
          const internal = bindings?.registry.get(target);
          const external =
            target.startsWith("mcp:") &&
            operation.connection &&
            sessionCatalogRows(db, session, target.slice(4)).find(
              (r) =>
                r.connectionId === operation.connection &&
                "mcp:" + r.toolId === target,
            );
          // No request was sent on a preflight failure. Preserve the proposed
          // shape for diagnostics without retaining arbitrary rejected values.
          const proposedFields = external && !ctx.privatePayloads && operation.preflightError
            ? Object.keys(JSON.parse(external.document).inputSchema.properties ?? {})
                .filter(key => Object.hasOwn(operation.call.arguments ?? {}, key))
            : undefined;
          // Before dispatch, retain only catalog-declared argument names and
          // enumerated values. Free-form rejected arguments may contain secrets.
          let proposedArguments;
          if (external?.autoApprove && proposedFields) {
            const properties = JSON.parse(external.document).inputSchema.properties;
            proposedArguments = sanitizedCapture(JSON.stringify(Object.fromEntries(
              proposedFields.map(key => [key, properties[key].enum?.includes(operation.call.arguments[key])
                ? operation.call.arguments[key] : "[withheld]"])
            )));
          }
          const display = {
            proposedArguments,
            proposedFields,
            type: external ? "MCP" : (internal?.executionType ?? "unavailable"),
            name:
              external?.originalName ?? internal?.name ?? "Unavailable tool",
            server: external?.connectionName,
            prerequisites: operation.prerequisiteCallIds ?? [],
            stateScope: operation.stateScope,
            authorization: operation.authorization ?? (operation.preflightError?.code === "invalid_arguments" ? "not evaluated" : "denied"),
            validation: operation.preflightError?.code === "invalid_arguments" ? "failed" :
              operation.validation ?? (external && operation.allowed ? "passed" : "not established"),
          };
          return service.tool(ctx, {
            ...operation,
            display,
            check: () => {
              try {
                ensureCurrent();
                return operation.check();
              } catch {
                return false;
              }
            },
          });
        },
        model: (provider, fn) => service.model(ctx, provider, fn),
        journalSummary: () => mcpRunSummary(service.journal.operations(ctx.id)),
        committed: (fallback) => service.finish(ctx, fallback ? "fallback" : "delivered", fallback ? "incomplete" : undefined),
      };
    },
    transport(base) {
      return (provider, body) => {
        const ctx = local.getStore();
        return ctx
          ? service.transport(ctx, provider, body, (signal) =>
              base(provider, body, () => !signal.aborted, signal),
            )
          : base(provider, body);
      };
    },
  };
}
