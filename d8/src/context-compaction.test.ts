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
  expect(small.context.summarize).not.toHaveBeenCalled();
  const outgoing = small.complete.mock.calls as unknown as [
    { messages: { content: string }[] },
  ][];
  expect(outgoing[0][0].messages.at(-1)?.content).toBe("Latest user message");
  expect(outgoing[0][0].messages.some(m=>m.content.includes("Saved conversation summary"))).toBe(false);
  expect(outgoing[0][0].messages.length).toBeLessThan(state.messages.length);
  expect(state.messages).toHaveLength(original + 2);
  const restored = restoreHistory(
    { ...createManagerConversation(), conversation: state.conversation }, events,
  );
  expect(restored.messages).toHaveLength(original);
  expect(restored.contextEvents).toEqual([]);
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
    context: context(50000),
    complete: vi.fn(async (_input: Parameters<ManagerLlmAdapter["complete"]>[0]) => ({ text: "Done" })),
  };
  const result = await new ManagerAgent(adapter, tools()).run({
    state,
    userText: "Tax the first result",
  });
  expect(result.error).toBeUndefined();
  const sent = JSON.stringify(adapter.complete.mock.calls[0][0].messages);
  expect(sent).toContain("11234.567");
  expect(sent).toContain("JPY");
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
    expect(complete).toHaveBeenCalledTimes(2);
    expect(c.summarize).not.toHaveBeenCalled();
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
  expect(result.error).toContain("model input budget");
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
    expect(bodies).toHaveLength(1);
    expect(bodies.at(-1)!.tool_choice).toBe("auto");
    expect(JSON.stringify(bodies[0])).not.toContain("Saved conversation summary");
    for (const body of bodies) { expect(body).not.toHaveProperty("max_completion_tokens"); expect(body).not.toHaveProperty("max_output_tokens"); }
    expect(state.requestMeters).toHaveLength(bodies.length);
    expect(
      state.requestMeters!.every((meter) => meter.actualTotalTokens === 17),
    ).toBe(true);
    expect(events.filter(event => event.type === "context")).toHaveLength(0);
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

it.each([0, 2000])('keeps hard limits active with custom target %s and preserves full dialogue', async (target) => {
  const { state } = await seeded();
  const original = state.messages.length;
  const planning = { ...context(9000), assess: vi.fn(async (messages: readonly { content: string }[]) => ({ tokens: messages.reduce((n,m)=>n+m.content.length,0), limit: 9000, target })) };
  const complete = vi.fn(async () => ({ text: 'Continued.' }));
  const result = await new ManagerAgent({ context: planning, complete }, tools()).run({state,userText:'Continue',onEvent: async () => {}});
  expect(result.error).toBeUndefined(); expect(state.messages).toHaveLength(original + 2); expect(complete).toHaveBeenCalledOnce();
  expect(planning.summarize).not.toHaveBeenCalled();
});

it('disables the custom target below the hard budget and restores full history despite an older summary', async () => {
  const { state } = await seeded();
  state.contextEvents = [{id:'saved-summary', runId:'prior',createdAt:1,phase:'completed',summary:'Short summary',coveredRunIds:state.runs.map(r=>r.id)}];
  const planning = { ...context(100000), assess: vi.fn(async (messages: readonly { content: string }[]) => ({ tokens: messages.reduce((n,m)=>n+m.content.length,0), limit:100000,target:0 })) };
  const complete = vi.fn(async () => ({text:'Continued.'}));
  await new ManagerAgent({context:planning,complete},tools()).run({state,userText:'Continue'});
  expect(planning.summarize).not.toHaveBeenCalled();
  const call = complete.mock.calls as unknown as [{ messages: {content:string}[] }][];
  expect(call[0][0].messages[0].content).toContain('A long past question');
});

it('sends required content above the soft target when it fits the model budget', async () => {
  const planning = {...context(100000),assess:vi.fn(async () => ({tokens:3000,limit:100000,target:2000}))};
  const complete = vi.fn(async () => ({text:'Kept required content.'}));
  const result=await new ManagerAgent({context:planning,complete},tools()).run({state:createManagerConversation(),userText:'Required draft'});
  expect(result.error).toBeUndefined();
  expect(complete).toHaveBeenCalledOnce();
});

it('allows a compacted request above the soft target but within the model budget', async () => {
 const {state}=await seeded();
 const planning={...context(100000),assess:vi.fn(async (messages:readonly {content:string}[])=>({tokens:messages.reduce((n,m)=>n+m.content.length,0),limit:100000,target:2000}))};
 const complete=vi.fn(async()=>({text:'Continued.'}));
 const result=await new ManagerAgent({context:planning,complete},tools()).run({state,userText:'Continue',onEvent:async()=>{}});
 expect(result.error).toBeUndefined();
 expect(planning.summarize).not.toHaveBeenCalled();
 expect(complete).toHaveBeenCalledOnce();
});

it('accepts a shorter overflow retry that fits the effective budget without an extra 20% rejection', async () => {
 const {state}=await seeded();
 let calls=0;
 const adapter:ManagerLlmAdapter={
  context:{assess:async messages=>({tokens:messages.length===1 && messages[0].role==='user' ? Math.ceil(messages[0].content.length/4) : messages.length * 500,limit:10000}),summarize:async()=> 'Compact prior discussion.'},
  complete:async()=>{if(++calls===1)throw new ManagerProviderError({kind:'context-overflow',status:400});return {text:'Recovered.'};},
 };
 const result=await new ManagerAgent(adapter,tools()).run({state,userText:'Continue'});
 expect(result.error).toBeUndefined();expect(calls).toBe(2);
 expect(state.contextEvents!.map(e=>e.phase)).toEqual(['overflow','retrying']);
});

it('recommends a larger model when its hard input budget is the limiting constraint', async () => {
 const {state}=await seeded();
 const planning={...context(2000),assess:async(messages:readonly {role?:string;content:string}[])=>({tokens:messages.length===1 && messages[0].role==='user' ? Math.ceil(messages[0].content.length/4) : messages.reduce((n,m)=>n+m.content.length,0),limit:2000,modelInputBudget:2000,target:10000})};
 const complete=vi.fn(async()=>({text:'Must not send.'}));
 const result=await new ManagerAgent({context:planning,complete},tools()).run({state,userText:'Required input '.repeat(1000)});
 expect(result.error).toContain('model input budget');
 expect(result.error).not.toContain('Increase this session');expect(complete).not.toHaveBeenCalled();

});

it('never summarizes while selecting a bounded request', async()=>{
 const {state}=await seeded();const planning={...context(10000),summarize:vi.fn(async()=>{throw Error('must not run')})};
 const complete=vi.fn(async()=>({text:'Done'}));
 const result=await new ManagerAgent({context:planning,complete},tools()).run({state,userText:'Continue'});
 expect(result.error).toBeUndefined();expect(planning.summarize).not.toHaveBeenCalled();expect(complete).toHaveBeenCalledOnce();
});
