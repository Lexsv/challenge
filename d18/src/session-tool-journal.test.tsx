import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  SessionTools,
  JournalDetails,
  journalView,
  journalStatusStyle,
  toolUsage,
  type JournalRow,
} from "./session-tool-journal";
import { ChatRunLog } from "./chat-run-log";
const row: JournalRow = {
  id: "call",
  runId: "run",
  runState: "PartialSuccess",
  llmCallId: "model",
  toolId: "mcp:1",
  connectionId: "a",
  type: "MCP",
  name: "search",
  server: "North",
  status: "Success",
  created: 1,
  ended: 20,
  attempts: 2,
  duration: 12,
  spans: [
    [1, 3],
    [10, 20],
  ],
};
describe("Week 4 execution presentation", () => {
  it("separates logical calls, retries, failures, uncertain outcomes and connections", () => {
    const groups = toolUsage([
      row,
      { ...row, id: "next", attempts: 1, status: "Failed", duration: 3 },
      { ...row, id: "uncertain", attempts: 1, status: "Unknown", duration: 4 },
      {
        ...row,
        id: "other",
        connectionId: "b",
        toolId: "mcp:2",
        server: "South",
        status: "Skipped",
        attempts: 0,
        duration: 0,
      },
    ]);
    expect(
      groups.map(({ calls, success, failed, retries, duration }) => [
        calls,
        success,
        failed,
        retries,
        duration,
      ]),
    ).toEqual([
      [3, 1, 1, 1, 19],
      [1, 0, 0, 0, 0],
    ]);
  });
  it("filters warnings separately and counts them once among successful calls", () => {
    const warned = {...row, id:"warned", hasWarning:true};
    const skipped = {...row, id:"skipped", status:"Skipped", attempts:0, duration:0};
    const rows = [row, warned, skipped, {...row,status:"Failed"}, {...row,status:"Unknown"}];
    expect(journalView(rows,"","").statuses).toEqual(["","Success","Success with warning","Skipped","Failed","Unknown"]);
    expect(journalView(rows,"","Success with warning").entries).toEqual([warned]);
    expect(journalView(rows,"","Success").entries).toEqual([row]);
    expect(toolUsage(rows)[0]).toMatchObject({calls:5, success:2, warnings:1, failed:1, other:{Skipped:1,Unknown:1}});
    expect(["Success","Success with warning","Skipped","Failed","Unknown"].map(s=>journalStatusStyle(s).bgcolor))
      .toEqual(["success.light","#fff1b8","#e8eaf0","error.light","#ffe3cc"]);
  });
  it("uses the durable outcome for legacy failed events and journal-only skips", () => {
    const skipped = {...row,status:"Skipped",attempts:0};
    const legacy = {kind:"tool" as const, id:row.id, runId:row.runId, toolId:row.toolId, createdAt:1,
      toolName:row.name, status:"failed" as const, durationMs:0, arguments:{}, category:"TOOL" as const};
    for (const events of [[legacy],[]]) {
      const html = renderToStaticMarkup(<ChatRunLog week3 events={events} journal={[skipped]}/>);
      expect(html).toContain("MCP | North | search | Skipped");
      expect(html).not.toContain("Logs · Failed");
    }
    const failed = renderToStaticMarkup(<ChatRunLog week3 events={[legacy]} journal={[{...row,status:"Failed"}]}/>);
    expect(failed).toContain("Logs · Failed");
  });
  it("renders one compact outcome in the original chat log without arguments or raw results", () => {
    const html = renderToStaticMarkup(
      <ChatRunLog
        week3
        journal={[row]}
        events={[
          {
            id: "call",
            runId: "run",
            kind: "tool",
            toolId: "mcp:1",
            createdAt: 1,
            toolName: "old",
            status: "completed",
            durationMs: 20,
            arguments: { query: "hidden fixture payload" },
            output: "private fixture result",
            category: "TOOL",
          },
        ]}
      />,
    );
    expect(html).toContain("MCP | North | search | Success");
    expect(html.match(/<details\b/g)).toHaveLength(1);
    expect(html).not.toMatch(
      /hidden fixture payload|private fixture result|Arguments|Tool ID/,
    );
  });
  it("provides a session-scoped journal entry point even for a new chat", () => {
    const html = renderToStaticMarkup(
      <SessionTools session="fresh" revision="0" rows={[]} />,
    );
    expect(html).toContain("0 calls");
    expect(html).toContain("Open Execution Journal");
  });
});

describe("Tool Execution Journal dialog", () => {
  it("offers only observed statuses before applying the active filter, in stable order", () => {
    const newer = { ...row, id: "second", created: 2, status: "Failed" };
    const other = { ...newer, id: "third", connectionId: "b" };
    const internal = {
      ...row,
      id: "function",
      type: "function",
      connectionId: null,
      status: "Pending",
    };
    const rows = [row, internal, newer, other];
    expect(journalView(rows, "", "").statuses).toEqual([
      "",
      "Success",
      "Failed",
      "Pending",
    ]);
    expect(journalView([...rows].reverse(), "a", "Failed").statuses).toEqual([
      "",
      "Success",
      "Failed",
    ]);
    expect(journalView(rows, "b", "Success")).toEqual({
      statuses: ["", "Failed"],
      selected: "",
      entries: [other],
    });
    expect(journalView(rows, "", "").entries.map((r) => r.id)).toEqual([
      "third",
      "second",
      "function",
      "call",
    ]);
    expect(journalView(rows, "a", "Failed").entries).toEqual([newer]);
    expect(journalView(rows, "", "Pending").entries).toEqual([internal]);
    expect(rows[0]).toBe(row);
  });
  it("resets a vanished status on refresh and offers only All for an empty journal", () => {
    const pending = { ...row, status: "Pending" };
    const before = journalView([pending], "a", "Pending");
    expect(before.selected).toBe("Pending");
    const after = journalView([row], "a", before.selected);
    expect(after).toEqual({
      statuses: ["", "Success"],
      selected: "",
      entries: [row],
    });
    expect(
      journalView([pending, row], "a", after.selected).entries,
    ).toHaveLength(2);
    expect(journalView([], "", "Success")).toEqual({
      statuses: [""],
      selected: "",
      entries: [],
    });
  });
  const detail = {
    arguments: '{"action":"list","per_page":100}',
    result: JSON.stringify({
      structuredContent: { projects: [{ id: "proj_1", name: "Product" }] },
      content: [{ text: "Additional service information" }],
    }),
    authorization: "connection auto-approve",
    validation: "passed",
    dependencies: ["hidden-parent"],
    restricted: false,
    error: {
      message: "Diagnostic",
      toolCallId: "hidden-call",
      runId: "hidden-run",
      connectionId: "hidden-connection",
    },
    attempts: [
      {
        id: "hidden-attempt",
        ordinal: 1,
        started: 1,
        ended: 20,
        state: "Success",
        error: null,
        request: '{"jsonrpc":"2.0","id":"hidden-rpc","method":"tools/call"}',
      },
    ],
  };
  it("presents highlighted structured data, artifact IDs and attempt evidence without correlation identifiers", () => {
    const html = renderToStaticMarkup(
      <JournalDetails detail={detail} row={row} peers={[]} />,
    );
    for (const word of [
      "Authorization",
      "Argument validation",
      "Arguments",
      "Result",
      "Attempt 1",
      "per_page",
      "proj_1",
      "Additional service information",
      "tools/call",
      "Diagnostic",
    ])
      expect(html).toContain(word);
    expect(html).not.toMatch(/hidden-|Raw View|Structured View|Tool type/);
    expect(html).toMatch(/<pre\b/);
  });
  it("shows the original skip diagnostic as an informational reason", () => {
    const message = "Batch independence was not established.";
    const skipped = {...detail, attempts:[], error:{code:"dependency",skipReason:"batch_independence_unproven",message}};
    const html = renderToStaticMarkup(<JournalDetails detail={skipped} row={{...row,status:"Skipped"}} peers={[]}/>);
    expect(html).toContain("Skip reason");
    expect(html).toContain("batch_independence_unproven");
    expect(html).toContain(message);
    expect(html).not.toContain("Execution error");
  });
  it("keeps restricted payloads out of the rendered journal", () => {
    const html = renderToStaticMarkup(
      <JournalDetails
        detail={{ ...detail, restricted: true }}
        row={row}
        peers={[]}
      />,
    );
    expect(html).toContain("Session rules restrict payload inspection.");
    expect(html).not.toMatch(
      /per_page|proj_1|Additional service information|tools\/call/,
    );
  });
});
