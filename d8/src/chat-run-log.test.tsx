import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatRunLog, groupChatEvents } from "./chat-run-log";
import { chatStatusColor, chatTypeColor } from "./chat-disclosure";
import { toolExecutionTypeMeta } from "./tool-execution-type";
import { getContrastRatio } from "@mui/material/styles";
import { theme } from "./theme";
import { RequestMeterCard } from "./request-meter-card";
import type { TimelineEvent } from "./week2-agent-tool-lab";
import { createManagerConversation } from "./manager-agent";
import { restoreHistory, type HistoryEvent } from "./conversation-history";
import { buildWeek2Timeline } from "./week2-agent-tool-lab";
import { createBuiltInToolRegistry } from "./tool-runtime";

const meter = {
  id: "request",
  sessionId: "session",
  runId: "run",
  provider: "openai",
  model: "gpt-4o-mini",
  library: "js-tiktoken" as const,
  status: "completed" as const,
  startedAt: 3,
  estimatedInputTokens: 100,
  actualInputTokens: 101,
  actualOutputTokens: 5,
  actualTotalTokens: 106,
};
const events: TimelineEvent[] = [
  {
    kind: "message",
    id: "user",
    runId: "run",
    role: "user",
    text: "Calculate 10% tax",
    createdAt: 1,
  },
  {
    kind: "manager",
    id: "start",
    runId: "run",
    category: "MANAGER",
    status: "running",
    description: "Run started",
    createdAt: 2,
  },
  { kind: "metering", id: "request", runId: "run", meter, createdAt: 3 },
  {
    kind: "tool",
    id: "tool",
    runId: "run",
    toolId: "builtin.tax_calculator",
    toolName: "Tax Calculator",
    toolCallId: "call",
    executionType: "function",
    status: "completed",
    arguments: { amount: 100, taxRate: 10 },
    output: { total: 110 },
    durationMs: 1,
    category: "TOOL",
    createdAt: 4,
  },
  {
    kind: "message",
    id: "answer",
    runId: "run",
    role: "assistant",
    text: "The total is 110.",
    createdAt: 5,
  },
  {
    kind: "manager",
    id: "end",
    runId: "run",
    category: "MANAGER",
    status: "completed",
    description: "Run completed",
    createdAt: 6,
  },
];

it("groups run activity in original order without mutating events or message order", () => {
  const before = structuredClone(events);
  const rows = groupChatEvents(events);
  expect(rows.map((row) => row.kind)).toEqual(["message", "logs", "message"]);
  expect(
    rows[1].kind === "logs" && rows[1].events.map((event) => event.id),
  ).toEqual(["start", "request", "tool", "end"]);
  expect(events).toEqual(before);
  const next = [
    ...events,
    { ...events[0], id: "next-user", runId: "next" },
    { ...events[1], id: "next-start", runId: "next" },
  ];
  expect(
    groupChatEvents(next).filter((row) => row.kind === "logs"),
  ).toHaveLength(2);
});

it("uses initially closed independent disclosures, text labels and retained metrics/details", () => {
  const html = renderToStaticMarkup(<ChatRunLog events={events} />);
  expect(html.match(/<details/g) ?? []).toHaveLength(3);
  expect(html).not.toMatch(/<details[^>]*\sopen/);
  expect(html).toContain("Logs");
  expect(html.replace(/<[^>]+>/g, "")).toContain("Library · js-tiktoken");
  expect(html).toContain("Function");
  expect(html).toContain("Tax Calculator");
  expect(html).toContain("Manager");
  expect(html).toContain("Running");
  expect(html).toContain("Completed");
  expect(html).toContain("Estimated input tokens: 100");
  expect(html).toContain("Actual output: 5");
  expect(html).toContain("Arguments");
  expect(html).toContain("110");
  expect(html).not.toContain("MuiChip");
  expect(html).not.toContain(">USER<");
  expect(html).not.toContain(">User<");
  expect(html).toContain("border:1px solid");
  expect(html).toContain("text-align:left");
  expect(chatStatusColor("completed")).toBe("#17602F");
  expect(chatStatusColor("running")).toBe("#48515A");
  const timeline = renderToStaticMarkup(<RequestMeterCard meter={meter} />);
  expect(timeline).toContain("MuiChip");
  expect(timeline).toContain("MuiAccordion");
});

it("keeps chat type inks distinct and readable without changing failure/error hues", () => {
  expect(new Set(Object.values(chatTypeColor)).size).toBe(4);
  for (const type of ["library", "http", "function"] as const) expect(chatTypeColor[type]).toBe(toolExecutionTypeMeta[type].color);
  for (const ink of [...Object.values(chatTypeColor), chatStatusColor('completed'), chatStatusColor('running')])
    for (const background of [theme.palette.background.default, theme.palette.background.paper])
      expect(getContrastRatio(ink, background)).toBeGreaterThanOrEqual(4.5);
  expect(chatStatusColor('failed')).toBe('error.main');
  expect(chatStatusColor('error')).toBe('warning.main');
});

it("adds live steps to the same group and retains errors outside run logs", () => {
  const active = events.slice(0, 2);
  expect(
    groupChatEvents(active).filter((row) => row.kind === "logs"),
  ).toHaveLength(1);
  const updated = groupChatEvents(events);
  expect(updated[1].id).toBe(groupChatEvents(active)[1].id);
  const error: TimelineEvent = {
    kind: "manager",
    id: "error",
    runId: "ui",
    category: "SYSTEM",
    status: "failed",
    description: "No provider key",
    createdAt: 7,
  };
  expect(groupChatEvents([...events, error]).at(-1)?.kind).toBe("activity");
});

it("builds collapsed Logs from restored history including compaction steps and saved results", () => {
  const initial = createManagerConversation();
  const session = initial.conversation.id;
  const saved: HistoryEvent[] = [
    {
      id: "saved-run",
      sessionId: session,
      sequence: 1,
      type: "run",
      payload: {
        id: "run",
        conversationId: session,
        agentId: "manager",
        status: "completed",
        startedAt: 1,
        endedAt: 5,
        messageIds: [],
        toolExecutionIds: ["tool"],
      },
    },
    {
      id: "saved-call",
      sessionId: session,
      sequence: 2,
      type: "tool-call",
      payload: {
        id: "tool",
        runId: "run",
        toolId: "builtin.tax_calculator",
        toolCallId: "call",
        status: "running",
        startedAt: 2,
        arguments: { amount: 100, taxRate: 10 },
      },
    },
    {
      id: "saved-result",
      sessionId: session,
      sequence: 3,
      type: "tool-result",
      payload: {
        id: "tool",
        runId: "run",
        toolId: "builtin.tax_calculator",
        toolCallId: "call",
        status: "completed",
        startedAt: 2,
        endedAt: 3,
        arguments: { amount: 100, taxRate: 10 },
        output: { total: 110 },
      },
    },
    {
      id: "saved-context",
      sessionId: session,
      sequence: 4,
      type: "context",
      payload: {
        id: "context",
        runId: "run",
        createdAt: 4,
        phase: "compacting",
      },
    },
  ];
  const restored = restoreHistory(initial, saved);
  const timeline = buildWeek2Timeline(restored, createBuiltInToolRegistry());
  const html = renderToStaticMarkup(<ChatRunLog events={timeline} />);
  expect(html).toContain("Compacting context");
  expect(html).toContain("110");
  expect(html).toContain("Logs");
  expect(html).not.toMatch(/<details[^>]*\sopen/);
  expect(restored.toolExecutions[0].output).toEqual({ total: 110 });
});

it('marks collapsed Logs failed for a tool or provider failure even when the run completes',()=>{
 for(const failure of [
  {...events.find(e=>e.kind==='tool')!,status:'failed'},
  {kind:'metering',id:'failed-request',runId:'run',createdAt:3,meter:{...meter,status:'failed'}},
 ] as TimelineEvent[]){
  const html=renderToStaticMarkup(<ChatRunLog events={[...events,failure]}/>);
  expect(html).toContain('Logs · Failed');
  expect(html).not.toMatch(/<details[^>]* open/);
  expect(html).toContain('summary');
 }
});

it('constrains both message types on desktop while allowing narrow screens and wrapping long text',()=>{
 const long='unbroken'.repeat(100);
 const html=renderToStaticMarkup(<ChatRunLog events={[
  {kind:'message',id:'u',runId:'r',role:'user',text:long,createdAt:1},
  {kind:'message',id:'a',runId:'r',role:'assistant',text:long,createdAt:2},
 ]}/>);
 expect(html).toContain('width:-moz-fit-content');
 expect(html).toContain('max-width:100%');
 expect(html).toContain('@media (min-width:900px)');
 expect(html).toContain('max-width:80%');
 expect(html).toContain('overflow-wrap:anywhere');
 expect(html).toContain('overflow-x:auto');
});
