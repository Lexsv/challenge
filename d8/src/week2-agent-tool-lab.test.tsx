import { credentials } from "./saved-credentials";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ProviderRegistry } from "./provider-registry";
import {
  Week2AgentToolLab,
  SessionChat,
  buildWeek2Timeline,
  technicalEventMaxWidth,
  timelineToolCategoryLabel,
} from "./week2-agent-tool-lab";
import { createManagerConversation } from "./manager-agent";
import type { ManagerConversationState } from "./manager-agent";
import { createBuiltInToolRegistry } from "./tool-runtime";

const toolRegistry = createBuiltInToolRegistry();

function timelineFixture(): ManagerConversationState {
  return {
    conversation: {
      id: "c1",
      messageIds: ["m1", "m2"],
      runIds: ["r1"],
      startedAt: 1,
    },
    runs: [
      {
        id: "r1",
        conversationId: "c1",
        agentId: "manager",
        status: "completed",
        startedAt: 2,
        endedAt: 6,
        messageIds: ["m1", "m2"],
        toolExecutionIds: ["t1"],
      },
    ],
    messages: [
      {
        id: "m1",
        conversationId: "c1",
        runId: "r1",
        createdAt: 1,
        role: "user",
        type: "text",
        text: "Hi",
      },
      {
        id: "m2",
        conversationId: "c1",
        runId: "r1",
        createdAt: 5,
        role: "assistant",
        type: "text",
        text: "Done",
      },
    ],
    toolExecutions: [
      {
        id: "t1",
        runId: "r1",
        toolId: "builtin.tax_calculator",
        toolCallId: "tc1",
        status: "completed",
        arguments: { amount: 100, taxRate: 15 },
        output: { total: 115 },
        startedAt: 3,
        endedAt: 4,
      },
    ],
  };
}

function useIdenticalTimestamps(state: ManagerConversationState): void {
  for (const message of state.messages) message.createdAt = 10;
  for (const run of state.runs) {
    run.startedAt = 10;
    run.endedAt = 10;
  }
  for (const execution of state.toolExecutions) {
    execution.startedAt = 10;
    execution.endedAt = 10;
  }
}

describe("week 2 agent tool lab", () => {
  it("keeps the chat blank while the session list is loading", () => {
    const html = renderToStaticMarkup(
      <Week2AgentToolLab toolRegistry={toolRegistry} registry={new ProviderRegistry()}
        openAIModel="gpt-5.6-terra" onOpenAIModelChange={() => {}} openAIKey=""
        openCodeKeys={{ "opencode-console": "", "opencode-go": "" }} />,
    );
    expect(html).toContain('aria-label="Session list"');
    expect(html.indexOf('aria-label="Sessions"')).toBeLessThan(html.indexOf('aria-label="Empty chat"'));
    expect(html).toContain("240px minmax(0, 1fr)");
    expect(html).toContain('aria-label="New session"');
    expect(html).toContain('aria-label="Empty chat"');
    expect(html).not.toContain('aria-label="Send message"');
    expect(html).not.toContain("Start a new session");
    expect(html).not.toContain('MuiListItemButton-root');
  });

  it("renders compact chat workspace", () => {
    const html = renderToStaticMarkup(
      <SessionChat
        initialConversation={createManagerConversation()}
        title="Agent Tool Lab"
        toolRegistry={toolRegistry}
        registry={new ProviderRegistry()}
        openAIModel="gpt-5.6-terra"
        onOpenAIModelChange={() => {}}
        openAIKey=""
        openCodeKeys={{ "opencode-console": "", "opencode-go": "" }}
      />,
    );
    expect(html).toContain("Agent Tool Lab");
    expect(html).toContain("Start a conversation with OpenAI · gpt-5.6-terra");
    expect(html).toContain("Open chat settings");
    expect(html).toContain("managed in Providers");
    expect(html).not.toContain("Saved key: present");
    expect(html).not.toContain("Requests use the local backend");
    expect(html).toContain("Send message");
    expect(html).toContain("width:40px");
    expect(html).toContain("height:40px");
    expect(html).toContain("min-width:40px");
    expect(html).toContain("min-height:40px");
    expect(html).toContain("position:absolute");
    expect(html).toContain("right:8px");
    expect(html).toContain("bottom:8px");
    expect(html).toContain("border-radius:50%");
    expect(html).toContain("padding:12px 56px 12px 14px");
    expect(html).toContain("border-radius:8px");
    expect(html).toContain("overflow-y:auto");
  });

  it("caps content-sized technical events at 100% on mobile and 70% on desktop", () => {
    expect(technicalEventMaxWidth).toEqual({ xs: "100%", md: "70%" });
  });

  it("builds a unified timeline in causal timestamp order", () => {
    const timeline = buildWeek2Timeline(timelineFixture(), toolRegistry);
    expect(timeline.map((entry) => entry.id)).toEqual([
      "m1",
      "r1:start",
      "t1",
      "m2",
      "r1:end",
    ]);
    expect(timeline[2]).toMatchObject({
      kind: "tool",
      toolId: "builtin.tax_calculator",
      toolName: "Tax Calculator",
      executionType: "function",
      toolCallId: "tc1",
      durationMs: 1,
    });
  });

  it("shows execution-type badge labels for tool timeline events", () => {
    const timeline = buildWeek2Timeline(timelineFixture(), toolRegistry);
    const toolEvent = timeline.find((entry) => entry.kind === "tool");
    if (!toolEvent || toolEvent.kind !== "tool") throw new Error("expected tool event");

    expect(timelineToolCategoryLabel(toolEvent.executionType)).toBe("FUNCTION");
    expect(timelineToolCategoryLabel("http")).toBe("HTTP API");
    expect(timelineToolCategoryLabel("agent")).toBe("AGENT");
    expect(timelineToolCategoryLabel(undefined)).toBe("TOOL");
  });

  it("falls back to the technical ID for an unknown tool", () => {
    const state = timelineFixture();
    state.toolExecutions[0].toolId = "builtin.unknown";

    const tool = buildWeek2Timeline(state, toolRegistry).find((entry) => entry.kind === "tool");

    expect(tool).toMatchObject({
      toolId: "builtin.unknown",
      toolName: "builtin.unknown",
    });
  });

  it("uses stable causal ordering when every timestamp is identical", () => {
    const state = timelineFixture();
    useIdenticalTimestamps(state);

    const first = buildWeek2Timeline(state, toolRegistry);
    const second = buildWeek2Timeline(state, toolRegistry);

    expect(first.map((entry) => entry.id)).toEqual([
      "m1",
      "r1:start",
      "t1",
      "m2",
      "r1:end",
    ]);
    expect(second.map((entry) => entry.id)).toEqual(first.map((entry) => entry.id));
    expect(first.map((entry) => entry.createdAt)).toEqual([10, 10, 10, 10, 10]);
  });

  it("keeps multiple turns in their original causal order on timestamp ties", () => {
    const state = timelineFixture();
    state.conversation.messageIds.push("m3", "m4");
    state.conversation.runIds.push("r2");
    state.runs.push({
      id: "r2",
      conversationId: "c1",
      agentId: "manager",
      status: "failed",
      startedAt: 10,
      endedAt: 10,
      messageIds: ["m3", "m4"],
      toolExecutionIds: ["t2"],
    });
    state.messages.push(
      {
        id: "m3",
        conversationId: "c1",
        runId: "r2",
        createdAt: 10,
        role: "user",
        type: "text",
        text: "Again",
      },
      {
        id: "m4",
        conversationId: "c1",
        runId: "r2",
        createdAt: 10,
        role: "assistant",
        type: "text",
        text: "Failed answer",
      },
    );
    state.toolExecutions.push({
      id: "t2",
      runId: "r2",
      toolId: "builtin.tax_calculator",
      toolCallId: "tc2",
      status: "failed",
      arguments: {},
      error: "Invalid arguments",
      startedAt: 10,
      endedAt: 10,
    });
    useIdenticalTimestamps(state);

    expect(buildWeek2Timeline(state, toolRegistry).map((entry) => entry.id)).toEqual([
      "m1",
      "r1:start",
      "t1",
      "m2",
      "r1:end",
      "m3",
      "r2:start",
      "t2",
      "m4",
      "r2:end",
    ]);
  });
});

it("omits the session-title credential caption even when a saved key is present", async () => {
  const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ saved: true, verification: 'verified' }) });
  vi.stubGlobal('fetch', fetcher);
  try {
    await credentials.verify('openai');
    const html = renderToStaticMarkup(<SessionChat
      initialConversation={createManagerConversation()} title="Saved session"
      toolRegistry={toolRegistry} registry={new ProviderRegistry()} openAIModel="gpt-5.6-terra"
      onOpenAIModelChange={() => {}} openAIKey=""
      openCodeKeys={{ 'opencode-console': '', 'opencode-go': '' }} />);
    expect(html).toContain('Saved session');
    expect(html).not.toContain('Saved key: present');
    expect(html).not.toContain('Verification:');
    expect(html).not.toContain('Requests use the local backend');
  } finally {
    fetcher.mockResolvedValue({ ok: true, json: async () => ({ saved: false, verification: 'unchecked' }) });
    await credentials.forget('openai');
    vi.unstubAllGlobals();
  }
});
