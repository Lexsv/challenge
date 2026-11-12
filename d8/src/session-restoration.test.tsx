import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { restoreSessionModelPair } from "./session-model-selection";
import { SessionContextCache } from "./session-context-cache";
import { SessionStatsContent } from "./session-stats-panel";
import { createManagerConversation } from "./manager-agent";
import { restoreHistory, type HistoryEvent } from "./conversation-history";
import { ProviderRegistry } from "./provider-registry";
import { createManagerLlmAdapter } from "./manager-llm-adapter";
import { estimateNextSessionContext } from "./session-stats";
import { createBuiltInToolRegistry } from "./tool-runtime";

function registry() {
  return new ProviderRegistry(
    ["openai", "opencode-console"].map((id) => ({
      id,
      allowUndiscoveredSelection: true,
      catalog: () =>
        id === "openai" ? ["gpt-4o-mini"] : ["deepseek-v4.1-flash"],
      capabilities: () => undefined,
      limits: () => ({ contextWindow: 32768, maxOutputTokens: 8192 }),
      validate: () => undefined,
      execute: vi.fn(),
    })),
  );
}
function history(
  sessionId: string,
  provider: string,
  model: string,
): HistoryEvent[] {
  const meter = {
    id: "request",
    sessionId,
    runId: "run",
    provider,
    model,
    actualModel: "reported-alias-not-a-picker-id",
    library: "js-tiktoken" as const,
    startedAt: 1,
    status: "running" as const,
  };
  return [
    { id: "start", sessionId, sequence: 1, type: "metering", payload: meter },
    {
      id: "finish",
      sessionId,
      sequence: 2,
      type: "metering",
      payload: { ...meter, status: "completed", endedAt: 2 },
    },
  ];
}

it("restores two independent session pairs from request metadata on reopening and reload, and uses each for send/context", async () => {
  const providers = registry();
  for (const [provider, model] of [
    ["openai", "gpt-4o-mini"],
    ["opencode-console", "deepseek-v4.1-flash"],
  ] as const) {
    const initial = createManagerConversation();
    const events = JSON.parse(
      JSON.stringify(history(initial.conversation.id, provider, model)),
    );
    for (let reload = 0; reload < 2; reload++) {
      const restored = restoreHistory(initial, events);
      const pair = restoreSessionModelPair(restored, providers, "gpt-4o-mini");
      expect(pair).toEqual({ provider, model });
      const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
        expect(JSON.parse(init!.body as string).model).toBe(model);
        return new Response(
          JSON.stringify(
            provider === "openai"
              ? {
                  output: [
                    {
                      type: "message",
                      content: [{ type: "output_text", text: "OK" }],
                    },
                  ],
                }
              : { choices: [{ message: { content: "OK" } }] },
          ),
        );
      });
      const adapter = createManagerLlmAdapter({
        providerId: pair.provider,
        model: pair.model,
        registry: providers,
        apiKey: "placeholder",
        fetcher,
      });
      const next = await estimateNextSessionContext({
        providerId: pair.provider,
        model: pair.model,
        registry: providers,
        state: restored,
        draft: "Continue",
        tools: createBuiltInToolRegistry(),
      });
      expect(next.estimateApproximate).toBe(provider === "opencode-console");
      expect(fetcher).not.toHaveBeenCalled();
      await adapter.complete({
        messages: [{ role: "user", content: "Continue" }],
        tools: [],
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  }
});

it("uses request creation order rather than late completion snapshots and makes unavailable saved pairs explicit", () => {
  const initial = createManagerConversation();
  const sid = initial.conversation.id;
  const old = history(sid, "openai", "gpt-4o-mini");
  const newer = history(sid, "opencode-console", "deepseek-v4.1-flash").map(
    (e, i) => ({
      ...e,
      id: `new-${i}`,
      sequence: i + 2,
      payload: { ...e.payload, id: "new-request" },
    }),
  ) as HistoryEvent[];
  const restored = restoreHistory(initial, [
    old[0],
    ...newer,
    { ...old[1], sequence: 4 },
  ]);
  expect(
    restoreSessionModelPair(restored, registry(), "gpt-4o-mini").provider,
  ).toBe("opencode-console");
  expect(restoreSessionModelPair(initial, registry(), "gpt-4o-mini")).toEqual({
    provider: "openai",
    model: "gpt-4o-mini",
  });
  const unavailable = restoreHistory(
    initial,
    history(sid, "opencode-go", "removed-model"),
  );
  expect(
    restoreSessionModelPair(unavailable, registry(), "gpt-4o-mini"),
  ).toMatchObject({
    provider: "openai",
    model: "gpt-4o-mini",
    notice: expect.stringContaining("unavailable"),
  });
});

it("keeps matching estimates during updates and rejects late results from earlier models, sessions, and drafts", () => {
  const cache = new SessionContextCache();
  const a = "session-a/openai/model",
    b = "session-b/console/deepseek";
  const first = {
    estimatedInputTokens: 299,
    inputBudget: 8000,
    replyTokens: 1024,
    uncertaintyTokens: 1024,
  };
  expect(cache.complete(cache.begin(a), a, first)).toBe(true);
  const pending = cache.begin(a);
  expect(cache.get(a)).toEqual(first);
  const html = renderToStaticMarkup(
    <SessionStatsContent context={cache.get(a)} contextPending />,
  );
  expect(html).toContain("Last request");
  expect(html).not.toContain("Reduction");
  expect(html).toContain("Updating…");
  expect(html).not.toContain(">Unavailable</div>");
  const switched = cache.begin(b);
  expect(cache.get(b)).toBeUndefined();
  expect(
    cache.complete(pending, a, { ...first, estimatedInputTokens: 999 }),
  ).toBe(false);
  const newDraft = cache.begin(b);
  expect(cache.complete(switched, b, first)).toBe(false);
  expect(
    cache.complete(newDraft, b, { ...first, estimatedInputTokens: 400 }),
  ).toBe(true);
  expect(cache.get(a)).toEqual(first);
  cache.cancel(newDraft);
  expect(cache.complete(newDraft, b, first)).toBe(false);
  const noPrevious = renderToStaticMarkup(
    <SessionStatsContent contextPending />,
  );
  expect(noPrevious).toContain("Updating…");
  // Current context is the last row; unrelated cost remains unavailable.
  expect(noPrevious).toMatch(/Last request<\/dt><dd[^>]*>—/);
});
