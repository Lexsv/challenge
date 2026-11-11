import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ThemeProvider } from "@mui/material";
import { theme } from "./theme";
import { RunView } from "./results";
import { tableFixtureRuns } from "./result-table-fixture";
import { ResultBadge } from "./result-badge";

const render = (child: React.ReactNode) =>
  renderToStaticMarkup(<ThemeProvider theme={theme}>{child}</ThemeProvider>);
describe("compact results table", () => {
  it("labels correctness and technical status separately with accessible automated attribution", () => {
    for (const [value, label] of Object.entries({
      correct: "Correct",
      incorrect: "Incorrect",
      unable_to_assess: "Unable to assess",
      stale: "Stale",
      pending: "Pending",
      "Not available": "Not available",
    })) {
      const html = render(<ResultBadge value={value} automated />);
      expect(html).toContain(`AI evaluation: ${label}`);
      expect(html).not.toContain("AI:");
    }
    for (const value of [
      "succeeded",
      "failed",
      "incomplete",
      "timed-out",
      "pending",
      "running",
    ]) {
      const html = render(<ResultBadge value={value} />);
      expect(html).toContain("Technical status:");
      if (value === "running") expect(html).toContain("MuiCircularProgress");
    }
  });
  it("preserves full answers, meaningful token values, manual distinction, and shared table sizing", () => {
    const run = tableFixtureRuns()[0];
    const before = JSON.stringify(run);
    const html = render(
      <RunView
        run={run}
        disabled={false}
        refresh={() => {}}
        retry={() => {}}
        retryEvaluation={() => {}}
      />,
    );
    expect(html).toContain(">Verdict</th>");
    expect(html).toContain("Cost (USD)");
    expect(html).toContain("Total experiment cost:");
    expect(html).toContain("border-bottom");
    expect(html).not.toContain("AI verdict");
    expect(html).toContain("AI evaluation: Incorrect");
    expect(html).toContain("Manual: Correct");
    expect(html).toContain("123,456,789");
    expect(html).toContain("987,654,321");
    expect(html).toContain("UnbrokenAnswer".repeat(60));
    expect(html).toContain("max-height:6em");
    expect(html).toContain("table-layout:fixed");
    expect(html).toContain("<colgroup>");
    expect(JSON.stringify(run)).toBe(before);
  });
  it("hides outdated judgments and preserves missing and pending verdict states", () => {
    const runs = tableFixtureRuns();
    for (const [run, expected] of [
      [runs[1], "Stale"],
      [runs[2], "Pending"],
    ] as const) {
      const html = render(
        <RunView
          run={run}
          disabled
          refresh={() => {}}
          retry={() => {}}
          retryEvaluation={() => {}}
        />,
      );
      expect(html).toContain(`AI evaluation: ${expected}`);
      expect(html).not.toContain("AI evaluation: Incorrect");
    }
  });
  it("shows each run's captured question once, immediately under its header", () => {
    const run = structuredClone(tableFixtureRuns()[0]);
    (run.snapshot as { question: string }).question = "Первый вопрос\nSecond line";
    const html = render(<RunView run={run} disabled refresh={() => {}} retry={() => {}} retryEvaluation={() => {}} />);
    expect(html.match(/Первый вопрос/g)).toHaveLength(1);
    expect(html.indexOf("Первый вопрос")).toBeGreaterThan(html.indexOf(`Run ${run.id.slice(0, 8)}`));
    expect(html).toContain("Первый вопрос\nSecond line");
    expect(html).toContain("white-space:pre-wrap");
  });
});
