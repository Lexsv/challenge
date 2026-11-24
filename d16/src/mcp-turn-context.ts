import type { ManagerLlmMessage } from "./manager-agent";
import { mcpResultEvidence } from "./mcp-result-evidence.ts";

// Replace a whole completed exchange on the next model request only. Never
// shorten executable arguments, split call/result pairs, or edit the journal.
export function compactToolExchange(
  messages: ManagerLlmMessage[],
  names: ReadonlyMap<string, string>,
) {
  const start = messages.findIndex(
    (m) => m.role === "assistant" && m.toolCalls?.length,
  );
  if (start < 0) return;
  const calls = messages[start].toolCalls!;
  const replies = messages.slice(start + 1, start + 1 + calls.length);
  if (
    replies.length !== calls.length ||
    replies.some((r, i) => r.role !== "tool" || r.toolCallId !== calls[i].id)
  )
    return;
  const receipts = replies.map((r, i) => {
    const result = JSON.parse(r.content);
    const evidence = mcpResultEvidence(
      calls[i].toolId.startsWith("mcp:") ? result.output : null,
    );
    const smallResult =
      result.ok && JSON.stringify(result.output ?? null).length <= 512
        ? result.output
        : undefined;
    return {
      ...(smallResult !== undefined && { result: smallResult }),
      call: calls[i].id,
      tool: names.get(calls[i].toolId) ?? calls[i].toolId,
      outcome: result.outcome ?? (result.ok ? "Success" : "Failed"),
      ...(smallResult === undefined && calls[i].toolId.startsWith("mcp:") && result.output?.compatibilityWarning?.code === "unsupported_content" &&
        { compatibilityWarning: result.output.compatibilityWarning }),
      ...(evidence.links.length && { links: evidence.links }),
      ...(evidence.created && { created: true }),
      ...(result.error && {
        error: result.error.code,
        certainty: result.error.certainty,
        skipReason: result.error.skipReason,
        diagnostic: result.error.diagnostic,
      }),
    };
  });
  const checkpoint: ManagerLlmMessage = {
    role: "assistant",
    content:
      "Completed tool exchange (full arguments and results omitted for context budget; use a narrow read if more evidence is needed): " +
      JSON.stringify(receipts),
  };
  return [
    ...messages.slice(0, start),
    checkpoint,
    ...messages.slice(start + 1 + calls.length),
  ];
}
