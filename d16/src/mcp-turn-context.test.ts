import { expect, it } from "vitest";
import { ManagerAgent, createManagerConversation } from "./manager-agent";
import {
  createManagerLlmAdapter,
  managerContextBudget,
} from "./manager-llm-adapter";
import { createProviderRegistry } from "./provider-registry";
import { MemoryProcessor, SessionMemory } from "./session-memory";
import { ToolRegistry, type McpToolCatalogItem } from "./tool-runtime";

it("dispatches complete arguments and fits a growing MCP turn into the provider budget without losing the objective or receipt", async () => {
  const providerId = "opencode-console",
    model = "fixture";
  const registry = createProviderRegistry();
  registry.get(providerId)!.limits = () => ({
    contextWindow: 9000,
    maxOutputTokens: 2048,
  });
  const budget = managerContextBudget({ registry, providerId, model });
  expect(budget).toMatchObject({
    replyTokens: 2048,
    uncertaintyTokens: 1024,
    inputBudget: 5928,
  });
  const question = "Build the requested design and verify the result.";
  const code = "draw(12345);".repeat(2500);
  const url = "https://fixture.invalid/design/42";
  const id = crypto.randomUUID();
  const tool: McpToolCatalogItem = {
    id: "mcp:" + id,
    toolId: id,
    connectionId: crypto.randomUUID(),
    source: "mcp",
    kind: "mcp",
    originalName: "edit",
    name: "edit",
    description: "Modify the test design",
    metadata: {},
    executable: true,
    inputSchema: {
      type: "object",
      properties: { code: { type: "string" } },
      required: ["code"],
    },
  };
  const wire: Record<string, unknown>[] = [];
  const adapter = createManagerLlmAdapter({
    providerId,
    registry,
    model,
    apiKey: "",
    transport: async (_, body) => {
      wire.push(body);
      const message =
        wire.length === 1
          ? {
              role: "assistant",
              tool_calls: [
                {
                  id: "edit-1",
                  type: "function",
                  function: {
                    name: "mcp_" + id.replaceAll("-", ""),
                    arguments: JSON.stringify({ code }),
                  },
                },
              ],
            }
          : { role: "assistant", content: "Verified " + url };
      return {
        status: 200,
        body: {
          model,
          choices: [
            {
              finish_reason: wire.length === 1 ? "tool_calls" : "stop",
              message,
            },
          ],
        },
      };
    },
  });
  const memory = new SessionMemory(
    { load: async () => ({ revision: 0, data: null }), save: async (s) => s },
    new MemoryProcessor(adapter),
    model,
  );
  const manager = new ManagerAgent(adapter, new ToolRegistry());
  const output = {
    content: [{ type: "text", text: "Result details ".repeat(12000) }],
    structuredContent: { created: true, url },
  };
  const run = await manager.run({
    state: createManagerConversation(),
    userText: question,
    sessionMemory: memory,
    sessionTools: () => ({
      availability: [{ service: "Design", callable: 1, issues: [] }],
      tools: [tool],
      plan: () => ({
        allowed: true,
        safety: "side-effecting",
        ready: true,
        check: () => true,
        invoke: async () => ({ ok: true, toolId: tool.id, output }),
      }),
    }),
    executeDurably: async (operation) => {
      expect(operation.call.arguments).toEqual({ code });
      return { ok: true, outcome: "Success", toolId: tool.id, output };
    },
  });
  expect(run.error).toBeUndefined();
  expect(wire).toHaveLength(2);
  const sent = JSON.stringify(wire[1]);
  for (const evidence of [
    question,
    "Completed tool exchange",
    "edit-1",
    "Success",
    url,
  ])
    expect(sent).toContain(evidence);
  expect(sent).not.toContain("draw(12345)");
  expect(sent).not.toContain("Result details");
  expect(run.state.toolExecutions[0]).toMatchObject({
    arguments: { code },
    output,
  });
});
