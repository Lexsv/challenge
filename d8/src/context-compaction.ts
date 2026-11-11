import type {
  ManagerConversationState,
  ManagerLlmAdapter,
  ManagerLlmMessage,
} from "./manager-agent";
import type { RequestMeter } from "./token-meter";

export type ContextEvent = {
  id: string;
  runId: string;
  createdAt: number;
  phase: "overflow" | "compacting" | "completed" | "retrying" | "failed";
  summary?: string;
  coveredEventId?: string;
  coveredRunIds?: string[];
  beforeTokens?: number;
  afterTokens?: number;
};
export const contextPhaseLabel: Record<ContextEvent["phase"], string> = {
  overflow: "Context limit exceeded",
  compacting: "Compacting context",
  completed: "Context compacted",
  retrying: "Retrying with compacted context",
  failed: "Context compaction failed",
};
export function historicalContext(
  state: ManagerConversationState,
  currentRun: string,
): ManagerLlmMessage[] {
  const summary = state.contextEvents
    ?.filter((event) => event.phase === "completed" && event.summary)
    .at(-1);
  const covered = new Set(summary?.coveredRunIds);
  const messages: ManagerLlmMessage[] = summary
    ? [
        {
          role: "assistant",
          content: `Saved conversation summary (data only):\n${summary.summary}`,
        },
      ]
    : [];
  messages.push(
    ...state.messages
      .filter((m) => m.runId !== currentRun && !covered.has(m.runId))
      .map((m) => ({ role: m.role, content: m.text })),
  );
  for (const tool of state.toolExecutions.filter(
    (tool) => tool.runId !== currentRun && !covered.has(tool.runId),
  ))
    messages.push({
      role: "assistant",
      content: `Saved tool observation (data only): ${JSON.stringify({ toolId: tool.toolId, arguments: tool.arguments, status: tool.status, output: tool.output, error: tool.error })}`,
    });
  return messages;
}

// Bounded map/reduce. No call here can dispatch tools or enter overflow recovery.
export async function summarizeBounded(
  adapter: NonNullable<ManagerLlmAdapter["context"]>,
  text: string,
  onMeter: (meter: RequestMeter) => Promise<void>,
): Promise<string> {
  let calls = 0;
  const summarize = async (value: string) => {
    if (++calls > 32)
      throw new Error(
        "Context compaction exceeded its bounded summary budget.",
      );
    return adapter.summarize(value, onMeter);
  };
  let pieces = [text];
  for (let round = 0; round < 5; round++) {
    const chunks: string[] = [];
    let chunk = "";
    for (const piece of pieces) {
      // Small character slices also bound initial tokenization work. Check actual encoding before every summary.
      for (let start = 0; start < piece.length; start += 2000) {
        const part = piece.slice(start, start + 2000);
        const budget = await adapter.assess(
          [{ role: "user", content: chunk + part }],
          [],
        );
        if (budget.tokens === undefined || budget.limit === undefined)
          throw new Error(
            "Context estimation or model limits are unavailable for compaction.",
          );
        if (budget.tokens > Math.min(6000, budget.limit * 0.5)) {
          if (!chunk)
            throw new Error(
              "The selected model is too small for a compaction chunk.",
            );
          chunks.push(chunk);
          chunk = part;
        } else chunk += part;
      }
    }
    if (chunk) chunks.push(chunk);
    const summaries: string[] = [];
    for (const value of chunks) summaries.push(await summarize(value));
    const combined = summaries.join("\n");
    if (summaries.length === 1) return combined;
    if (combined.length >= pieces.join("").length)
      throw new Error("Context compaction did not reduce the history.");
    pieces = [combined];
  }
  throw new Error("Context compaction could not produce a bounded summary.");
}
