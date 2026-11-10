import { describe, expect, it } from "vitest";
import { createBuiltInToolRegistry, MockExchangeRateSource } from "./tool-runtime";
import {
  ManagerAgent,
  createManagerConversation,
  type ManagerLlmAdapter,
  type ManagerLlmMessage,
} from "./manager-agent";

function scriptedProvider(
  script: Array<(messages: readonly ManagerLlmMessage[]) => { text?: string; toolCalls?: Array<{ id: string; toolId: string; arguments: unknown }> }>,
) {
  const calls: Array<{ messages: readonly ManagerLlmMessage[] }> = [];
  let index = 0;
  const provider: ManagerLlmAdapter = {
    async complete(input) {
      calls.push({ messages: input.messages });
      const step = script[index++] ?? script.at(-1);
      if (!step) return { text: "" };
      return step(input.messages);
    },
  };
  return { provider, calls };
}

describe("manager agent execution loop", () => {
  it("scenario A: returns direct answer when no tools are requested", async () => {
    const { provider } = scriptedProvider([() => ({ text: "Hello from model." })]);
    const agent = new ManagerAgent(provider, createBuiltInToolRegistry(new MockExchangeRateSource()));
    const result = await agent.run({
      state: createManagerConversation(),
      userText: "Hi",
    });

    expect(result.error).toBeUndefined();
    expect(result.finalResponse).toBe("Hello from model.");
    expect(result.run.toolExecutionIds).toHaveLength(0);
  });

  it("scenario B: executes one tool then returns final response", async () => {
    const { provider, calls } = scriptedProvider([
      () => ({
        toolCalls: [
          {
            id: "tc-1",
            toolId: "builtin.tax_calculator",
            arguments: { amount: 100, taxRate: 15 },
          },
        ],
      }),
      (messages) => {
        expect(messages.some((m) => m.role === "tool" && m.toolCallId === "tc-1")).toBe(true);
        return { text: "Tax is 15, total is 115." };
      },
    ]);

    const agent = new ManagerAgent(provider, createBuiltInToolRegistry(new MockExchangeRateSource()));
    const result = await agent.run({
      state: createManagerConversation(),
      userText: "Calculate 15% tax on 100",
    });

    expect(calls).toHaveLength(2);
    expect(result.finalResponse).toContain("115");
    expect(result.state.toolExecutions).toHaveLength(1);
    expect(result.state.toolExecutions[0].toolId).toBe("builtin.tax_calculator");
    expect(result.state.toolExecutions[0].status).toBe("completed");
  });

  it("scenario C: runs three sequential tool calls driven by model responses", async () => {
    const { provider } = scriptedProvider([
      () => ({
        toolCalls: [
          {
            id: "rate-1",
            toolId: "builtin.exchange_rate",
            arguments: { fromCurrency: "USD", toCurrency: "CAD" },
          },
        ],
      }),
      (messages) => {
        expect(messages.some((m) => m.role === "tool" && m.toolCallId === "rate-1")).toBe(true);
        return {
          toolCalls: [
            {
              id: "conv-1",
              toolId: "builtin.currency_converter",
              arguments: {
                amount: 100,
                fromCurrency: "USD",
                toCurrency: "CAD",
                exchangeRate: 1.36,
              },
            },
          ],
        };
      },
      (messages) => {
        expect(messages.some((m) => m.role === "tool" && m.toolCallId === "conv-1")).toBe(true);
        return {
          toolCalls: [
            {
              id: "tax-1",
              toolId: "builtin.tax_calculator",
              arguments: { amount: 136, taxRate: 15 },
            },
          ],
        };
      },
      (messages) => {
        expect(messages.some((m) => m.role === "tool" && m.toolCallId === "tax-1")).toBe(true);
        return { text: "Converted and taxed total is 156.4 CAD." };
      },
    ]);

    const agent = new ManagerAgent(provider, createBuiltInToolRegistry(new MockExchangeRateSource()));
    const result = await agent.run({
      state: createManagerConversation(),
      userText: "Convert 100 USD to CAD and add 15% tax",
    });

    expect(result.error).toBeUndefined();
    expect(result.state.toolExecutions.map((entry) => entry.toolId)).toEqual([
      "builtin.exchange_rate",
      "builtin.currency_converter",
      "builtin.tax_calculator",
    ]);
    expect(result.finalResponse).toContain("156.4");
  });

  it("handles invalid args, unknown tools and execution failures without crashing", async () => {
    const { provider } = scriptedProvider([
      () => ({
        toolCalls: [
          {
            id: "bad-args",
            toolId: "builtin.tax_calculator",
            arguments: { amount: "100", taxRate: 10 },
          },
          {
            id: "unknown",
            toolId: "builtin.unknown",
            arguments: {},
          },
          {
            id: "unsupported-pair",
            toolId: "builtin.exchange_rate",
            arguments: { fromCurrency: "CAD", toCurrency: "CHF" },
          },
        ],
      }),
      (messages) => {
        const toolReplies = messages.filter((message) => message.role === "tool");
        expect(toolReplies).toHaveLength(3);
        return { text: "Handled tool errors." };
      },
    ]);

    const agent = new ManagerAgent(provider, createBuiltInToolRegistry(new MockExchangeRateSource()));
    const result = await agent.run({
      state: createManagerConversation(),
      userText: "Run bad calls",
    });

    expect(result.finalResponse).toBe("Handled tool errors.");
    expect(result.state.toolExecutions.map((item) => item.status)).toEqual([
      "failed",
      "failed",
      "failed",
    ]);
  });

  it("supports multiple tool calls within one LLM response preserving call order", async () => {
    const { provider } = scriptedProvider([
      () => ({
        toolCalls: [
          {
            id: "tax-a",
            toolId: "builtin.tax_calculator",
            arguments: { amount: 100, taxRate: 10 },
          },
          {
            id: "tax-b",
            toolId: "builtin.tax_calculator",
            arguments: { amount: 200, taxRate: 5 },
          },
        ],
      }),
      () => ({ text: "Completed two tax operations." }),
    ]);

    const agent = new ManagerAgent(provider, createBuiltInToolRegistry(new MockExchangeRateSource()));
    const result = await agent.run({
      state: createManagerConversation(),
      userText: "Run two tax calculations",
    });

    expect(result.state.toolExecutions.map((item) => item.toolCallId)).toEqual([
      "tax-a",
      "tax-b",
    ]);
  });

  it("fails with explicit error when max iterations is reached", async () => {
    const { provider } = scriptedProvider([
      () => ({
        toolCalls: [
          {
            id: "loop-1",
            toolId: "builtin.tax_calculator",
            arguments: { amount: 1, taxRate: 1 },
          },
        ],
      }),
      () => ({
        toolCalls: [
          {
            id: "loop-2",
            toolId: "builtin.tax_calculator",
            arguments: { amount: 1, taxRate: 1 },
          },
        ],
      }),
    ]);

    const agent = new ManagerAgent(provider, createBuiltInToolRegistry(new MockExchangeRateSource()), {
      maxIterations: 1,
    });
    const result = await agent.run({
      state: createManagerConversation(),
      userText: "loop forever",
    });

    expect(result.finalResponse).toBeUndefined();
    expect(result.error).toContain("Maximum iterations reached");
    expect(result.run.status).toBe("failed");
  });

  it("records the user message and run before the provider promise resolves", async () => {
    let resolveProvider!: (response: { text: string }) => void;
    const provider: ManagerLlmAdapter = {
      complete: () => new Promise((resolve) => {
        resolveProvider = resolve;
      }),
    };
    const state = createManagerConversation();
    const agent = new ManagerAgent(provider, createBuiltInToolRegistry(new MockExchangeRateSource()));

    const pending = agent.run({ state, userText: "Visible immediately" });

    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({ role: "user", text: "Visible immediately" });
    expect(state.runs).toHaveLength(1);
    expect(state.runs[0].status).toBe("running");
    expect(state.messages[0].createdAt).toBeLessThanOrEqual(state.runs[0].startedAt);

    resolveProvider({ text: "Finished" });
    const result = await pending;
    expect(result.finalResponse).toBe("Finished");
    expect(state.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
  });

  it("retains the user message and records a failed run when the provider rejects", async () => {
    const provider: ManagerLlmAdapter = {
      complete: async () => {
        throw new Error("Provider unavailable");
      },
    };
    const state = createManagerConversation();
    const agent = new ManagerAgent(provider, createBuiltInToolRegistry(new MockExchangeRateSource()));

    const result = await agent.run({ state, userText: "Keep this message" });

    expect(result.error).toBe("Provider unavailable");
    expect(result.run.status).toBe("failed");
    expect(result.run.endedAt).toBeDefined();
    expect(result.state.messages).toHaveLength(1);
    expect(result.state.messages[0]).toMatchObject({ role: "user", text: "Keep this message" });
  });

  it("preserves conversation context and records structured run history", async () => {
    const { provider } = scriptedProvider([
      () => ({ text: "First answer." }),
      (messages) => {
        expect(messages.some((message) => message.content.includes("First answer."))).toBe(true);
        return { text: "Second answer with context." };
      },
    ]);

    const state = createManagerConversation();
    const agent = new ManagerAgent(provider, createBuiltInToolRegistry(new MockExchangeRateSource()));

    const first = await agent.run({ state, userText: "First request" });
    const second = await agent.run({ state, userText: "Second request" });

    expect(first.run.id).not.toBe(second.run.id);
    expect(state.runs).toHaveLength(2);
    expect(state.conversation.runIds).toHaveLength(2);
    expect(state.messages.length).toBeGreaterThanOrEqual(4);
  });
});
