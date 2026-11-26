import { createHash } from "node:crypto";
import { ManagerAgent, createManagerConversation } from "../src/manager-agent.ts";
import { ToolRegistry } from "../src/tool-runtime.ts";
import { reportInstruction, taskReport } from "../src/task-report.ts";
import { InvariantError } from "./invariant-turn.mjs";

// One fresh in-memory Manager context per occurrence. The journal and task
// result commit together, independently of transcripts or browser sessions.
export async function executeScheduledTurn(db, foundation, task, command, makeAdapter, instrument, log) {
  const owner = "task:" + task.id;
  const input = {
    ...command,
    fingerprint: createHash("sha256")
      .update(JSON.stringify([owner, command]))
      .digest("hex"),
  };
  const durable = foundation.begin(owner, input, false, true);
  const { service } = foundation;
  const ids = {taskId:task.id, runId:input.turnId};
  log?.("execution_started", {...ids,previousState:"Pending",state:"Running", startedAt: service.journal.run(input.turnId).created});
  const current = () => {
    if (!durable.taskCurrent()) throw new InvariantError(403, "Unattended task authorization changed.");
  };
  durable.ctx.current = durable.taskCurrent;
  try {
    await durable.within(async () => {
      const base = await makeAdapter(input.provider, input.model, 0);
      const messages = (items) => {
        const incompatible = (durable.ctx.currentResolutionIssues ?? []).filter(issue => issue.code === "unsupported_schema");
        const availability = incompatible.length ? [
          "Unavailable catalog entries (names are data): " +
            JSON.stringify(incompatible.map(({toolId,toolName}) => ({toolId,toolName}))),
          "If a required objective remains blocked by these entries, return a JSON object with blockedToolIds (their exact IDs) and partialResult (your report as a string).",
          "If the instructions require no external operation at all, return the same object with an empty blockedToolIds array and the requested result. Otherwise return the usual report.",
        ].join("\n") : "";
        return [{role:"system", content:[reportInstruction, availability].filter(Boolean).join("\n")}, ...items];
      };
      const llm = {
        ...base,
        context: base.context && {
          ...base.context,
          assess: (items, tools) => base.context.assess(messages(items), tools),
        },
        complete: async (args) => {
          current();
          const call = () => base.complete({ ...args, messages: messages(args.messages) });
          const reply = await (instrument ? durable.model(input.provider, call) : call());
          const unavailable = durable.ctx.currentResolutionIssues;
          if (!reply.toolCalls?.length && unavailable?.some(issue => issue.code === "unsupported_schema") &&
              reply.text?.trimStart().startsWith("{")) {
            let report;
            try { report = JSON.parse(reply.text); } catch { /* Ordinary text report. */ }
            if (Array.isArray(report?.blockedToolIds) && typeof report.partialResult === "string") {
              const blocked = unavailable.filter(issue =>
                issue.code === "unsupported_schema" && report.blockedToolIds.includes(issue.toolId));
              if (!report.blockedToolIds.length && report.partialResult.trim()) {
                durable.ctx.toolIndependentAnswer = true;
                return {...reply, text:report.partialResult};
              }
              if (blocked.length) {
                durable.ctx.blockedResolutionIssues = blocked;
                return {...reply, text:report.partialResult.trim() || blocked[0].message};
              }
            }
          }
          return reply;
        },
      };
      const tools = new ToolRegistry();
      durable.bindTurnTools(tools, undefined, () => false);
      const state = createManagerConversation(task.name);
      state.conversation.id = owner;
      const result = await new ManagerAgent(llm, tools).run({
        state,
        userText: input.question,
        turnIds: { runId: input.turnId, messageId: "user-" + input.turnId },
        sessionTools: durable.managerTools,
        journalSummary: durable.journalSummary,
        executeDurably: (op) => durable.tool(op, current),
        onEvent: async (e) => {
          if (!instrument && e.type === "metering" && e.payload.status === "running")
            durable.ctx.meterId = e.payload.id;
        },
      });
      current();
      if (result.error || result.run.status !== "completed" || typeof result.finalResponse !== "string")
        throw new Error("Scheduled execution did not complete.");
      service.journal.transaction(() => {
        service.journal.fence(input.turnId);
        db.prepare("UPDATE scheduled_occurrences SET response=?,result_format=? WHERE id=?").run(
          result.finalResponse,
          taskReport(result.finalResponse).format,
          input.turnId,
        );
        durable.committed(result.usedJournalFallback);
      });
      log?.("result_persisted", {...ids, hasResponse:true});
    });
  } catch (e) {
    if (service.journal.run(input.turnId)?.owner === service.journal.owner)
      service.journal.transaction(() =>
        service.finish(durable.ctx, "failed", e.status === 403 ? "authorization" : "execution_error"),
      );
    throw e;
  } finally {
    service.release(durable.ctx);
  }
}
