import { createHash, randomUUID } from "node:crypto";
import { executeChatTurn, InvariantError } from "./invariant-turn.mjs";
import { policyIssue } from "./invariant-validator.mjs";
import { proposalReceipt } from "./week3-memory-proposals.mjs";
import { resolveSessionPersonalization } from "./session-personalization.mjs";

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

function validate(body, scope, providerAvailable) {
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).some(k => !["model", "provider", "question", "turnId", ...(scope.week3 ? ["execute"] : [])].includes(k)) ||
      (body.execute !== undefined && body.execute !== true) ||
      (body.turnId !== undefined && (typeof body.turnId !== "string" || !uuid.test(body.turnId))) ||
      !providerAvailable(body.provider) ||
      typeof body.model !== "string" || !body.model.trim() || body.model.length > 200 ||
      typeof body.question !== "string" || !body.question.trim() || body.question.length > 32000)
    throw new InvariantError(400, "Invalid chat request.");
  const fingerprint = createHash("sha256")
    .update(JSON.stringify([scope.id, body.provider, body.model, body.question])).digest("hex");
  return {...body, turnId: body.turnId ?? randomUUID(), fingerprint};
}

export function createChatCommands(db, store, makeAdapter, compatibility, options) {
  // Shared by all entry points targeting the same chat. Rule edits remain
  // fenced throughout an unrestricted Week 4 command without a browser lease.
  const busy = new Map();
  const foundation = options.week4Execution;

  async function submit(s, body, {week4 = false, interactive = false, issueLease, trace} = {}) {
    const input = validate(body, s, options.providerAvailable);
    if (trace) Object.assign(trace, {turnId: input.turnId, stage: "session_initialization"});
    if (options.scheduledTasks?.reserved(input.turnId))
      throw new InvariantError(403, "Turn ID belongs to a scheduled occurrence.");
    const rules = store.active(s);
    const receipt = s.week3 && proposalReceipt(db, s.id, input.turnId);
    const prior = receipt || store.securityEvent(s, input.turnId);
    if (prior) {
      if (prior.fingerprint !== input.fingerprint) throw new InvariantError(409, "Turn identifier already used.");
      if (prior.action === "blocked")
        throw new InvariantError(422, "Request blocked", rules.find(r => r.id === prior.invariant_id));
      return {status: "completed", redacted: receipt ? !!receipt.redacted : true};
    }
    const issue = policyIssue(rules);
    if (issue) throw new InvariantError(409, issue);
    if (issueLease && !rules.length && !input.execute) return issueLease();
    if (busy.has(s.key)) throw new InvariantError(409, "A protected turn is already running.");
    if (s.week3 && foundation.service.journal.run(input.turnId))
      throw new InvariantError(409, "Execution already recorded. Check its outcome before repeating this request.");

    busy.set(s.key, {holdsSettings: week4 && !rules.length});
    let durable;
    try {
      if (week4) {
        durable = foundation.begin(s.id, input, interactive);
        durable.ctx.privatePayloads = rules.length > 0;
      }
      // Protected turns never enter the separate profile-instruction workflow.
      const refs = {sessionId: s.id, runId: input.turnId, messageId: "user-" + input.turnId};
      let prepared;
      if (week4 && !rules.length) {
        const profile = resolveSessionPersonalization(db, s.id);
        if (!profile.ok) throw new InvariantError(503, "The chat profile could not be loaded.");
        if (profile.data.profileId !== "general") prepared = options.turnContexts.create(refs);
      }
      const perform = () => executeChatTurn(db, store, s, rules, input, makeAdapter, compatibility, options, trace, durable);
      const result = await (durable ? durable.within(perform) : perform());
      // The answer is already committed. A detector failure must not invalidate
      // it or cause completed tool calls to be repeated.
      if (prepared?.ok) {
        try {
          result.instructionOutcome = await options.processInstructionTurn({...refs, turnToken: prepared.token});
        } catch {
          result.instructionOutcome = {status: "persistence_failure"};
        }
      } else if (prepared && prepared.error !== "duplicate") {
        result.instructionOutcome = {status: "invalid_token"};
      }
      return result;
    } catch (error) {
      if (durable && foundation.service.journal.run(input.turnId)?.owner === foundation.service.journal.owner) {
        const ctx = durable.ctx;
        const answer = ctx.failure?.code === "refusal" ? "refused" : ctx.controller.signal.aborted ? "cancelled" : "failed";
        const failure = trace?.stage === "commit" ? "persistence" : "execution_error";
        foundation.service.journal.transaction(() => foundation.service.finish(ctx, answer, failure));
      }
      throw error;
    } finally {
      if (durable) foundation.service.release(durable.ctx);
      busy.delete(s.key);
    }
  }

  return {
    holdsSettings: key => busy.get(key)?.holdsSettings === true,
    submit: (scope, body, caller) => caller.week4
      ? foundation.service.track(submit(scope, body, caller)) : submit(scope, body, caller),
    // Trusted in-process caller. No HTTP shortcut, interactive consent flag,
    // or caller-supplied scope. Attached-only interactive grants stay unavailable.
    async executeWeek4Turn(sessionId, command) {
      if (typeof sessionId !== "string" || typeof command?.turnId !== "string" || !uuid.test(command.turnId))
        throw new InvariantError(400, "A session and stable turn ID are required.");
      const scope = store.scope(true, sessionId);
      if (!scope) throw new InvariantError(404, "Chat session not found.");
      return foundation.service.track(submit(scope, command, {week4: true, trace: {}}));
    },
  };
}
