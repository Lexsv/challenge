import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatInvariants } from "./chat-invariants";
import { ChatComposer } from "./chat-composer";
import { ChatRunLog } from "./chat-run-log";
import type { TimelineEvent } from "./week2-agent-tool-lab";

describe("session invariants UI", () => {
  it("offers plain-text rule configuration inside chat settings", () => {
    const html = renderToStaticMarkup(
      <ChatInvariants
        base="/api/sessions/chat"
        disabled={false}
        onChange={() => {}}
      />,
    );
    expect(html).toContain("Invariants");
    expect(html).toContain("New invariant");
    expect(html).toContain("Add rule");
  });
  it("preserves surrounding Markdown and labels server-redacted text accessibly", () => {
    const html = renderToStaticMarkup(
      <ChatRunLog
        events={[
          {
            kind: "message",
            role: "assistant",
            id: "msg",
            runId: "run",
            createdAt: 1,
            text: "**Allowed** ████████ text, then ████████.",
          },
        ]}
      />,
    );
    const endOfLogs = html.lastIndexOf("</details>");
    expect(html.slice(0, endOfLogs)).toContain("Logs · Security");
    expect(html.slice(0, endOfLogs)).toContain("A session rule hides the marked parts");
    expect(html.slice(endOfLogs)).not.toContain("A session rule hides");
    expect(html.slice(endOfLogs)).toContain("<strong>Allowed</strong>");
    expect(html).toContain('aria-label="Redacted content"');
    expect(html.match(/A session rule hides the marked parts of this response\./g)).toHaveLength(1);
    expect(html).toContain("ShieldOutlinedIcon");
    expect(html).not.toContain("Content redacted");
  });
  it.each([
    ["████████", "A session rule hides this entire response."],
    ["████████, ████████.", "A session rule hides this entire response."],
    ["Plain text", null],
  ])("explains withholding only when the answer is hidden: %s", (text, explanation) => {
    const html = renderToStaticMarkup(
      <ChatRunLog events={[{ kind: "message", role: "assistant", id: "msg", runId: "run", createdAt: 1, text: text! }]} />,
    );
    if (explanation) expect(html).toContain(explanation);
    else expect(html).not.toContain("ShieldOutlinedIcon");
  });
  it("groups masked tool data inside the closed Security log", () => {
    const tool: Extract<TimelineEvent, { kind: "tool" }> = {
      kind: "tool", id: "tool", runId: "run", createdAt: 1, toolName: "Lookup",
      toolId: "lookup", category: "TOOL", status: "completed", durationMs: 1,
      arguments: { query: "████████" }, output: { detail: "Allowed ████████", note: "████████" },
    };
    const html = renderToStaticMarkup(<ChatRunLog events={[
      tool,
      { ...tool, id: "error", status: "failed", error: "████████." },
      { ...tool, id: "clean", output: "Public result" },
      { kind: "message", id: "answer", runId: "run", role: "assistant", createdAt: 2, text: "A public answer." },
    ]} />);
    const endOfLogs = html.lastIndexOf("</details>");
    expect(endOfLogs).toBeGreaterThan(0);
    expect(html).not.toMatch(/<details[^>]* open/);
    expect(html.slice(0, endOfLogs)).toContain('aria-label="Redacted content"');
    expect(html.slice(0, endOfLogs)).toContain("Public result");
    expect(html.slice(0, endOfLogs)).toContain(">Logs · Security<");
    expect(html.slice(0, endOfLogs)).toContain(">Failed<");
    expect(html.slice(0, endOfLogs).match(/A session rule hides marked tool data/g)).toHaveLength(1);
    expect(html.slice(endOfLogs)).not.toContain("A session rule hides");
  });
  it("changes only the affected turn's Logs title when its masked reply arrives", () => {
    const start = (id: string): TimelineEvent => ({
      kind: "manager", id: id + "-start", runId: id, category: "MANAGER",
      status: "completed", description: "Run started", createdAt: 1,
    });
    const answer = (id: string, text: string): TimelineEvent => ({
      kind: "message", id: id + "-answer", runId: id, role: "assistant", createdAt: 2, text,
    });
    const events = [start("first"), answer("first", "Public reply."), start("second")];
    const titles = (markup: string) => Array.from(markup.matchAll(/<summary\b[^>]*>([\s\S]*?)<\/summary>/g),
      match => match[1].replace(/<style\b[^>]*>[\s\S]*?<\/style>|<[^>]+>/g, ""));
    expect(titles(renderToStaticMarkup(<ChatRunLog events={events} />))).toEqual(["Logs", "Logs"]);
    const html = renderToStaticMarkup(<ChatRunLog events={[...events, answer("second", "Public ████████.")]} />);
    expect(titles(html)).toEqual(["Logs", "Logs · Security"]);
    expect(html).not.toMatch(/<details[^>]*\sopen/);
    const second = html.slice(html.indexOf(">Logs · Security<"));
    expect(second.slice(0, second.indexOf("</details>"))).toContain("A session rule hides the marked parts");
    expect(second.slice(second.indexOf("</details>"))).toContain('aria-label="Redacted content"');
    expect(html.slice(0, html.indexOf(">Logs · Security<"))).not.toContain("A session rule hides");
  });
  it("pairs each blocked question with a closed log even outside the recent audit window", () => {
    const events: TimelineEvent[] = ["first", "second"].map(id => ({
      kind: "message", role: "user", id, runId: id, blocked: true, text: "Same question?", createdAt: 1,
    }));
    const html = renderToStaticMarkup(<ChatRunLog events={events} />);
    expect(html.match(/Same question\?|Logs · Security/g)).toEqual([
      "Same question?", "Logs · Security", "Same question?", "Logs · Security",
    ]);
    expect(html).not.toMatch(/<details[^>]*\sopen/);
  });
  it("renders a legacy audit-only block without inventing a question", () => {
    const html = renderToStaticMarkup(
      <ChatRunLog
        events={[]}
        security={[
          {
            type: "SECURITY",
            turnId: "turn",
            sessionId: "chat",
            invariantId: "rule",
            stage: "input",
            action: "blocked",
            timestamp: 1,
          },
        ]}
      />,
    );
    expect(html).toContain("Logs · Security");
    expect(html).toContain("Request blocked");
    expect(html).toContain("ShieldOutlinedIcon");
    expect(html).toContain("This request was blocked because it violates a content rule for this chat.");
    expect(html).not.toMatch(/Stage:|Action:|Invariant:|Session:|Turn:|1970-01-01/);
  });
  it("allows editing a draft while its context strategy is incompatible with sending", () => {
    const html = renderToStaticMarkup(
      <ChatComposer
        draft="Save an update"
        disabled={false}
        running={false}
        sendDisabled
        onDraftChange={() => {}}
        onSend={() => {}}
      />,
    );
    expect(html).toMatch(/<button[^>]*disabled/);
    expect(html).not.toMatch(/<textarea[^>]*disabled/);
  });
});
