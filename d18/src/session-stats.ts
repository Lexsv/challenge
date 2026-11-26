import type { ManagerConversationState } from "./manager-agent";
import type { SessionStats } from "../server/session-usage";
export {aggregateSessionStats, type SessionStats} from "../server/session-usage";
import { historicalContext } from "./context-compaction";
import {
  estimateManagerRequest,
  type ManagerRequestConfig,
} from "./manager-llm-adapter";
import { estimateContextInput } from "./token-meter";
import type { ToolRegistry } from "./tool-runtime";

const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
export type NextSessionContext = Omit<Awaited<ReturnType<typeof estimateManagerRequest>>, "contextWindow" | "requestTokenLimit"> & {
  contextWindow?: number;
  requestTokenLimit?: number;
  dialogueTokens?: number;
  compacted?: boolean;
  uncompressedInputTokens?: number;
  uncompressedApproximate?: boolean;
};

export async function estimateNextSessionContext(
  input: ManagerRequestConfig & {
    state: ManagerConversationState;
    draft: string;
    tools: ToolRegistry;
  },
): Promise<NextSessionContext> {
  const tools = input.tools.listBuiltIn().filter((tool) => tool.executable);
  const currentRun = "__next-session-send__";
  const compacted = !!input.state.contextEvents?.some(
    (event) => event.phase === "completed" && event.summary,
  );
  const estimate = (state: ManagerConversationState) =>
    estimateManagerRequest({
      ...input,
      tools,
      messages: [
        ...historicalContext(state, currentRun),
        { role: "user", content: input.draft },
      ],
    });
  const [compactEstimate, uncompressed] = await Promise.all([
    estimate(input.state),
    estimate({ ...input.state, contextEvents: [] }),
  ]);
  const full = uncompressed ?? compactEstimate;
  const next = full.requestTokenLimit === 0 && full.estimatedInputTokens !== undefined && full.inputBudget !== undefined && full.estimatedInputTokens <= full.inputBudget ? full : compactEstimate;
  const dialogue = historicalContext({ ...input.state, contextEvents: [] }, currentRun);
  const dialogueTokens = dialogue.length ? (await estimateContextInput(input.model, dialogue)).estimatedInputTokens : 0;
  return {
    ...next,
    dialogueTokens,
    compacted,
    uncompressedInputTokens: full.estimatedInputTokens,
    uncompressedApproximate: full.estimateApproximate,
  };
}

export function sessionContextReduction(
  context?: NextSessionContext,
  stats?: SessionStats,
): number | undefined {
  // Recorded same-request counts survive pending/failed next-request estimates and reload.
  if (stats) {
    const request = stats.lastAnswer;
    return request?.compacted && count(request.beforeInputTokens) && request.beforeInputTokens > 0 && count(request.afterInputTokens)
      ? Math.round((request.beforeInputTokens - request.afterInputTokens) / request.beforeInputTokens * 100)
      : 0;
  }
  const full = context?.uncompressedInputTokens;
  const compressed = context?.estimatedInputTokens;
  return context?.compacted &&
    full !== undefined &&
    full > 0 &&
    compressed !== undefined
    ? Math.round(((full - compressed) / full) * 100)
    : undefined;
}
