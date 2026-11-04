import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ThemeProvider } from "@mui/material";
import { describe, expect, it } from "vitest";
import { AnswerMarkdown, safeMarkdownLink } from "./answer-markdown";
import { resultMetadataRows, ResultMetadata } from "./result-metadata";
import { ParticipantDetails } from "./results";
import { createRun } from "./engine";
import { settings, type Attempt, type Expert } from "./models";
import { theme } from "./theme";
const expert: Expert = {
  ...settings("gpt-5.6-terra"),
  id: "expert-id",
  name: "Historical expert",
  description: "Test",
  rolePrompt: "Captured **literal** prompt",
};
const run = createRun(
  "Stored question",
  "Stored reference",
  [expert],
  "gpt-5.6-terra",
);
const result = run.results[0];
const attempt: Attempt = {
  id: "attempt-id",
  status: "succeeded",
  text: "**Bold answer**",
  actualModel: "reported-model-id",
  usage: { input: 0, output: 0, reasoning: 0 },
  ms: 0,
};
const render = (element: React.ReactNode) =>
  renderToStaticMarkup(<ThemeProvider theme={theme}>{element}</ThemeProvider>);
describe("safe answer Markdown", () => {
  it("renders ordinary Markdown and GFM tables without changing its input", () => {
    const text =
      "# Heading\n\n**Bold** and *emphasis* with `inline code`.\n\n- One\n- Two\n\n> Quoted\n\n```js\nconst x = 1;\n```\n\n| A | B |\n| --- | --- |\n| 0 | Value |";
    const html = render(<AnswerMarkdown text={text} />);
    expect(html).toContain("<strong>Bold</strong>");
    expect(html).toContain("<em>emphasis</em>");
    expect(html).toContain("<ul>");
    expect(html).toContain("<blockquote");
    expect(html).toContain("<pre");
    expect(html).toContain("Answer Markdown table");
    expect(html).toContain("const x = 1;");
    expect(text).toContain("**Bold**");
  });
  it("disables raw HTML, event handlers and embedded media, and makes unsafe links non-interactive", () => {
    const html = render(
      <AnswerMarkdown
        text={
          '<script>alert(1)</script>\n\n<img src="https://example.invalid/image" onerror="alert(1)">\n\n[unsafe](javascript:alert(1)) [data](data:text/html,blocked) ![image](https://example.invalid/remote)\n\n<iframe src="https://example.invalid"></iframe>'
        }
      />,
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("onerror");
    expect(html).not.toContain('href="javascript');
    expect(html).not.toContain('href="data:');
    expect(html).not.toContain("example.invalid");
    expect(html).toContain("unsafe");
  });
  it("allows safe user-activated links and plain text", () => {
    const html = render(
      <AnswerMarkdown
        text={
          "A plain answer.\nAnother line.\n\n[Docs](https://example.com/docs)"
        }
      />,
    );
    expect(html).toContain("A plain answer.");
    expect(html).toContain("Another line.");
    expect(html).toContain('href="https://example.com/docs"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('target="_blank"');
  });
  it.each([
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "data:text/html,blocked",
    "vbscript:blocked",
    "file:///blocked",
    "blob:https://example.com/id",
    "//example.com",
    "java\nscript:alert(1)",
    "\\example.com",
  ])("rejects unsafe URL %s", (url) =>
    expect(safeMarkdownLink(url)).toBeUndefined(),
  );
});
describe("captured result settings and usage presentation", () => {
  it("preserves reported zeroes and distinguishes the configured limit from actual usage", () => {
    const rows = resultMetadataRows(
      { ...result, attempts: [attempt] },
      attempt,
    );
    expect(Object.fromEntries(rows.settings)).toEqual({
      "Actual model": "reported-model-id",
      "Requested model": "gpt-5.6-terra",
      "Reasoning effort": "Low",
      "Output token limit": (8192).toLocaleString(),
    });
    const metrics = Object.fromEntries(rows.metrics);
    expect(metrics["Input tokens"]).toBe("0");
    expect(metrics["Output tokens"]).toBe("0");
    expect(metrics["Reasoning tokens"]).toBe("0");
    expect(metrics["Request duration"]).toBe("0.0 s");
    expect(metrics["Total output tokens across participant attempts"]).toBe(
      "0",
    );
    expect(metrics["Total participant request time across attempts"]).toBe(
      "0.0 s",
    );
  });
  it("shows unavailable usage and model values as unavailable, not zero", () => {
    const failed: Attempt = {
      id: "failed",
      status: "failed",
      text: "",
      error: "Sanitized error",
      ms: 12,
    };
    const rows = resultMetadataRows({ ...result, attempts: [failed] }, failed);
    const metrics = Object.fromEntries(rows.metrics);
    expect(Object.fromEntries(rows.settings)["Actual model"]).toBe(
      "Not available",
    );
    expect(metrics["Input tokens"]).toBe("Not available");
    expect(metrics["Output tokens"]).toBe("Not available");
    expect(metrics).not.toHaveProperty("Reasoning tokens");
    expect(metrics["Total input tokens across participant attempts"]).toBe(
      "Not available",
    );
    expect(rows.partial).toBe(true);
    expect(
      Object.fromEntries(
        resultMetadataRows({ ...result, attempts: [] }, undefined).metrics,
      )["Total participant request time across attempts"],
    ).toBe("Not available");
  });
  it("uses existing partial totals and never adds reasoning tokens to output again", () => {
    const second = {
      ...attempt,
      id: "second",
      usage: { input: 5, output: 9, reasoning: 3 },
      ms: 100,
    };
    const unknown = { ...attempt, id: "unknown", usage: undefined, ms: 50 };
    const metrics = Object.fromEntries(
      resultMetadataRows(
        { ...result, attempts: [attempt, second, unknown] },
        second,
      ).metrics,
    );
    expect(metrics["Total input tokens across participant attempts"]).toBe("5");
    expect(metrics["Total output tokens across participant attempts"]).toBe(
      "9",
    );
    expect(metrics["Total participant request time across attempts"]).toBe(
      "0.1 s",
    );
    expect(
      resultMetadataRows({ ...result, attempts: [second, unknown] }, second)
        .partial,
    ).toBe(true);
  });
  it("renders two-column standard settings and metric tables with the reasoning explanation", () => {
    const html = render(
      <ResultMetadata
        result={{ ...result, attempts: [attempt] }}
        attempt={attempt}
      />,
    );
    expect(html).toContain("Participant captured settings");
    expect(html).toContain("Participant usage");
    expect(html).toContain("Setting");
    expect(html).toContain("Metric");
    expect(html).toContain("Value");
    expect(html).toContain(
      "Reasoning tokens are included in output tokens, not added again.",
    );
  });
  it("removes visible UUID/context content while preserving snapshot data and plain captured prompts", () => {
    const snapshotBefore = JSON.stringify(run.snapshot);
    const html = render(
      <ParticipantDetails
        run={run}
        result={{ ...result, attempts: [attempt] }}
        judgment={{
          resultId: result.id,
          verdict: "correct",
          explanation: "Correct reason",
        }}
        disabled={false}
        refresh={() => {}}
        retry={() => {}}
      />,
    );
    expect(html).not.toContain(run.id);
    expect(html).not.toContain(result.id);
    expect(html).not.toContain("Run context");
    expect(html).not.toContain("Stored question");
    expect(html).not.toContain("Stored reference");
    expect(html).toContain("Captured **literal** prompt");
    expect(html).toContain("<strong>Bold answer</strong>");
    expect(html).toContain("Correct reason");
    expect(JSON.stringify(run.snapshot)).toBe(snapshotBefore);
  });
  it("keeps no-answer failures and attempt history available", () => {
    const failed = {
      ...attempt,
      status: "incomplete" as const,
      text: "",
      usage: undefined,
      error: "Incomplete synthetic response",
    };
    const html = render(
      <ParticipantDetails
        run={run}
        result={{ ...result, attempts: [failed] }}
        disabled={false}
        refresh={() => {}}
        retry={() => {}}
      />,
    );
    expect(html).toContain("No answer available.");
    expect(html).toContain("Incomplete synthetic response");
    expect(html).toContain("Retry this participant");
    expect(html).toContain("Attempt history");
    expect(html).toContain('aria-expanded="false"');
  });
});
