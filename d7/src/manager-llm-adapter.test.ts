import { describe, expect, it, vi } from "vitest";
import { ProviderRegistry } from "./provider-registry";
import {
  buildProviderToolNameMap,
  createManagerLlmAdapter,
  parseOpenAIChatCompletions,
  parseOpenAIResponses,
  toOpenAIChatMessages,
  toOpenAIResponsesInput,
} from "./manager-llm-adapter";
import type { ManagerLlmMessage } from "./manager-agent";
import type { ToolCatalogItem } from "./tool-runtime";

const messages: ManagerLlmMessage[] = [
  { role: "user", content: "compute tax" },
  {
    role: "assistant",
    content: "",
    toolCalls: [
      { id: "tc-1", toolId: "builtin.tax_calculator", arguments: { amount: 100, taxRate: 15 } },
    ],
  },
  {
    role: "tool",
    toolCallId: "tc-1",
    toolName: "builtin.tax_calculator",
    content: JSON.stringify({ ok: true, output: { total: 115 } }),
  },
];

describe("manager llm provider mapping", () => {
  it("builds valid provider function names for invalid tool ids", () => {
    const tools: ToolCatalogItem[] = [
      {
        id: "builtin.tax_calculator",
        name: "Tax Calculator",
        description: "Calculates tax.",
        executable: true,
        kind: "built-in",
        inputSchema: { type: "object", properties: {}, required: [] },
      },
    ];
    const map = buildProviderToolNameMap(tools);
    expect(map.idToName.get("builtin.tax_calculator")).toBe("builtin_tax_calculator");
    expect(map.nameToId.get("builtin_tax_calculator")).toBe("builtin.tax_calculator");
  });

  it("maps manager messages to OpenAI Responses input", () => {
    const map = buildProviderToolNameMap([
      {
        id: "builtin.tax_calculator",
        name: "Tax Calculator",
        description: "Calculates tax.",
        executable: true,
        kind: "built-in",
        inputSchema: { type: "object", properties: {}, required: [] },
      },
    ]);
    const input = toOpenAIResponsesInput(messages, map);
    expect(input).toEqual([
      { role: "user", content: "compute tax" },
      {
        type: "function_call",
        call_id: "tc-1",
        name: "builtin_tax_calculator",
        arguments: '{"amount":100,"taxRate":15}',
      },
      {
        type: "function_call_output",
        call_id: "tc-1",
        output: '{"ok":true,"output":{"total":115}}',
      },
    ]);
  });

  it("maps manager messages to OpenAI-compatible chat messages", () => {
    const map = buildProviderToolNameMap([
      {
        id: "builtin.tax_calculator",
        name: "Tax Calculator",
        description: "Calculates tax.",
        executable: true,
        kind: "built-in",
        inputSchema: { type: "object", properties: {}, required: [] },
      },
    ]);
    const input = toOpenAIChatMessages(messages, map);
    expect(input).toEqual([
      { role: "user", content: "compute tax" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "tc-1",
            type: "function",
            function: {
              name: "builtin_tax_calculator",
              arguments: '{"amount":100,"taxRate":15}',
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "tc-1",
        name: "builtin_tax_calculator",
        content: '{"ok":true,"output":{"total":115}}',
      },
    ]);
  });

  it("parses tool calls from OpenAI Responses payload", () => {
    const map = buildProviderToolNameMap([
      {
        id: "builtin.tax_calculator",
        name: "Tax Calculator",
        description: "Calculates tax.",
        executable: true,
        kind: "built-in",
        inputSchema: { type: "object", properties: {}, required: [] },
      },
    ]);
    const parsed = parseOpenAIResponses({
      output: [
        {
          type: "function_call",
          call_id: "tc-1",
          name: "builtin_tax_calculator",
          arguments: '{"amount":100,"taxRate":15}',
        },
      ],
    }, map);
    expect(parsed.toolCalls).toEqual([
      {
        id: "tc-1",
        toolId: "builtin.tax_calculator",
        arguments: { amount: 100, taxRate: 15 },
      },
    ]);
  });

  it("parses tool calls from chat completions payload", () => {
    const map = buildProviderToolNameMap([
      {
        id: "builtin.exchange_rate",
        name: "Exchange Rate",
        description: "Gets exchange rate.",
        executable: true,
        kind: "built-in",
        inputSchema: { type: "object", properties: {}, required: [] },
      },
    ]);
    const parsed = parseOpenAIChatCompletions({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: "tc-2",
                function: {
                  name: "builtin_exchange_rate",
                  arguments: '{"fromCurrency":"USD","toCurrency":"CAD"}',
                },
              },
            ],
          },
        },
      ],
    }, map);
    expect(parsed.toolCalls).toEqual([
      {
        id: "tc-2",
        toolId: "builtin.exchange_rate",
        arguments: { fromCurrency: "USD", toCurrency: "CAD" },
      },
    ]);
  });

  it("sends provider-specific request payloads for OpenAI and OpenCode", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ choices: [{ message: { content: "ok" } }] }),
      });

    const registry = new ProviderRegistry();
    registry.setEndpoint("openai", "https://api.openai.com/v1/responses", true);
    registry.setEndpoint(
      "opencode-console",
      "https://opencode.ai/inference/openai/v1/chat/completions",
      true,
    );

    const openai = createManagerLlmAdapter({
      providerId: "openai",
      model: "gpt-5.6-terra",
      apiKey: "dummy-openai",
      registry,
      fetcher: fetcher as unknown as typeof fetch,
    });

    await openai.complete({
      messages: [{ role: "user", content: "hello" }],
      tools: [
        {
          id: "builtin.tax_calculator",
          name: "Tax Calculator",
          description: "Calculates tax.",
          executable: true,
          kind: "built-in",
          inputSchema: { type: "object", properties: {}, required: [] },
        },
      ],
    });

    const opencode = createManagerLlmAdapter({
      providerId: "opencode-console",
      model: "kimi-k3",
      apiKey: "dummy-opencode",
      registry,
      fetcher: fetcher as unknown as typeof fetch,
    });

    await opencode.complete({
      messages: [{ role: "user", content: "hello" }],
      tools: [
        {
          id: "builtin.tax_calculator",
          name: "Tax Calculator",
          description: "Calculates tax.",
          executable: true,
          kind: "built-in",
          inputSchema: { type: "object", properties: {}, required: [] },
        },
      ],
    });

    const openaiRequest = fetcher.mock.calls[0];
    expect(openaiRequest[0]).toBe("https://api.openai.com/v1/responses");
    expect(JSON.parse((openaiRequest[1] as RequestInit).body as string)).toMatchObject({
      model: "gpt-5.6-terra",
      input: [{ role: "user", content: "hello" }],
    });
    expect(
      JSON.parse((openaiRequest[1] as RequestInit).body as string).tools[0].name,
    ).toBe("builtin_tax_calculator");
    expect(JSON.parse((openaiRequest[1] as RequestInit).body as string).tools).toEqual([{
      type: 'function', name: 'builtin_tax_calculator', description: 'Calculates tax.',
      parameters: { type: 'object', properties: {}, required: [] },
    }]);

    const opencodeRequest = fetcher.mock.calls[1];
    expect(opencodeRequest[0]).toContain("https://opencode.ai/inference/openai/v1/chat/completions");
    expect(JSON.parse((opencodeRequest[1] as RequestInit).body as string)).toMatchObject({
      model: "kimi-k3",
      messages: [{ role: "user", content: "hello" }],
    });
    expect(
      JSON.parse((opencodeRequest[1] as RequestInit).body as string).tools[0].function.name,
    ).toBe("builtin_tax_calculator");
    expect(JSON.parse((opencodeRequest[1] as RequestInit).body as string).tools).toEqual([{
      type: 'function', function: { name: 'builtin_tax_calculator', description: 'Calculates tax.',
        parameters: { type: 'object', properties: {}, required: [] } },
    }]);
  });

  it("maps provider tool calls back to registered tool ids", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        output: [
          {
            type: "function_call",
            call_id: "tc-10",
            name: "builtin_tax_calculator",
            arguments: '{"amount":100,"taxRate":15}',
          },
        ],
      }),
    });

    const registry = new ProviderRegistry();
    registry.setEndpoint("openai", "https://api.openai.com/v1/responses", true);
    const openai = createManagerLlmAdapter({
      providerId: "openai",
      model: "gpt-5.6-terra",
      apiKey: "dummy-openai",
      registry,
      fetcher: fetcher as unknown as typeof fetch,
    });

    const result = await openai.complete({
      messages: [{ role: "user", content: "hello" }],
      tools: [
        {
          id: "builtin.tax_calculator",
          name: "Tax Calculator",
          description: "Calculates tax.",
          executable: true,
          kind: "built-in",
          inputSchema: { type: "object", properties: {}, required: [] },
        },
      ],
    });

    expect(result.toolCalls).toEqual([
      {
        id: "tc-10",
        toolId: "builtin.tax_calculator",
        arguments: { amount: 100, taxRate: 15 },
      },
    ]);
  });
});
