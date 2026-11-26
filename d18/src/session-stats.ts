import type { ManagerConversationState } from "./manager-agent";
import type { ModelRequestMeter } from "./token-meter";
import { historicalContext } from "./context-compaction";
import {
  estimateManagerRequest,
  type ManagerRequestConfig,
} from "./manager-llm-adapter";
import { estimateContextInput } from "./token-meter";
import type { ToolRegistry } from "./tool-runtime";

const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const amount = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

/** Session-scoped accounting only; never fetches, writes events, or executes tools. */
export function aggregateSessionStats(state: ManagerConversationState) {
  const meters = new Map<string, ModelRequestMeter>();
  for (const meter of state.requestMeters ?? [])
    if (meter.sessionId === state.conversation.id) meters.set(meter.id, meter);
  const requests = [...meters.values()];
  const models = new Map<
    string,
    {
      provider: string;
      model: string;
      requests: number;
      reportedModelRequests: number;
    }
  >();
  for (const meter of [...requests].reverse()) {
    const model = meter.actualModel ?? meter.model;
    const key = model;
    const row = models.get(key) ?? {
      provider: meter.provider,
      model,
      requests: 0,
      reportedModelRequests: 0,
    };
    row.requests++;
    if (meter.actualModel) row.reportedModelRequests++;
    models.set(key, row);
  }
  const usage = (key: "actualInputTokens" | "actualOutputTokens") => {
    const reported = requests.filter((meter) => count(meter[key]));
    return {
      knownTokens: reported.reduce((total, meter) => total + meter[key]!, 0),
      reportedRequests: reported.length,
      missingRequests: requests.length - reported.length,
    };
  };
  const costs = new Map<
    string,
    { currency: string; subtotal: number; requests: number }
  >();
  let pricedRequests = 0;
  for (const meter of requests) {
    // Input-only projections are not complete request estimates and must not be mixed into this total.
    const currency = (meter.actualPricing ?? meter.pricing)?.currency;
    if (!amount(meter.estimatedRequestCost) || !currency) continue;
    const row = costs.get(currency) ?? { currency, subtotal: 0, requests: 0 };
    row.subtotal += meter.estimatedRequestCost;
    row.requests++;
    pricedRequests++;
    costs.set(currency, row);
  }
  const runs = [
    ...new Map(
      state.runs
        .filter((run) => run.conversationId === state.conversation.id)
        .map((run) => [run.id, run]),
    ).values(),
  ];
  const completed = runs.filter((run) => run.status === "completed");
  const timed = completed.filter(
    (run) =>
      amount(run.startedAt) &&
      amount(run.endedAt) &&
      run.endedAt! >= run.startedAt,
  );
  const latest = state.contextEvents
    ?.filter((event) => event.phase === "completed")
    .at(-1);
  const input = usage("actualInputTokens");
  const output = usage("actualOutputTokens");
  const lastAnswer = [...requests].reverse().find(m => m.requestKind !== 'summary' && m.requestKind !== 'extraction');
  return {
    lastAnswer,
    sessionId: state.conversation.id,
    requestCount: requests.length,
    models: [...models.values()],
    input,
    output,
    total: {
      knownTokens: input.knownTokens + output.knownTokens,
      reportedValues: input.reportedRequests + output.reportedRequests,
    },
    activeTime: {
      milliseconds: timed.reduce(
        (total, run) => total + run.endedAt! - run.startedAt,
        0,
      ),
      completedRuns: completed.length,
      missingDurations: completed.length - timed.length,
    },
    cost: {
      subtotals: [...costs.values()],
      pricedRequests,
      excludedRequests: requests.length - pricedRequests,
    },
    hasCompaction: !!state.contextEvents?.some(
      (event) => event.phase === "completed" && event.summary,
    ),
    latestCompaction:
      latest && count(latest.beforeTokens) && count(latest.afterTokens)
        ? { beforeTokens: latest.beforeTokens, afterTokens: latest.afterTokens }
        : undefined,
  };
}
export type SessionStats = ReturnType<typeof aggregateSessionStats>;
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
