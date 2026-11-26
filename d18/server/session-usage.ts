import type { ManagerConversationState } from "../src/manager-agent.ts";
import type { ModelRequestMeter } from "../src/token-meter.ts";
const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const amount = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

/** Session-scoped accounting only; never fetches, writes events, or executes tools. */
export function aggregateSessionStats(
  state: Pick<
    ManagerConversationState,
    "requestMeters" | "runs" | "contextEvents"
  > & { conversation: { id: string } },
) {
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
      milliseconds: number;
      timedRequests: number;
      usd: number;
      pricedRequests: number;
      receiptCount: number;
    }
  >();
  for (const meter of [...requests].reverse()) {
    const model = meter.actualModel ?? meter.model;
    const key = JSON.stringify([meter.provider, model]);
    const row = models.get(key) ?? {
      provider: meter.provider,
      model,
      requests: 0,
      reportedModelRequests: 0,
      milliseconds: 0,
      timedRequests: 0,
      usd: 0,
      pricedRequests: 0,
      receiptCount: 0,
    };
    row.requests++;
    if (
      amount(meter.endedAt) &&
      amount(meter.startedAt) &&
      meter.endedAt >= meter.startedAt
    ) {
      row.milliseconds += meter.endedAt - meter.startedAt;
      row.timedRequests++;
    }
    const receipt = amount(meter.providerRequestCost);
    const cost = receipt
      ? meter.providerRequestCost
      : meter.estimatedRequestCost;
    if (
      amount(cost) &&
      (receipt || (meter.actualPricing ?? meter.pricing)?.currency === "USD")
    ) {
      row.usd += cost;
      row.pricedRequests++;
      if (receipt && !meter.providerCostEstimated) row.receiptCount++;
    }
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
  const summary = {
    requests: requests.length,
    modelsUsed: models.size,
    milliseconds: 0,
    timedRequests: 0,
    usd: 0,
    pricedRequests: 0,
    receiptCount: 0,
  };
  for (const row of models.values()) {
    summary.milliseconds += row.milliseconds;
    summary.timedRequests += row.timedRequests;
    summary.usd += row.usd;
    summary.pricedRequests += row.pricedRequests;
    summary.receiptCount += row.receiptCount;
  }
  const pricedRequests = summary.pricedRequests;
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
  const lastAnswer = [...requests]
    .reverse()
    .find((m) => m.requestKind !== "summary" && m.requestKind !== "extraction");
  return {
    lastAnswer,
    summary,
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
      subtotals: pricedRequests
        ? [{ currency: "USD", subtotal: summary.usd, requests: pricedRequests }]
        : [],
      pricedRequests,
      providerReportedRequests: summary.receiptCount,
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
