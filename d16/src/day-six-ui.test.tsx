import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { App } from "./main";

describe("Day 11 application shell", () => {
  it("exposes the navigation pages and keeps the batch action in Labs week 1", () => {
    const html = renderToStaticMarkup(<App />);
    const primaryTabs = html.slice(
      html.indexOf('aria-label="Primary navigation"'),
      html.indexOf('id="panel-lab"'),
    );
    expect(html).toContain("Day 16 — MCP Servers");
    expect(html).toContain("Week 3 / Day 16");
    expect(
      Array.from(
        primaryTabs.matchAll(/aria-controls="panel-([^"]+)"/g),
        (match) => match[1],
      ),
    ).toEqual(["lab", "agents", "users", "tools", "worker", "settings"]);
    expect(primaryTabs).toContain(">Labs<");
    const labsTabs = html.slice(html.indexOf('aria-label="Labs weeks"'), html.indexOf('aria-labelledby="labs-week1-tab"'));
    expect(Array.from(labsTabs.matchAll(/id="labs-week(\d)-tab"[^>]*>Week (\d)</g), match => [match[1], match[2]]))
      .toEqual([["1", "1"], ["2", "2"], ["3", "3"], ["4", "4"]]);
    expect(labsTabs.match(/aria-controls="labs-chat-panel"/g)).toHaveLength(2);
    expect(html.match(/id="labs-chat-panel"/g)).toHaveLength(1);
    expect(html).toContain("Agent Tool Lab");
    expect(html).toContain("Sessions");
    expect(html).toContain('aria-label="Empty chat"');
    expect(html).not.toContain("Start a conversation with");
    expect(html.match(/>Run Experiment</g)).toHaveLength(1);
    expect(html).toContain("Run Mode");
    expect(html).toContain("Open Full Report");
  });

  it("shows a centered creation entry point in place of the empty agent list and details", () => {
    const html = renderToStaticMarkup(<App />);
    const agents = html.slice(html.indexOf('id="panel-agents"'), html.indexOf('id="panel-tools"'));
    expect(agents).toContain("No agents yet");
    expect(agents).toContain("Create your first agent to start building your team.");
    expect(agents).toContain("Add Agent");
    expect(agents).not.toContain('aria-label="Agents"');
    expect(agents).not.toContain("Add New Agent");
    expect(agents).not.toContain('id="agent-general-tab"');
  });

  it("shows built-in tools, a custom empty state, and no direct tool execution action", () => {
    const html = renderToStaticMarkup(<App />);
    expect(html).toContain("Built-in Tools");
    expect(html).toContain("Tax Calculator");
    expect(html).toContain("Currency Converter");
    expect(html).toContain("Exchange Rate");
    expect(html).toContain("No custom tools yet");
    expect(html).toContain(
      "Create your first custom tool to extend your agents&#x27; capabilities.",
    );
    expect(html).toContain("Add custom tool");
    expect(html).not.toContain(">Run Tool<");
  });
});
