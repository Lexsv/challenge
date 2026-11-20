import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ThemeProvider } from "@mui/material";
import { compareRuns, ComparisonReport } from "./comparison-report";
import { tableFixtureRuns } from "./result-table-fixture";
import { theme } from "./theme";

describe("session comparison", () => {
  it("keeps different experts separate even when they use the same model", () => {
    const run = structuredClone(tableFixtureRuns()[0]);
    const first = run.results[0], second = run.results[1];
    first.expert.provider = "openai";
    first.attempts[0].actualModel = "same";
    second.expert.provider = "openai";
    second.attempts[0].actualModel = "same";
    first.attempts.unshift({ id: "older", status: "failed", text: "", ms: 100, usage: { input: 999, output: 999 } });
    const original = JSON.stringify(run);
    const rows = compareRuns([run]).filter((entry) => entry.model === "same" && entry.provider === "openai");
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.correct)).toEqual([1, 0]);
    expect(rows.map((row) => row.evaluated)).toEqual([1, 1]);
    expect(rows.map((row) => row.input.sum)).toEqual([123456789, 0]);
    expect(JSON.stringify(run)).toBe(original);
  });
  it("keeps providers separate for identical models and ignores stale or unevaluated judgments", () => {
    const run = structuredClone(tableFixtureRuns()[0]);
    const first = run.results[0], second = run.results[1];
    first.expert.provider = "openai"; second.expert.provider = "opencode-console";
    first.attempts[0].actualModel = second.attempts[0].actualModel = "same";
    run.evaluationStatus = "stale";
    const rows = compareRuns([run]).filter((row) => row.model === "same");
    expect(rows.map((row) => row.provider).sort()).toEqual(["openai", "opencode-console"]);
    expect(rows.every((row) => row.evaluated === 0)).toBe(true);
  });
  it("keeps reported, estimated, and missing costs separate and marks missing tokens", () => {
    const run = structuredClone(tableFixtureRuns()[0]);
    const run2 = structuredClone(run), run3 = structuredClone(run);
    const first = run.results[0], second = run2.results[0], third = run3.results[0];
    for (const result of [first, second, third]) { result.expert.provider = "opencode-console"; result.attempts[0].actualModel = "kimi-k3"; }
    first.attempts[0].cost = { usd: 0.01, source: "provider", estimated: false };
    second.attempts[0].cost = { usd: 0.02, source: "catalog", estimated: true };
    third.attempts[0].status = "failed"; third.attempts[0].usage = undefined;
    const row = compareRuns([run, run2, run3]).find((entry) => entry.provider === "opencode-console" && entry.model === "kimi-k3")!;
    expect(row.reportedCost.sum).toBe(0.01);
    expect(row.estimatedCost.sum).toBe(0.02);
    expect(row.missingCost).toBe(1);
    expect(row.input.missing).toBe(1);
    expect(row.failures).toBe(1);
  });
  it("splits the same expert and model when captured reasoning effort changes", async () => {
    const { comparisonCells, comparisonDetails, comparisonDocument } = await import("./comparison-report-pdf");
    const low = structuredClone(tableFixtureRuns()[0]);
    const high = structuredClone(low);
    for (const [run, value] of [[low, "low"], [high, "high"]] as const) {
      run.snapshot.experts[0].name = "Expert";
      run.snapshot.experts[0].parameters = [{ id: "p", enabled: true, key: "reasoning_effort", value }];
      run.results[0].attempts[0].actualModel = "same-model";
    }
    const runs = [low, high];
    const rows = compareRuns(runs).filter((row) => row.model === "same-model");
    const details = comparisonDetails(runs);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => comparisonCells(row, details)[1])).toEqual([
      expect.stringContaining("reasoning_effort: low"), expect.stringContaining("reasoning_effort: high"),
    ]);
    const doc = comparisonDocument(rows, details, runs.length);
    const serialized = JSON.stringify(doc);
    const content = doc.content as Array<{ table?: { body: Array<Array<{ text: string }>> } }>;
    const table = content.find((item) => item.table)?.table;
    expect(table?.body.slice(1).map((row) => row.map((cell) => cell.text)))
      .toEqual(rows.map((row) => comparisonCells(row, details)));
    expect(serialized).toContain("reasoning_effort: low");
    expect(serialized).toContain("reasoning_effort: high");
    expect(rows.map((row) => row.input.sum)).toEqual([123456789, 123456789]);
  });
  it("counts assigned questions, failures and unevaluated attempts exactly once", async () => {
    const { comparisonCells, comparisonDetails } = await import("./comparison-report-pdf");
    const base = structuredClone(tableFixtureRuns()[0]);
    const runs = Array.from({ length: 5 }, (_, i) => {
      const run = structuredClone(base);
      run.id = `question-${i}`;
      run.results = [run.results[0]];
      const result = run.results[0];
      result.attempts[0].actualModel = result.expert.model;
      run.evaluationStatus = "completed";
      run.evaluations[0].judgments = [{ resultId: result.id, verdict: "correct", explanation: "" }];
      if (i === 4) { result.attempts[0].status = "failed"; result.attempts[0].actualModel = undefined; run.evaluationStatus = "failed"; }
      if (i === 0) result.attempts.unshift({ id: "earlier", status: "failed", text: "", ms: 9 });
      return run;
    });
    const row = compareRuns(runs)[0];
    expect(row.assigned).toBe(5);
    expect(row.correct).toBe(4);
    expect(comparisonCells(row, comparisonDetails(runs))[2]).toBe("4 / 5");
    runs[4].results[0].attempts[0].status = "succeeded";
    runs[4].evaluationStatus = "completed";
    expect(comparisonCells(compareRuns(runs)[0], comparisonDetails(runs))[2]).toBe("5 / 5");
    runs[4].results[0].attempts[0].status = "failed";
    runs[4].evaluationStatus = "failed";
    runs[1].evaluationStatus = "not_evaluated";
    runs[2].results[0].attempts = [];
    const revised = compareRuns(runs)[0];
    expect(revised.assigned).toBe(5);
    expect(comparisonCells(revised, comparisonDetails(runs))[2]).toBe("2 / 5");
  });
  it("combines the same model across runs without including evaluator usage", () => {
    const run = structuredClone(tableFixtureRuns()[0]);
    const copy = structuredClone(run);
    for (const item of [run, copy]) {
      item.results[0].attempts[0].actualModel = "shared";
      item.evaluations[0].usage = { input: 999999, output: 999999 };
    }
    const row = compareRuns([run, copy]).find((entry) => entry.model === "shared")!;
    expect(row.input.sum).toBe(246913578);
    expect(row.output.sum).toBe(1975308642);
  });
  it("renders a report action even when there are no runs", () => {
    const html = renderToStaticMarkup(<ThemeProvider theme={theme}><ComparisonReport runs={[]} /></ThemeProvider>);
    expect(html).toContain("Comparison Report");
    expect(compareRuns([])).toEqual([]);
  });
});
