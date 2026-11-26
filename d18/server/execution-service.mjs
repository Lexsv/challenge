import { createHash, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import {
  dependencyMessages,
  executionError,
  statusCode,
  callTransitions,
} from "../src/execution-policy.ts";
import { ExecutionJournal } from "./execution-journal.mjs";

export class OperationFailure extends Error {
  constructor(code, retryAfter = 0, origin) {
    super(code);
    this.code = code;
    this.origin = origin;
    this.retryAfter =
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 0;
  }
}
// Allow a session router to return its existing AppResult from the authorization
// hook. Only known routing classifications cross into the durable error record.
function routingOrigin(error) {
  if (
    error?.source === "router" &&
    ["routing", "validation"].includes(error.stage)
  )
    return { source: "router", stage: error.stage };
  if (error?.source === "mcp" && ["dispatch","response"].includes(error.stage))
    return {source:"mcp",stage:error.stage,
      ...(error.stage === "response" && error.code === "execution_error" && error.reportedFailure === true && {reportedFailure:true}),
      ...(error.diagnostic && {diagnostic:error.diagnostic})};
  if (error?.source === "storage" && error.stage === "routing")
    return { source: "storage", stage: "routing" };
}
function accessFailure(check) {
  const result = check();
  if (result === true || result?.ok === true) return;
  const origin = routingOrigin(result?.error);
  const code =
    origin &&
    [
      "authorization",
      "authentication",
      "route_changed",
      "unknown_tool",
      "persistence",
    ].includes(result.error.code)
      ? result.error.code
      : "authorization";
  return new OperationFailure(code, 0, origin);
}
const digest = (value) =>
  createHash("sha256")
    .update(
      JSON.stringify(value, (_, v) =>
        v && typeof v === "object" && !Array.isArray(v)
          ? Object.fromEntries(
              Object.entries(v).sort(([a], [b]) => a.localeCompare(b)),
            )
          : v,
      ),
    )
    .digest("hex");

// Retain only approved numeric calculations and currency codes. Free-form fields and model
// bodies can contain credentials or invariant-protected text, including under innocent keys.
const numericFields = new Set([
  "amount",
  "taxRate",
  "taxAmount",
  "total",
  "exchangeRate",
  "convertedAmount",
]);
function projection(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (numericFields.has(k) && Number.isFinite(v)) out[k] = v;
    else if (
      ["fromCurrency", "toCurrency"].includes(k) &&
      typeof v === "string" &&
      /^[A-Z]{3}$/i.test(v)
    )
      out[k] = v;
  }
  return out;
}
// Recovery cannot reinterpret a redacted or incomplete argument projection.
export function hasCompleteArguments(op) {
  return (
    op.arguments !== null &&
    matchesInvocation(op, op.target, JSON.parse(op.arguments))
  );
}

function matchesInvocation(op, target, args) {
  const base = digest([target, args]);
  return op.logical_key === base ||
    (op.safety === "read-only" && op.logical_key.split(":")[0] === base);
}

const defaults = {
  maxAttempts: 3,
  delayMs: 2000,
  timeoutMs: 120000,
  deadlineMs: 360000,
  concurrency: 4,
};

export class ExecutionService {
  constructor(db, options = {}) {
    this.journal = new ExecutionJournal(db, options);
    this.db = db;
    this.now = options.now ?? Date.now;
    this.policy = { ...defaults, ...options.policy };
    for (const key of Object.keys(defaults))
      if (!Number.isSafeInteger(this.policy[key]) || this.policy[key] < 1)
        throw Error("Invalid execution policy.");
    this.random = options.random ?? Math.random;
    this.wait =
      options.wait ?? ((ms, signal) => sleep(ms, undefined, { signal }));
    this.active = new Map();
    this.permits = new Map();
    this.inFlight = new Set();
    this.recoverTool = options.recoverTool;
    this.timer = setInterval(
      () => {
        try {
          this.tick();
        } catch {
          /* Retry storage on the next lease sweep. */
        }
      },
      Math.max(10, Math.floor(this.journal.leaseMs / 3)),
    );
    this.timer.unref();
    this.tick();
  }
  tick() {
    if (this.closed) return;
    for (const [id, ctx] of this.active) {
      try {
        if (!this.journal.renew(id)) ctx.controller.abort();
      } catch {
        ctx.controller.abort();
      }
    }
    for (const id of this.journal.claimStale(
      Math.max(0, 16 - this.active.size),
      [...this.active.keys()],
    )) {
      const ctx = this.context(id);
      ctx.recovery = this.recover(ctx)
        .catch(() => {})
        .finally(() => this.release(ctx));
    }
  }
  context(id) {
    const ctx = {
      id,
      controller: new AbortController(),
      cache: new Map(),
      providerCalls: new Map(),
      bindings: new Map(),
    };
    this.active.set(id, ctx);
    return ctx;
  }
  begin(session, input, contextVersion, admit) {
    if (this.closed || this.active.size >= 64)
      throw Error("Execution service unavailable.");
    this.journal.begin(
      session,
      input.turnId,
      input.fingerprint,
      contextVersion,
      this.now() + this.policy.deadlineMs,
      admit,
    );
    return this.context(input.turnId);
  }
  release(ctx) {
    if (this.active.get(ctx.id) === ctx) this.active.delete(ctx.id);
    ctx.cache.clear();
    ctx.providerCalls.clear();
    ctx.bindings.clear();
  }
  shutdown() {
    this.closed = true;
    clearInterval(this.timer);
    for (const ctx of this.active.values()) ctx.controller.abort();
  }
  track(task) {
    this.inFlight.add(task);
    return task.finally(() => this.inFlight.delete(task));
  }
  async drain() {
    this.shutdown();
    await Promise.allSettled(
      [...this.active.values()].map((ctx) => ctx.recovery),
    );
    await Promise.allSettled([...this.inFlight]);
    await this.journal.tail;
  }
  /** @returns {Promise<import('../src/execution-policy.ts').AttemptResult<unknown>>} */
  async attempt(ctx, op, invoke, authorize) {
    const j = this.journal;
    for (;;) {
      op = j.op(op.id);
      const attemptCount = j.attempts(op.id).length;
      let code;
      if (ctx.controller.signal.aborted) code = "cancelled";
      else if (this.now() >= op.deadline || attemptCount >= op.max_attempts)
        code = "timeout";
      if (!code && op.next_retry > this.now()) {
        try {
          await this.wait(op.next_retry - this.now(), ctx.controller.signal);
        } catch {
          code = "cancelled";
        }
        if (!code) continue;
      }
      const denied = !code && accessFailure(authorize);
      if (denied) code = denied.code;
      const key = op.connection_key;
      if (!code && (this.permits.get(key) ?? 0) >= this.policy.concurrency)
        code = "capacity";
      if (code)
        return this.stopCall(
          ctx,
          op,
          code,
          code === "cancelled" ? "Cancelled" : "Failed",
          denied?.origin,
        );
      const attemptId = randomUUID();
      const started = this.now();
      const acquired = await j
        .send(
          { runId: ctx.id, operationId: op.id, attemptId, event: "dispatch" },
          () => {
            const occupied = this.db
              .prepare(
                "SELECT count(*) AS n FROM week4_operations WHERE connection_key=? AND state='Running'",
              )
              .get(key).n;
            if (occupied >= this.policy.concurrency)
              throw new OperationFailure("capacity");
            if (j.run(ctx.id).state === "WaitingForRetry")
              j.moveRun(ctx.id, "Running");
            j.moveOp(op.id, "Running");
            this.db
              .prepare(
                "INSERT INTO week4_attempts VALUES(?,?,?, ?,NULL,'Running',NULL)",
              )
              .run(attemptId, op.id, attemptCount + 1, started);
          },
        )
        .catch((error) => {
          if (error instanceof OperationFailure && error.code === "capacity")
            return false;
          throw error;
        });
      if (!acquired) return this.stopCall(ctx, op, "capacity", "Failed");
      // Check again after acknowledgement, before any external operation.
      const controller = new AbortController();
      const signal = AbortSignal.any([
        ctx.controller.signal,
        controller.signal,
      ]);
      const timer = setTimeout(
        () => controller.abort(),
        Math.min(this.policy.timeoutMs, op.deadline - this.now()),
      );
      let rejectAbort;
      const aborted = new Promise((_, reject) => {
        rejectAbort = () =>
          reject(
            new OperationFailure(
              ctx.controller.signal.aborted ? "cancelled" : "timeout",
            ),
          );
      });
      signal.addEventListener("abort", rejectAbort, { once: true });
      let value,
        failure,
        dispatched = false;
      try {
        if (signal.aborted) throw new OperationFailure("cancelled");
        if (this.now() >= op.deadline) throw new OperationFailure("timeout");
        const denied = accessFailure(authorize);
        if (denied) throw denied;
        if ((this.permits.get(key) ?? 0) >= this.policy.concurrency)
          throw new OperationFailure("capacity");
        this.permits.set(key, (this.permits.get(key) ?? 0) + 1);
        dispatched = true;
        const work = Promise.resolve()
          .then(() => {
            j.fence(ctx.id);
            signal.throwIfAborted();
            return invoke(signal, op.id, { toolCallId: op.id, attemptId });
          })
          .finally(() => {
            const count = this.permits.get(key) - 1;
            if (count) this.permits.set(key, count);
            else this.permits.delete(key);
          });
        value = await Promise.race([work, aborted]);
      } catch (error) {
        failure =
          error instanceof OperationFailure
            ? error
            : new OperationFailure("execution_error");
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", rejectAbort);
      }
      const unknown =
        !!failure &&
        dispatched &&
        op.safety === "side-effecting" &&
        [
          "timeout",
          "connection",
          "cancelled",
          "execution_error",
          "schema",
          "protocol",
          "unavailable",
        ].includes(failure.code);
      const error =
        failure &&
        this.error(ctx, op, failure.code, unknown, attemptId, failure.origin);
      const delay = error?.retryable
        ? Math.max(
            failure.retryAfter || 0,
            Math.ceil(
              this.policy.delayMs *
                2 ** attemptCount *
                (1 + 0.25 * this.random()),
            ),
          )
        : 0;
      const next =
        error?.retryable &&
        op.safety !== "side-effecting" &&
        attemptCount + 1 < op.max_attempts &&
        this.now() + delay < op.deadline
          ? this.now() + delay
          : null;
      // An explicit tool error settles the call, even when a failed write
      // may have partially changed remote state. Keep its effects fenced.
      const state = unknown && !error.reportedFailure
        ? "Unknown"
        : failure?.code === "cancelled"
          ? "Cancelled"
          : failure
            ? "Failed"
            : "Success";
      await j.send(
        {
          runId: ctx.id,
          operationId: op.id,
          attemptId,
          event: next ? "retry_scheduled" : state,
        },
        () => {
          this.db
            .prepare(
              "UPDATE week4_attempts SET ended=?,state=?,error=? WHERE id=? AND ended IS NULL",
            )
            .run(
              this.now(),
              state,
              error ? JSON.stringify(error) : null,
              attemptId,
            );
          j.moveOp(
            op.id,
            next ? "WaitingForRetry" : state,
            error,
            failure
              ? null
              : op.kind === "tool"
                ? ctx.privatePayloads
                  ? null
                  : op.policy_grant ? value : projection(value)
                : { received: true },
            next,
          );
          if (!failure && op.policy_grant && (value?.compatibilityWarning || value?.watchedResourceLinks)) {
            // Both flags are safe to retain when the result payload is private.
            this.db.prepare(`UPDATE week4_operations SET display=json_set(coalesce(display,'{}'),
              '$.compatibilityWarning',?,'$.incompleteResult',?) WHERE id=?`)
              .run(Number(Boolean(value.compatibilityWarning)), Number(Boolean(value.compatibilityWarning?.evidenceIncomplete ?? value.evidenceIncomplete)), op.id);
          }
          j.syncRun(ctx.id);
        },
      );
      if (next) continue;
      return error ? { ok: false, error } : { ok: true, data: value };
    }
  }
  // Bind a dry dispatch to an acknowledged, still-running tool attempt.
  routingAttempt(ctx, target, args, connection, correlation, mcp, grantId) {
    if (
      typeof correlation?.toolCallId !== "string" ||
      typeof correlation.attemptId !== "string"
    )
      return null;
    const op = this.journal.op(correlation.toolCallId);
    if (
      op?.kind !== "tool" ||
      op.run_id !== ctx.id ||
      op.state !== "Running" ||
      op.target !== target ||
      op.connection_key !== connection ||
      (mcp && (grantId ? op.policy_grant !== grantId : op.safety !== "side-effecting")) ||
      this.now() >= op.deadline ||
      !matchesInvocation(op, target, args)
    )
      return null;
    const attempt = this.journal.attempts(op.id).at(-1);
    if (
      attempt?.id !== correlation.attemptId ||
      attempt.state !== "Running" ||
      this.now() >= attempt.started + this.policy.timeoutMs
    )
      return null;
    return {
      toolCallId: op.id,
      attemptId: attempt.id,
      ...(op.parent_llm_id && { llmCallId: op.parent_llm_id }),
    };
  }
  error(ctx, op, code, unknown = false, attemptId, origin) {
    const stage = [
      "invalid_arguments",
      "authorization",
      "schema",
      "unknown_tool",
      "dependency",
      "authentication",
    ].includes(code)
      ? "validation"
      : code === "recovery"
        ? "recovery"
        : code === "refusal"
          ? "response"
          : "dispatch";
    return {
      ...executionError(
        code,
        origin?.source ?? (op.kind === "llm" ? "llm" : "internal"),
        origin?.stage ?? stage,
        this.now(),
        unknown ? "unknown" : "known",
      ),
      ...(origin?.source === "mcp" && origin.reportedFailure && {reportedFailure:true}),
      ...(origin?.source === "mcp" && origin.stage === "response" && !ctx.privatePayloads &&
        typeof origin.diagnostic === "string" && {diagnostic: origin.diagnostic}),
      ...(code === "dependency" && origin?.skipReason && Object.hasOwn(dependencyMessages, origin.skipReason) &&
        {skipReason: origin.skipReason, message: dependencyMessages[origin.skipReason]}),
      ...(op.safety === "side-effecting" ? { retryable: false } : {}),
      sessionId: (this.journal.run(ctx.id).session_id ?? "task:"+this.journal.run(ctx.id).task_id),
      runId: ctx.id,
      requestId: ctx.id,
      ...(op.kind === "tool" && { toolCallId: op.id }),
      ...(op.parent_llm_id && { llmCallId: op.parent_llm_id }),
      callId: op.id,
      ...(attemptId ? { attemptId } : {}),
    };
  }
  async stopCall(ctx, op, code, state, origin) {
    const error = this.error(ctx, op, code, false, undefined, origin);
    await this.journal.send(
      { runId: ctx.id, operationId: op.id, event: state },
      () => {
        this.journal.moveOp(op.id, state, error);
        this.journal.syncRun(ctx.id);
      },
    );
    return { ok: false, error };
  }
  async register(
    ctx,
    { id, kind, target, key, safety, args, connection = target, providerCall, grantId, display, repeatAfterSuccess = false },
  ) {
    const j = this.journal;
    if (j.operations(ctx.id).length >= 128)
      throw new OperationFailure("capacity");
    await j.send({ runId: ctx.id, operationId: id, event: "intent" }, () => {
      // Tightening a result proof or rotating a policy file cannot re-arm a
      // consumed write. Reserve the logical operation inside the intent transaction.
      // A whole-tool connection consent can be exercised in a new user run
      // after confirmed success. In-flight and uncertain writes stay reserved.
      const consumed = grantId && safety === "side-effecting" && this.db.prepare(
        `SELECT 1 FROM week4_operations o JOIN week4_runs r ON r.id=o.run_id
         WHERE coalesce(r.session_id,'task:'||r.task_id)=? AND o.connection_key=? AND o.target=? AND o.logical_key=?
           AND o.safety='side-effecting' AND o.policy_grant IS NOT NULL
           AND NOT (? AND o.run_id<>? AND o.state='Success' AND r.state IN ('Completed','PartialSuccess','Failed','RequiresReview','Cancelled')) LIMIT 1`,
      ).get(j.run(ctx.id).session_id ?? "task:"+j.run(ctx.id).task_id, connection, target, key, +repeatAfterSuccess, ctx.id);
      this.db
        .prepare(
          `INSERT INTO week4_operations(id,run_id,kind,provider_call_hash,parent_llm_id,logical_key,target,connection_key,safety,state,arguments,created,deadline,max_attempts,policy_grant)
        VALUES(?,?,?,?,?,?,?,?,?,'Pending',?,?,?,?,?)`,
        )
        .run(
          id,
          ctx.id,
          kind,
          providerCall ? digest(providerCall) : null,
          kind === "tool" ? (ctx.parent ?? null) : null,
          key,
          target,
          connection,
          safety,
          JSON.stringify(ctx.privatePayloads ? null : projection(args)),
          this.now(),
          Math.min(
            this.now() + this.policy.deadlineMs,
            j.run(ctx.id).retry_deadline,
          ),
          this.policy.maxAttempts,
          consumed ? null : grantId ?? null,
        );
      if(display) this.db.prepare("UPDATE week4_operations SET display=? WHERE id=?").run(JSON.stringify(display),id);
    });
    return j.op(id);
  }
  async model(ctx, provider, invoke, key = randomUUID(), id = randomUUID()) {
    const op = await this.register(ctx, {
      id,
      kind: "llm",
      target: provider,
      key,
      safety: "read-only",
    });
    const result = await this.track(
      this.attempt(
        ctx,
        op,
        invoke,
        () => !ctx.controller.signal.aborted && (ctx.current?.() ?? true),
      ),
    );
    ctx.parent = id;
    if (!result.ok) {
      ctx.failure = result.error;
      throw new OperationFailure(result.error.code);
    }
    ctx.failure = undefined;
    return result.data;
  }
  async transport(ctx, provider, body, send) {
    const key = digest([provider, body]);
    // Re-entering the same provider request cannot reset an exhausted retry budget.
    const meterId = ctx.meterId;
    ctx.meterId = undefined;
    if (ctx.providerCalls.has(key)) return ctx.providerCalls.get(key);
    const task = this.providerRequest(ctx, provider, key, send, meterId);
    ctx.providerCalls.set(key, task);
    return task;
  }
  async providerRequest(ctx, provider, key, send, meterId) {
    let lastResponse;
    try {
      return await this.model(
        ctx,
        provider,
        async (signal) => {
          const reply = await send(signal);
          lastResponse = reply;
          const status = reply.body?.providerError?.status ?? reply.status;
          // Keep domain errors such as context overflow and unsupported structured output
          // available to the existing adapter and its narrowly scoped recovery logic.
          if (status >= 400) {
            const failure = new OperationFailure(
              statusCode(status),
              reply.retryAfterMs,
            );
            throw failure;
          }
          const output = reply.body?.output,
            choices = reply.body?.choices;
          if (
            (Array.isArray(output) &&
              output.some(
                (m) =>
                  Array.isArray(m?.content) &&
                  m.content.some((v) => v?.type === "refusal"),
              )) ||
            (Array.isArray(choices) && choices.some((v) => v?.message?.refusal))
          )
            throw new OperationFailure("refusal");
          if (
            reply.body?.status === "incomplete" ||
            (Array.isArray(choices) &&
              choices.some((v) => v?.finish_reason === "length"))
          )
            throw new OperationFailure("incomplete");
          if (!Array.isArray(output) && !Array.isArray(choices))
            throw new OperationFailure("schema");
          return reply;
        },
        key,
        meterId,
      );
    } catch (error) {
      if (
        error instanceof OperationFailure &&
        lastResponse?.status >= 400 &&
        statusCode(
          lastResponse.body?.providerError?.status ?? lastResponse.status,
        ) === error.code
      )
        return lastResponse;
      throw error;
    }
  }
  async tool(ctx, operation) {
    const { id, call, allowed, skip, check } = operation;
    const base = digest([call.toolId, call.arguments]);
    const previous = ctx.bindings.get(call.id);
    if (previous && previous.split(":")[0] !== base) throw new OperationFailure("protocol");
    // Refresh verified reads after an intervening mutation attempt, including an
    // uncertain one. A replay of the same provider call still gets its receipt.
    const lastWrite = operation.safety === "read-only" && operation.connection &&
      this.db.prepare(`SELECT id FROM week4_operations WHERE run_id=? AND connection_key=?
        AND safety='side-effecting' AND policy_grant IS NOT NULL ORDER BY rowid DESC LIMIT 1`)
        .get(ctx.id, operation.connection);
    // A skipped proposal never reserved or dispatched a write. A later model
    // call can propose that tuple once its actual prerequisite succeeds.
    const key = previous ?? (skip ? base + ":skipped:" + digest(call.id)
      : lastWrite ? base + ":" + lastWrite.id : base);
    ctx.bindings.set(call.id, key);
    if (ctx.cache.has(key)) {
      const denied = allowed && !skip && accessFailure(check);
      if (!allowed || denied || skip)
        return {
          ok: false,
          outcome: skip ? "Skipped" : "Failed",
          toolId: call.toolId,
          error: this.error(
            ctx,
            { id, kind: "tool" },
            skip ? "dependency" : (denied?.code ?? "authorization"),
            false,
            undefined,
            skip ? {source:"manager", stage:"validation", skipReason:operation.skipReason} : denied?.origin,
          ),
        };
      return ctx.cache.get(key);
    }
    const task = this.track(this.executeTool(ctx, key, operation));
    ctx.cache.set(key, task);
    return task;
  }
  async executeTool(
    ctx,
    key,
    { id, call, safety, allowed, skip, skipReason, check, invoke, connection, grantId, preflightError, display, repeatAfterSuccess },
  ) {
    const target = allowed ? call.toolId : "unavailable";
    const op = await this.register(ctx, {
      id,
      kind: "tool",
      target,
      key,
      safety,
      connection,
      grantId:allowed && !skip ? grantId : undefined,
      repeatAfterSuccess: allowed && !skip && repeatAfterSuccess === true,
      display,
      providerCall: call.id,
      args: allowed && !skip ? call.arguments : null,
    });
    let result;
    if (allowed && !skip && grantId && !op.policy_grant)
      result=await this.stopCall(ctx,op,"authorization","Failed",{source:"router",stage:"routing"});
    else if (!allowed || skip)
      result = await this.stopCall(
        ctx,
        op,
        allowed ? "dependency" : preflightError?.code ?? "unknown_tool",
        allowed ? "Skipped" : "Failed",
        allowed && skip ? {source:"manager", stage:"validation", skipReason} : routingOrigin(preflightError),
      );
    else
      result = await this.attempt(
        ctx,
        op,
        async (signal, idempotencyKey, correlation) => {
          const r = await invoke(signal, idempotencyKey, correlation);
          if (!r.ok)
            throw new OperationFailure(
              [
                "cancelled",
                "timeout",
                "unavailable",
                "rate_limit",
                "invalid_arguments",
                "unknown_tool",
                "connection",
                "authentication",
                "authorization",
                "protocol",
                "schema",
                "unsupported_schema",
                "route_changed",
                "capacity",
                "persistence",
              ].includes(r.error.code)
                ? r.error.code
                : "execution_error",
              r.error.retryAfterMs,
              routingOrigin(r.error),
            );
          try {
            const json = JSON.stringify(r.output, (_, v) => {
              if (
                v === undefined ||
                (typeof v === "number" && !Number.isFinite(v)) ||
                ["function", "symbol", "bigint"].includes(typeof v)
              )
                throw new OperationFailure("schema");
              return v;
            });
            if (!json || Buffer.byteLength(json) > 1024 * 1024)
              throw new OperationFailure("schema");
          } catch {
            throw new OperationFailure("schema");
          }
          return r.output;
        },
        check,
      );
    const outcome = result.ok
      ? {
          ok: true,
          outcome: "Success",
          logicalCallId: op.id,
          toolId: call.toolId,
          output: result.data,
        }
      : {
          ok: false,
          outcome: this.journal.op(op.id).state,
          logicalCallId: op.id,
          toolId: call.toolId,
          error: result.error,
        };
    return outcome;
  }
  // Called inside the same transaction as the approved chat turn on success.
  finish(ctx, answer, code) {
    const j = this.journal;
    // If the terminal acknowledgement failed after dispatch, retain the dispatch
    // checkpoint for fenced recovery. Do not close the run with a guessed result.
    const operations = j.operations(ctx.id);
    if (operations.some((op) => callTransitions[op.state].length)) {
      if (answer === "delivered") throw new OperationFailure("persistence");
      j.moveRun(ctx.id, "Interrupted");
      this.db
        .prepare("UPDATE week4_runs SET lease_until=?,answer=? WHERE id=?")
        .run(this.now(), answer, ctx.id);
      return "Interrupted";
    }
    const { tools } = j.stats(ctx.id);
    // Keep the skip diagnostic, but count the requirement as fulfilled if
    // the same operation was subsequently completed in this run.
    function succeededLater(op, index) {
      const base = op.logical_key.split(":")[0];
      return operations.slice(index + 1).some(later => later.kind === "tool" && later.state === "Success" &&
        later.target === op.target && later.connection_key === op.connection_key &&
        later.logical_key.split(":")[0] === base);
    }
    const outstandingSkip = tools.Skipped && operations.some((op, index) =>
      op.state === "Skipped" && !succeededLater(op, index));
    const resolutionIssues = ctx.resolutionIssues ?? JSON.parse(j.run(ctx.id).error ?? "null")?.resolutionIssues ?? [];
    const currentIssues = ctx.currentResolutionIssues ?? resolutionIssues;
    const noToolEvidence = !operations.some(op => op.kind === "tool");
    const blockingIssue = ctx.blockedResolutionIssues?.[0] ?? currentIssues.find(issue =>
      issue.code !== "unsupported_schema" || (noToolEvidence && !ctx.toolIndependentAnswer));
    // The Manager links a replacement to the validation rejection it corrected.
    // Follow only same-run pre-dispatch rejections, starting at durable successes.
    const corrected = new Set();
    if (tools.Failed) {
      for (const op of operations.slice().reverse()) {
        if (op.kind !== "tool" || (op.state !== "Success" && !corrected.has(op.id))) continue;
        const prior = JSON.parse(op.display ?? "null")?.correctsOperation;
        if (prior) corrected.add(prior);
      }
    }
    const outstandingFailure = tools.Failed && operations.find((op, index) => {
      if (op.kind !== "tool" || op.state !== "Failed") return false;
      const failure = JSON.parse(op.error ?? "null");
      if (ctx.currentResolutionIssues && op.safety === "read-only" &&
          failure?.certainty === "known" && succeededLater(op, index)) return false;
      return !corrected.has(op.id) || failure?.code !== "invalid_arguments" ||
        failure.stage !== "validation" || failure.certainty !== "known" || j.attempts(op.id).length > 0;
    });
    const incomplete = blockingIssue || answer !== "delivered" || outstandingFailure || outstandingSkip || tools.Cancelled;
    const uncertain = operations.find(op => (op.kind === "tool" && op.state === "Unknown") ||
      (op.state === "Failed" && JSON.parse(op.error ?? "null")?.certainty === "unknown"));
    let state;
    if (uncertain || answer === "interrupted") state = "RequiresReview";
    else if (tools.Success && incomplete) state = "PartialSuccess";
    else if (answer === "cancelled") state = "Cancelled";
    else state = incomplete ? "Failed" : "Completed";
    j.moveRun(ctx.id, state);
    const error = code
      ? executionError(
          code,
          code === "persistence" ? "storage" : "manager",
          code === "persistence" ? "checkpoint" : "response",
          this.now(),
        )
      : null;
    const taskError = ctx.failure ?? JSON.parse(uncertain?.error ?? "null") ?? blockingIssue ??
      JSON.parse(outstandingFailure?.error ?? "null") ?? error;
    const availability = resolutionIssues.map(issue =>
      ctx.blockedResolutionIssues?.some(blocked => blocked.toolId === issue.toolId && blocked.code === issue.code)
        ? {...issue, required: true} : issue);
    this.db
      .prepare(
        "UPDATE week4_runs SET answer=?,error=?,owner=NULL,lease_until=NULL WHERE id=?",
      )
      .run(
        answer,
        JSON.stringify(resolutionIssues.length
          ? {...taskError, resolutionIssues: availability}
          : ctx.currentResolutionIssues ? taskError : answer === "delivered" ? null : (ctx.failure ?? error)),
        ctx.id,
      );
    return state;
  }
  async recover(ctx) {
    const j = this.journal;
    j.transaction(() => j.moveRun(ctx.id, "Running"));
    for (const op of j.operations(ctx.id)) {
      if (!callTransitions[op.state].length) continue;
      const resume =
        op.kind === "tool" &&
        op.safety !== "side-effecting" &&
        this.recoverTool?.(j.run(ctx.id), op);
      if (op.state === "Running") {
        const attempt = j.attempts(op.id).at(-1);
        const uncertain = op.safety === "side-effecting";
        const error = this.error(ctx, op, "recovery", uncertain, attempt?.id);
        await j.send(
          {
            runId: ctx.id,
            event: "attempt_interrupted",
            operationId: op.id,
            attemptId: attempt?.id,
          },
          () => {
            this.db
              .prepare(
                "UPDATE week4_attempts SET state=?,ended=?,error=? WHERE id=? AND ended IS NULL",
              )
              .run(
                uncertain ? "Unknown" : "Interrupted",
                this.now(),
                JSON.stringify(error),
                attempt.id,
              );
            j.moveOp(
              op.id,
              uncertain ? "Unknown" : resume ? "WaitingForRetry" : "Failed",
              error,
              null,
              resume ? this.now() : null,
            );
          },
        );
      }
      if (!callTransitions[j.op(op.id).state].length) continue;
      if (resume)
        await this.attempt(ctx, j.op(op.id), resume.invoke, resume.authorize);
      else await this.stopCall(ctx, op, "recovery", "Skipped");
    }
    j.transaction(() => this.finish(ctx, "interrupted", "recovery"));
  }
}
