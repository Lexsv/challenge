import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  aggregateSessionStats,
  estimateNextSessionContext,
  sessionContextReduction,
} from "./session-stats";
import { SessionStatsContent } from "./session-stats-panel";
import { createManagerConversation } from "./manager-agent";
import { createBuiltInToolRegistry } from "./tool-runtime";
import { ProviderRegistry } from "./provider-registry";
import {
  createManagerLlmAdapter,
  managerContextBudget,
  estimateManagerRequest,
} from "./manager-llm-adapter";
import { historicalContext } from "./context-compaction";
import { restoreHistory, type HistoryEvent } from "./conversation-history";
import type { ModelRequestMeter } from "./token-meter";

const pricing = {
  currency: "USD" as const,
  inputPerMillion: 0.15,
  outputPerMillion: 0.6,
  source: "openai-model-page" as const,
  asOf: "2026-11-11",
};
function fixture() {
  const state = createManagerConversation();
  const sid = state.conversation.id;
  const meter = (
    id: string,
    patch: Partial<ModelRequestMeter> = {},
  ): ModelRequestMeter => ({
    id,
    sessionId: sid,
    runId: "run",
    provider: "openai",
    model: "gpt-4o-mini",
    library: "js-tiktoken",
    startedAt: 1,
    status: "completed",
    ...patch,
  });
  state.requestMeters = [
    meter("rejected", {
      status: "failed",
      estimatedInputTokens: 999,
      estimatedInputCost: 0.9,
      pricing,
    }),
    meter("retry", {
      actualModel: "gpt-4o-mini-2024-07-18",
      actualInputTokens: 100,
      actualOutputTokens: 20,
      estimatedRequestCost: 0.002,
      actualPricing: pricing,
    }),
    meter("summary", {
      model: "gpt-5.6-terra",
      actualInputTokens: 50,
      actualOutputTokens: 0,
    }),
    meter("retry", {
      actualModel: "gpt-4o-mini-2024-07-18",
      actualInputTokens: 100,
      actualOutputTokens: 20,
      estimatedRequestCost: 0.002,
      actualPricing: pricing,
    }),
    meter("foreign", {
      sessionId: "another-session",
      actualInputTokens: 90000,
      estimatedRequestCost: 99,
      actualPricing: pricing,
    }),
  ];
  state.runs = [
    {
      id: "run",
      conversationId: sid,
      agentId: "manager",
      status: "completed",
      startedAt: 1000,
      endedAt: 3000,
      messageIds: [],
      toolExecutionIds: [],
    },
    {
      id: "next",
      conversationId: sid,
      agentId: "manager",
      status: "completed",
      startedAt: 100000,
      endedAt: 103500,
      messageIds: [],
      toolExecutionIds: [],
    },
    {
      id: "pending",
      conversationId: sid,
      agentId: "manager",
      status: "running",
      startedAt: 105000,
      messageIds: [],
      toolExecutionIds: [],
    },
    {
      id: "failure",
      conversationId: sid,
      agentId: "manager",
      status: "failed",
      startedAt: 0,
      endedAt: 900000,
      messageIds: [],
      toolExecutionIds: [],
    },
  ];
  state.contextEvents = [
    {
      id: "summary",
      runId: "next",
      phase: "completed",
      createdAt: 100100,
      summary: "Saved amount: 11234 JPY.",
      coveredEventId: "boundary",
      coveredRunIds: ["run"],
      beforeTokens: 9000,
      afterTokens: 1700,
    },
  ];
  return { state, meter };
}

it("counts requests including retries and summaries, folds snapshots, and uses reported models when available", () => {
  const { state } = fixture();
  const before = structuredClone(state);
  const stats = aggregateSessionStats(state);
  expect(stats.requestCount).toBe(3);
  expect(stats.models.map((model) => [model.model, model.requests])).toEqual([
    ["gpt-5.6-terra", 1],
    ["gpt-4o-mini-2024-07-18", 1],
    ["gpt-4o-mini", 1],
  ]);
  expect(stats.input).toEqual({
    knownTokens: 150,
    reportedRequests: 2,
    missingRequests: 1,
  });
  expect(stats.output).toEqual({
    knownTokens: 20,
    reportedRequests: 2,
    missingRequests: 1,
  });
  expect(stats.activeTime).toEqual({
    milliseconds: 5500,
    completedRuns: 2,
    missingDurations: 0,
  });
  expect(stats.cost).toEqual({
    subtotals: [{ currency: "USD", subtotal: 0.002, requests: 1 }],
    pricedRequests: 1,
    excludedRequests: 2,
  });
  expect(stats.latestCompaction).toEqual({
    beforeTokens: 9000,
    afterTokens: 1700,
  });
  expect(state).toEqual(before);
});

it("lists unique models by latest request, without promoting a late usage snapshot", () => {
  const { state, meter } = fixture();
  state.requestMeters = [
    meter("first", { model: "model-a" }),
    meter("second", { model: "model-b" }),
    meter("third", { model: "model-a", provider: "opencode-console" }),
    meter("first", { model: "model-a", endedAt: 999 }),
  ];
  expect(
    aggregateSessionStats(state).models.map((m) => [m.model, m.requests]),
  ).toEqual([
    ["model-a", 2],
    ["model-b", 1],
  ]);
  state.requestMeters.push(meter("fourth", { model: "model-b" }));
  expect(aggregateSessionStats(state).models.map((m) => m.model)).toEqual([
    "model-b",
    "model-a",
  ]);
});

it("compares full saved history with Manager summary/retained turns using one selected configuration", async () => {
  const { state } = fixture();
  state.messages = [
    {
      id: "old-user",
      conversationId: state.conversation.id,
      runId: "run",
      role: "user",
      type: "text",
      createdAt: 1,
      text: "Convert CAD to JPY. ".repeat(200),
    },
    {
      id: "old-answer",
      conversationId: state.conversation.id,
      runId: "run",
      role: "assistant",
      type: "text",
      createdAt: 2,
      text: "The exact saved result is 11234 JPY. ".repeat(100),
    },
    {
      id: "recent",
      conversationId: state.conversation.id,
      runId: "next",
      role: "user",
      type: "text",
      createdAt: 3,
      text: "Keep this recent turn.",
    },
  ];
  const before = structuredClone(state);
  const registry = new ProviderRegistry();
  const tools = createBuiltInToolRegistry();
  const config = {
    providerId: "openai" as const,
    model: "gpt-4o-mini",
    registry,
    maxOutputTokens: 2048,
    requestTokenLimit: 2000,
  };
  const draft = "Add tax to the exact saved result";
  const result = await estimateNextSessionContext({
    ...config,
    state,
    draft,
    tools,
  });
  const expectedFull = await estimateManagerRequest({
    ...config,
    tools: tools.listBuiltIn().filter((t) => t.executable),
    messages: [
      ...historicalContext(
        { ...state, contextEvents: [] },
        "__next-session-send__",
      ),
      { role: "user", content: draft },
    ],
  });
  expect(result.uncompressedInputTokens).toBe(
    expectedFull.estimatedInputTokens,
  );
  expect(result.uncompressedInputTokens).toBeGreaterThan(
    result.estimatedInputTokens!,
  );
  expect(sessionContextReduction(result)).toBe(
    Math.round(
      ((result.uncompressedInputTokens! - result.estimatedInputTokens!) /
        result.uncompressedInputTokens!) *
        100,
    ),
  );
  const html = renderToStaticMarkup(
    <SessionStatsContent
      stats={aggregateSessionStats(state)}
      context={result}
    />,
  );
  const labels = [...html.matchAll(/<dt[^>]*>([^<]+)<\/dt>/g)].map((m) => m[1]);
  expect(labels).toEqual([
    "Models used",
    "Requests",
    "Tokens",
    "Input",
    "Output",
    "Total",
    "Active time",
    "Cost (≈)",
    "Context", "Model window", "Dialogue", "Compaction target", "Last request",
  ]);
  expect(html).toContain("padding-top:20px");
  expect(html).not.toContain("<hr");
  expect(html).not.toContain("Last compaction");
  expect(state).toEqual(before);
  const plain = await estimateNextSessionContext({
    ...config,
    state: { ...state, contextEvents: [] },
    draft,
    tools,
  });
  expect(plain.uncompressedInputTokens).toBe(plain.estimatedInputTokens);
  expect(plain.compacted).toBe(false);
  const plainHtml = renderToStaticMarkup(
    <SessionStatsContent
      stats={aggregateSessionStats({ ...state, contextEvents: [] })}
      context={plain}
    />,
  );
  expect(plainHtml).toContain("Last request");
  expect(plainHtml).not.toContain("Uncompressed context");
  expect(plainHtml).not.toContain("Reduction");
});

it("hides reduction until both estimates and a positive full-history count are available", () => {
  const base = {
    compacted: true,
    estimatedInputTokens: 20,
    uncompressedInputTokens: 100,
    replyTokens: 1024,
    uncertaintyTokens: 1024,
    inputBudget: 8000,
  };
  expect(sessionContextReduction(base)).toBe(80);
  for (const incomplete of [
    { ...base, uncompressedInputTokens: 0 },
    { ...base, uncompressedInputTokens: undefined },
    { ...base, estimatedInputTokens: undefined },
    { ...base, compacted: false },
  ]) {
    expect(sessionContextReduction(incomplete)).toBeUndefined();
    expect(
      renderToStaticMarkup(<SessionStatsContent context={incomplete} />),
    ).not.toContain("Reduction");
  }
});

it("keeps zero distinct from missing usage/cost and never substitutes an input-only cost estimate", () => {
  const { state, meter } = fixture();
  state.requestMeters = [
    meter("zero", {
      actualInputTokens: 0,
      actualOutputTokens: 0,
      estimatedRequestCost: 0,
      actualPricing: pricing,
    }),
  ];
  const zero = aggregateSessionStats(state);
  expect(zero.input.reportedRequests).toBe(1);
  expect(zero.cost.subtotals[0].subtotal).toBe(0);
  let html = renderToStaticMarkup(<SessionStatsContent stats={zero} />);
  expect(html).toContain(">0</dd>");
  expect(html).toContain("$0.000 USD");
  state.requestMeters = [meter("unknown", { estimatedInputCost: 2, pricing })];
  html = renderToStaticMarkup(
    <SessionStatsContent stats={aggregateSessionStats(state)} />,
  );
  expect(html).toContain("Not reported");
  expect(html).toContain("Unavailable");
  expect(html).not.toContain("requests excluded");
  expect(html).not.toContain("2.000000");
});

it("does not reuse an older compaction count when the latest has partial metadata", () => {
  const { state } = fixture();
  state.contextEvents!.push({
    id: "latest",
    runId: "next",
    phase: "completed",
    createdAt: 2,
    beforeTokens: 12000,
  });
  expect(aggregateSessionStats(state).latestCompaction).toBeUndefined();
  const html = renderToStaticMarkup(
    <SessionStatsContent stats={aggregateSessionStats(state)} />,
  );
  expect(html).not.toContain("Last compaction");
});

it("preserves independent usage coverage, safely excludes missing/invalid completed durations, and handles empty sessions", () => {
  const { state, meter } = fixture();
  state.requestMeters = [
    meter("input-only", { actualInputTokens: 10 }),
    meter("output-only", { actualOutputTokens: 5 }),
  ];
  state.runs[1].endedAt = undefined;
  const stats = aggregateSessionStats(state);
  expect(stats.input).toEqual({
    knownTokens: 10,
    reportedRequests: 1,
    missingRequests: 1,
  });
  expect(stats.output).toEqual({
    knownTokens: 5,
    reportedRequests: 1,
    missingRequests: 1,
  });
  expect(stats.activeTime).toEqual({
    milliseconds: 2000,
    completedRuns: 2,
    missingDurations: 1,
  });
  const empty = aggregateSessionStats(createManagerConversation());
  expect(empty.requestCount).toBe(0);
  expect(empty.activeTime.milliseconds).toBe(0);
  expect(renderToStaticMarkup(<SessionStatsContent stats={empty} />)).toContain(
    "Models used",
  );
});

it("restores request identities from persisted snapshots without double-counting and keeps sessions isolated", () => {
  const { state, meter } = fixture();
  const sid = state.conversation.id;
  const events: HistoryEvent[] = [
    {
      id: "start",
      sessionId: sid,
      sequence: 1,
      type: "metering",
      payload: meter("same", { status: "running" }),
    },
    {
      id: "end",
      sessionId: sid,
      sequence: 2,
      type: "metering",
      payload: meter("same", {
        status: "completed",
        endedAt: 2,
        actualInputTokens: 30,
        actualOutputTokens: 5,
      }),
    },
    {
      id: "retry",
      sessionId: sid,
      sequence: 3,
      type: "metering",
      payload: meter("new-attempt", { status: "failed", endedAt: 3 }),
    },
  ];
  const restored = restoreHistory(
    { ...createManagerConversation(), conversation: state.conversation },
    events,
  );
  expect(aggregateSessionStats(restored).requestCount).toBe(2);
  expect(aggregateSessionStats(restored).input.knownTokens).toBe(30);
  expect(aggregateSessionStats(createManagerConversation()).requestCount).toBe(
    0,
  );
});

it("estimates the next send using the actual adapter payload/budget without a provider request or mutation", async () => {
  const { state } = fixture();
  const before = structuredClone(state);
  const registry = new ProviderRegistry();
  const tools = createBuiltInToolRegistry();
  const fetcher = vi.fn();
  const config = {
    providerId: "openai" as const,
    model: "gpt-4o-mini",
    registry,
    maxOutputTokens: 2048,
    requestTokenLimit: 2000,
  };
  const draft = "Add tax to the saved result";
  const next = await estimateNextSessionContext({
    ...config,
    state,
    draft,
    tools,
  });
  const adapter = createManagerLlmAdapter({
    ...config,
    apiKey: "placeholder",
    fetcher,
  });
  const actual = await adapter.context!.assess(
    [
      ...historicalContext(state, "__next-session-send__"),
      { role: "user", content: draft },
    ],
    tools.listBuiltIn().filter((tool) => tool.executable),
  );
  expect(next.estimatedInputTokens).toBe(actual.tokens);
  expect(next.inputBudget).toBe(actual.limit);
  expect(next.replyTokens).toBe(2048);
  expect(next.inputBudget).toBe(113152);
  expect(fetcher).not.toHaveBeenCalled();
  expect(state).toEqual(before);
  const switched = await estimateNextSessionContext({
    ...config,
    model: "gpt-4.1",
    state,
    draft,
    tools,
  });
  expect(switched.inputBudget).toBeGreaterThan(next.inputBudget!);
  const unknown = await estimateNextSessionContext({
    ...config,
    model: "unsupported-future-model",
    state,
    draft,
    tools,
  });
  expect(unknown.inputBudget).toBeUndefined();
  expect(unknown.estimatedInputTokens).toBeGreaterThan(0);
  expect(unknown.estimateApproximate).toBe(true);
  expect(managerContextBudget(config).replyTokens).toBe(2048);
});

it("presents partial coverage and context/compaction counts without hiding unknowns", () => {
  const { state } = fixture();
  const html = renderToStaticMarkup(
    <SessionStatsContent
      stats={aggregateSessionStats(state)}
      context={{
        estimatedInputTokens: 1800,
        inputBudget: 8000,
        replyTokens: 1024,
        uncertaintyTokens: 1024,
      }}
    />,
  );
  expect(html).not.toContain("Partial");
  expect(html).toContain("Last request");
  expect(html).toContain("Dialogue");
  expect(html).toContain("Last request");
  expect(html).toContain("font-weight:700");
  expect(html).toContain("text-align:right");
  expect(html).not.toContain("requests excluded");
});

it.each([
  [{ actualInputTokens: 12, actualOutputTokens: 3 }, 15],
  [{ actualInputTokens: 12 }, 12],
  [{ actualOutputTokens: 3 }, 3],
  [{ actualInputTokens: 0, actualOutputTokens: 0 }, 0],
  [{ actualTotalTokens: 99 }, undefined],
])(
  "sums only available reported input/output counts: %j",
  (usage, expected) => {
    const { state, meter } = fixture();
    state.requestMeters = [meter("reported", usage)];
    const stats = aggregateSessionStats(state);
    expect(stats.total.knownTokens).toBe(expected ?? 0);
    expect(stats.total.reportedValues > 0).toBe(expected !== undefined);
    const html = renderToStaticMarkup(<SessionStatsContent stats={stats} />);
    expect(html).toMatch(
      new RegExp(
        `Total</dt><dd[^>]*>${expected ?? "Not reported"}</dd>`,
      ),
    );
  },
);

it("rounds the full-precision cost subtotal once and removes token/cost Partial labels", () => {
  const { state, meter } = fixture();
  state.requestMeters = [
    meter("one", { estimatedRequestCost: 0.00031485, actualPricing: pricing }),
    meter("two", { estimatedRequestCost: 0.00031485, actualPricing: pricing }),
    meter("missing"),
  ];
  const stats = aggregateSessionStats(state);
  expect(stats.cost.subtotals[0].subtotal).toBeCloseTo(0.0006297, 10);
  const html = renderToStaticMarkup(<SessionStatsContent stats={stats} />);
  expect(html).toContain("$0.001 USD");
  expect(html).not.toContain("$0.000 USD");
  expect(html).not.toContain("Partial");
});

it("recounts drafts and switches OpenAI/DeepSeek with the same Manager payload and safety budget", async () => {
  const { state } = fixture();
  const registry = new ProviderRegistry();
  let known = true;
  registry.register({
    id: "opencode-console",
    catalog: () => ["deepseek-v4.1-flash"],
    capabilities: () => undefined,
    limits: () =>
      known ? { contextWindow: 32768, maxOutputTokens: 8192 } : undefined,
    validate: () => undefined,
    execute: vi.fn(),
  });
  const tools = createBuiltInToolRegistry();
  const fetcher = vi.fn();
  const config = {
    providerId: "opencode-console" as const,
    model: "deepseek-v4.1-flash",
    registry,
    maxOutputTokens: 2048,
    requestTokenLimit: 2000,
  };
  const draft = "Use the saved JPY result";
  const deepseek = await estimateNextSessionContext({
    ...config,
    state,
    draft,
    tools,
  });
  expect(deepseek).toMatchObject({
    estimateApproximate: true,
    encoding: "o200k_base",
    replyTokens: 2048,
    uncertaintyTokens: 3277,
    inputBudget: 27443,
  });
  const adapter = createManagerLlmAdapter({
    ...config,
    apiKey: "placeholder",
    fetcher,
  });
  const assessed = await adapter.context!.assess(
    [
      ...historicalContext(state, "__next-session-send__"),
      { role: "user", content: draft },
    ],
    tools.listBuiltIn().filter((t) => t.executable),
  );
  expect(deepseek.estimatedInputTokens).toBe(assessed.tokens);
  expect(deepseek.inputBudget).toBe(assessed.limit);
  const edited = await estimateNextSessionContext({
    ...config,
    state,
    draft: draft.repeat(100),
    tools,
  });
  expect(edited.estimatedInputTokens).toBeGreaterThan(
    deepseek.estimatedInputTokens!,
  );
  const openai = await estimateNextSessionContext({
    ...config,
    providerId: "openai",
    model: "gpt-4o-mini",
    state,
    draft,
    tools,
  });
  expect(openai.estimateApproximate).toBe(false);
  expect(openai.inputBudget).not.toBe(deepseek.inputBudget);
  const html = renderToStaticMarkup(<SessionStatsContent context={deepseek} />);
  expect(html).toContain("Last request");
  expect(html).toContain("Model window");
  expect(deepseek.inputBudget).toBe(27443);
  known = false;
  const unknown = await estimateNextSessionContext({
    ...config,
    state,
    draft,
    tools,
  });
  expect(unknown.inputBudget).toBeUndefined();
  const unknownHtml = renderToStaticMarkup(
    <SessionStatsContent context={unknown} />,
  );
  expect(unknownHtml).toContain("Last request");
  expect(unknownHtml).not.toContain(" / ");
  expect(fetcher).not.toHaveBeenCalled();
});

it('renders recorded same-request reduction directly after Next request during recalculation', () => {
  const { state } = fixture();
  const stats = aggregateSessionStats(state);
  const html = renderToStaticMarkup(<SessionStatsContent stats={stats} contextPending />);
  expect(html).toContain("Last request");expect(html).not.toContain("Reduction");
  // Later draft/model estimates cannot change what the recorded compaction saved.
  expect(sessionContextReduction({ compacted: true, uncompressedInputTokens: 100, estimatedInputTokens: 99, replyTokens: 1024, inputBudget: 8000, uncertaintyTokens: 1024 }, stats)).toBe(0);
  expect(sessionContextReduction(undefined, { ...stats, hasCompaction: false })).toBe(0);
  expect(sessionContextReduction(undefined, { ...stats, latestCompaction: undefined })).toBe(0);
  expect(sessionContextReduction(undefined, { ...stats, latestCompaction: { beforeTokens: 0, afterTokens: 0 } })).toBe(0);
});
