import { expect, it, vi } from "vitest";
import {
  ManagerAgent,
  createManagerConversation,
  type ManagerLlmAdapter,
} from "./manager-agent";
import {
  ManagerProviderError,
  createManagerLlmAdapter,
} from "./manager-llm-adapter";
import { createBuiltInToolRegistry } from "./tool-runtime";
import { historicalContext, summarizeBounded } from "./context-compaction";
import { restoreHistory, type HistoryEvent } from "./conversation-history";
import { parseModels } from "./opencode-catalog";
import { ProviderRegistry } from "./provider-registry";
import { openAIContextLimits } from "./openai-model-catalog";
import { providerError } from "../server/provider-error.mjs";

const tools = () => createBuiltInToolRegistry();
async function seeded() {
  const state = createManagerConversation();
  const events: HistoryEvent[] = [];
  const agent = new ManagerAgent(
    {
      complete: async () => ({
        text: "Older completed explanation. ".repeat(90),
      }),
    },
    tools(),
  );
  for (let i = 0; i < 5; i++)
    await agent.run({
      state,
      userText: "A long past question. ".repeat(40),
      onEvent: async (event) => {
        events.push({ ...event, sequence: events.length + 1 });
      },
    });
  return { state, events };
}
const context = (limit: number) => ({
  assess: vi.fn(async (messages: readonly { content: string }[]) => ({
    tokens: messages.reduce((n, m) => n + m.content.length, 0),
    limit,
  })),
  summarize: vi.fn(async () => "Prior goals and decisions."),
});

it("compacts proactively after a switch to a smaller model, preserves recent turns and restores the summary", async () => {
  const { state, events } = await seeded();
  const large = {
    complete: vi.fn(async () => ({ text: "Large model answer." })),
    context: context(50000),
  };
  await new ManagerAgent(large, tools()).run({ state, userText: "Continue" });
  expect(large.context.summarize).not.toHaveBeenCalled();
  const small = {
    complete: vi.fn(async () => ({ text: "Small model answer." })),
    context: context(9000),
  };
  const original = state.messages.length;
  const result = await new ManagerAgent(small, tools()).run({
    state,
    userText: "Latest user message",
    onEvent: async (event) => {
      events.push({ ...event, sequence: events.length + 1 });
    },
  });
  expect(result.error).toBeUndefined();
  expect(small.context.summarize).toHaveBeenCalled();
  const outgoing = small.complete.mock.calls as unknown as [
    { messages: { content: string }[] },
  ][];
  expect(outgoing[0][0].messages.at(-1)?.content).toBe("Latest user message");
  expect(outgoing[0][0].messages[0].content).toContain(
    "Saved conversation summary",
  );
  expect(state.messages).toHaveLength(original + 2);
  const summary = state.contextEvents!.find((e) => e.phase === "completed")!;
  expect(summary.coveredEventId).toBeTruthy();
  expect(summary.afterTokens).toBeLessThan(summary.beforeTokens!);
  const restored = restoreHistory(
    { ...createManagerConversation(), conversation: state.conversation },
    events,
  );
  expect(restored.contextEvents).toEqual(state.contextEvents);
  expect(historicalContext(restored, "next")[0].content).toContain(
    summary.summary,
  );
});

it("retries only the rejected request once, without repeating tools or duplicating the user message", async () => {
  const { state } = await seeded();
  const registry = tools();
  const execute = vi.spyOn(registry, "executeById");
  let calls = 0;
  const adapter: ManagerLlmAdapter = {
    context: context(50000),
    complete: vi.fn(
      async ({ messages }: Parameters<ManagerLlmAdapter["complete"]>[0]) => {
        calls++;
        if (calls === 1)
          return {
            toolCalls: [
              {
                id: "tax-call",
                toolId: "builtin.tax_calculator",
                arguments: { amount: 25000, taxRate: 10 },
              },
            ],
          };
        expect(messages.at(-1)).toMatchObject({
          role: "tool",
          toolCallId: "tax-call",
        });
        if (calls === 2)
          throw new ManagerProviderError({
            kind: "context-overflow",
            status: 400,
          });
        expect(JSON.stringify(messages)).toContain("27500");
        expect(messages.some((m) => m.toolCalls?.[0]?.id === "tax-call")).toBe(
          true,
        );
        return { text: "The total is 27500 JPY." };
      },
    ),
  };
  const result = await new ManagerAgent(adapter, registry).run({
    state,
    userText: "Add 10% tax in JPY.",
  });
  expect(result.error).toBeUndefined();
  expect(calls).toBe(3);
  expect(execute).toHaveBeenCalledTimes(1);
  expect(
    state.messages.filter((m) => m.text === "Add 10% tax in JPY."),
  ).toHaveLength(1);
  expect(state.contextEvents!.map((e) => e.phase)).toEqual([
    "overflow",
    "compacting",
    "completed",
    "retrying",
  ]);
  expect(result.run.status).toBe("completed");
});

it("preserves historical tool values and units losslessly", async () => {
  const { state } = await seeded();
  const oldRun = state.runs[0];
  state.toolExecutions.push({
    id: "old-tool",
    runId: oldRun.id,
    toolId: "builtin.currency_converter",
    toolCallId: "old-call",
    arguments: {
      amount: 100,
      fromCurrency: "CAD",
      toCurrency: "JPY",
      exchangeRate: 112.34567,
    },
    output: { amount: 11234.567, currency: "JPY" },
    status: "completed",
    startedAt: 1,
    endedAt: 2,
  });
  const adapter = {
    context: context(9000),
    complete: vi.fn(async () => ({ text: "Done" })),
  };
  const result = await new ManagerAgent(adapter, tools()).run({
    state,
    userText: "Tax the first result",
  });
  expect(result.error).toBeUndefined();
  expect(state.contextEvents!.find((e) => e.summary)?.summary).toContain(
    "11234.567",
  );
  expect(state.contextEvents!.find((e) => e.summary)?.summary).toContain("JPY");
});

it.each([400, 401, 403, 429, 502])(
  "does not compact unrelated status %s",
  async (status) => {
    const { state } = await seeded();
    const c = context(50000);
    const complete = vi.fn(async () => {
      throw new ManagerProviderError(
        providerError(status, {
          error: {
            message:
              status === 400
                ? "Invalid tool schema"
                : "context_length_exceeded",
          },
        }),
      );
    });
    const result = await new ManagerAgent(
      { context: c, complete },
      tools(),
    ).run({ state, userText: "Continue" });
    expect(result.run.status).toBe("failed");
    expect(complete).toHaveBeenCalledTimes(1);
    expect(c.summarize).not.toHaveBeenCalled();
  },
);

it("ends after the one retry fails and summary failures never start recovery", async () => {
  for (const summaryFailure of [false, true]) {
    const { state } = await seeded();
    const c = context(50000);
    if (summaryFailure)
      c.summarize.mockRejectedValue(
        new ManagerProviderError({ kind: "context-overflow", status: 400 }),
      );
    const complete = vi.fn(async () => {
      throw new ManagerProviderError({ kind: "context-overflow", status: 400 });
    });
    const result = await new ManagerAgent(
      { context: c, complete },
      tools(),
    ).run({ state, userText: "Continue" });
    expect(result.run.status).toBe("failed");
    expect(complete).toHaveBeenCalledTimes(summaryFailure ? 1 : 2);
    expect(
      state.contextEvents!.filter((e) => e.phase === "overflow"),
    ).toHaveLength(1);
  }
});

it("fails clearly when protected content cannot fit, and treats unknown metadata as unknown", async () => {
  const { state } = await seeded();
  const complete = vi.fn(async () => ({ text: "Should not send" }));
  const result = await new ManagerAgent(
    { context: context(9000), complete },
    tools(),
  ).run({ state, userText: "Protected current message ".repeat(1000) });
  expect(result.error).toContain("fitting");
  expect(complete).not.toHaveBeenCalled();
  const unknown: ManagerLlmAdapter = {
    context: { assess: async () => ({}), summarize: vi.fn() },
    complete,
  };
  await new ManagerAgent(unknown, tools()).run({
    state: createManagerConversation(),
    userText: "Hello",
  });
  expect(complete).toHaveBeenCalledTimes(1);
  expect(unknown.context!.summarize).not.toHaveBeenCalled();
});

it("bounds summary chunk sizes and refuses non-reducing summaries", async () => {
  const c = context(10000);
  await summarizeBounded(c, "History. ".repeat(5000), async () => {});
  expect(c.summarize.mock.calls.length).toBeGreaterThan(1);
  for (const [text] of c.summarize.mock.calls as unknown as [string][])
    expect(text.length).toBeLessThanOrEqual(6000);
});

it("retains Console limits independently of structured-output capabilities and uses exact verified OpenAI limits", () => {
  expect(
    parseModels({
      data: [{ id: "tiny", limit: { context: 8192, output: 2048 } }],
    })[0],
  ).toMatchObject({ contextWindow: 8192, maxOutputTokens: 2048 });
  expect(
    parseModels({
      data: [{ id: "unknown", limit: { context: -1, output: 0 } }],
    })[0].contextWindow,
  ).toBeUndefined();
  expect(openAIContextLimits("gpt-5.6-terra")).toEqual({
    contextWindow: 1050000,
    maxOutputTokens: 128000,
    maxInputTokens: 922000,
  });
  expect(openAIContextLimits("gpt-4o-mini")?.contextWindow).toBe(128000);
  expect(openAIContextLimits("gpt-future")).toBeUndefined();
});

it("estimates complete outgoing payloads with tools and reserves configured output plus uncertainty", async () => {
  const registry = new ProviderRegistry();
  registry.register({
    id: "opencode-console",
    catalog: () => ["gpt-4o-mini"],
    capabilities: () => undefined,
    limits: () => ({ contextWindow: 10000, maxOutputTokens: 2000 }),
    validate: () => undefined,
    execute: vi.fn(),
  });
  const adapter = createManagerLlmAdapter({
    providerId: "opencode-console",
    model: "gpt-4o-mini",
    apiKey: "placeholder",
    registry,
    maxOutputTokens: 1500,
    fetcher: vi.fn(),
  });
  const withTools = await adapter.context!.assess(
    [{ role: "user", content: "Hello" }],
    tools().listBuiltIn(),
  );
  const withoutTools = await adapter.context!.assess(
    [{ role: "user", content: "Hello" }],
    [],
  );
  expect(withTools.limit).toBe(7476);
  expect(withTools.tokens).toBeGreaterThan(withoutTools.tokens!);
});

it.each([false, true])(
  "proactively compacts through the real Console adapter and meters summary requests (saved key: %s)",
  async (useSavedKey) => {
    const { state } = await seeded();
    let contextWindow = 50000;
    const registry = new ProviderRegistry();
    registry.register({
      id: "opencode-console",
      catalog: () => ["gpt-4o-mini"],
      capabilities: () => undefined,
      limits: () => ({ contextWindow, maxOutputTokens: 2048 }),
      validate: () => undefined,
      execute: vi.fn(),
    });
    const bodies: Record<string, any>[] = [];
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(init!.body as string);
      bodies.push(body);
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content:
                  body.tool_choice === "none"
                    ? "Prior goals and decisions."
                    : "Continued successfully.",
              },
            },
          ],
          usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
        }),
      );
    });
    const make = () =>
      createManagerLlmAdapter({
        providerId: "opencode-console",
        model: "gpt-4o-mini",
        apiKey: useSavedKey ? "" : "placeholder",
        useSavedKey,
        registry,
        maxOutputTokens: 512,
        fetcher,
      });
    const estimate = await make().context!.assess(
      [
        ...historicalContext(state, "next"),
        { role: "user", content: "Continue" },
      ],
      tools()
        .listBuiltIn()
        .filter((t) => t.executable),
    );
    contextWindow = estimate.tokens! + 512 + 1024 - 10;
    const events: HistoryEvent[] = [];
    const result = await new ManagerAgent(make(), tools()).run({
      state,
      userText: "Continue",
      onEvent: async (event) => {
        events.push(event);
      },
    });
    expect(result.error).toBeUndefined();
    expect(bodies.length).toBeGreaterThan(1);
    expect(bodies[0].tool_choice).toBe("none");
    expect(bodies[0].tools).toEqual([]);
    expect(bodies.at(-1)!.tool_choice).toBe("auto");
    expect(bodies.at(-1)!.messages[0].content).toContain(
      "Saved conversation summary",
    );
    expect(bodies.at(-1)!.max_completion_tokens).toBe(512);
    expect(state.requestMeters).toHaveLength(bodies.length);
    expect(
      state.requestMeters!.every((meter) => meter.actualTotalTokens === 17),
    ).toBe(true);
    expect(
      events.filter(
        (event) =>
          event.type === "context" && event.payload.phase === "completed",
      ),
    ).toHaveLength(1);
    expect(
      fetcher.mock.calls.every(([url]) =>
        useSavedKey
          ? url === "/api/credentials/opencode-console/request"
          : String(url).startsWith("https://"),
      ),
    ).toBe(true);
  },
);

it("classifies explicit overflow only and never trusts a direct provider status override", () => {
  expect(
    providerError(400, {
      error: {
        message:
          "This model has a maximum context length of 8192 tokens, which was exceeded.",
      },
    }).kind,
  ).toBe("context-overflow");
  expect(
    providerError(413, { error: { message: "Body too large" } }).kind,
  ).toBe("request");
  expect(
    providerError(401, {
      error: { status: 400, code: "context_length_exceeded" },
    }).kind,
  ).toBe("authentication");
  expect(
    providerError(429, { error: { code: "context_length_exceeded" } }).kind,
  ).toBe("rate-limit");
});

it("sanitizes transport failures and never treats them as overflow", async () => {
  const adapter = createManagerLlmAdapter({
    providerId: "openai",
    model: "gpt-4o-mini",
    apiKey: "placeholder-private",
    registry: new ProviderRegistry(),
    fetcher: async () => {
      throw new Error(
        "Network failure Authorization: Bearer placeholder-private",
      );
    },
  });
  await expect(adapter.complete({ messages: [], tools: [] })).rejects.toThrow(
    "Please retry",
  );
  await expect(
    adapter.complete({ messages: [], tools: [] }),
  ).rejects.not.toBeInstanceOf(ManagerProviderError);
});
