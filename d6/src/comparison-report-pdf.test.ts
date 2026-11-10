import { describe, expect, it } from "vitest";
import { compareRuns } from "./comparison-report";
import { comparisonCells, comparisonDetails, comparisonDocument, comparisonHeaders } from "./comparison-report-pdf";
import { comparisonRecommendation, insufficientRecommendation } from "./comparison-recommendation";
import { tableFixtureRuns } from "./result-table-fixture";

describe("comparison PDF", () => {
  it("shares displayed metrics, uses captured experts, and excludes credentials and disabled parameters", () => {
    const runs = structuredClone(tableFixtureRuns());
    const expert = runs[0].snapshot.experts[0];
    expert.name = "Эксперт Иван";
    expert.parameters = [
      { id: "1", enabled: true, key: "temperature", value: "0.7" },
      { id: "2", enabled: false, key: "top_p", value: "0.2" },
      { id: "3", enabled: true, key: "api_key", value: "secret-test-value" },
    ];
    const before = JSON.stringify(runs);
    const rows = compareRuns(runs);
    const details = comparisonDetails(runs);
    const cells = comparisonCells(rows[0], details);
    expect(cells[0]).toContain("Эксперт Иван");
    expect(cells[1]).toContain("temperature: 0.7");
    expect(cells[1]).not.toContain("top_p");
    expect(cells[1]).not.toContain("secret-test-value");
    const doc = comparisonDocument(rows, details, runs.length, new Date("2026-01-01T12:00:00Z"));
    const text = JSON.stringify(doc);
    expect(text).toContain("Эксперт Иван");
    expect(text).toContain("Total experiments: 3");
    expect(text).toContain("temperature: 0.7");
    expect(text).not.toContain("secret-test-value");
    expect(text).toContain("headerRows");
    expect(doc.pageOrientation).toBe("landscape");
    expect(comparisonHeaders).toHaveLength(cells.length);
    expect(JSON.stringify(runs)).toBe(before);
  });
  it("supports an empty history and long text wrapping", () => {
    const doc = comparisonDocument([], new Map(), 0, new Date("2026-01-01"));
    expect(JSON.stringify(doc)).toContain("No participant results");
  });
  it("retains partial and estimated cost indicators in the exported cells", () => {
    const runs = structuredClone(tableFixtureRuns());
    const attempt = runs[0].results[0].attempts[0];
    attempt.cost = { usd: 0.000042, source: "catalog", estimated: true };
    const rows = compareRuns(runs);
    const row = rows.find((entry) => entry.model === attempt.actualModel)!;
    const cells = comparisonCells(row, comparisonDetails(runs));
    expect(cells[5]).toContain("$0.000042");
    expect(cells[5]).toContain("estimated");
    expect(cells[5]).toContain("partial");
    expect(JSON.stringify(comparisonDocument(rows, comparisonDetails(runs), runs.length))).toContain("$0.000042");
  });
  it("reports unavailable times and evidence limitations without inventing model sizes", () => {
    const run = structuredClone(tableFixtureRuns()[0]);
    run.results = [run.results[0]];
    run.results[0].attempts[0].status = "failed";
    run.results[0].attempts[0].usage = undefined;
    run.evaluationStatus = "failed";
    const rows = compareRuns([run]);
    const cells = comparisonCells(rows[0], comparisonDetails([run]));
    expect(cells[2]).toBe("0 / 1");
    expect(cells[3]).toBe("—");
    expect(cells[4]).toBe("Not available / Not available");
    expect(cells[5]).toBe("Not available");
    expect(comparisonRecommendation([run], rows, comparisonDetails([run]))).toBe(insufficientRecommendation);
    expect(comparisonRecommendation([], [], new Map())).toBe(insufficientRecommendation);
  });
  it("uses exact headers and shows one amount without a provider or duplicate reported price", () => {
    expect(comparisonHeaders).toEqual(["Expert", "Model", "Correct / Questions", "Average response time", "Input / Output tokens", "Total Cost (USD)"]);
    const run = structuredClone(tableFixtureRuns()[0]);
    run.results = [run.results[0]];
    run.results[0].attempts[0].cost = { usd: 0.000966, source: "provider", estimated: false };
    const rows = compareRuns([run]), details = comparisonDetails([run]);
    const cells = comparisonCells(rows[0], details);
    expect(cells[1]).not.toContain(rows[0].provider);
    expect(cells[5]).toBe("$0.000966");
    const doc = comparisonDocument(rows, details, 1);
    const content = doc.content as Array<{ table?: { body: Array<Array<{ text: string }>> } }>;
    expect(content.find((item) => item.table)?.table?.body[0].map((cell) => cell.text)).toEqual(comparisonHeaders);
  });
  it("preserves model IDs with an opencode prefix in both the modal and PDF", () => {
    const run = structuredClone(tableFixtureRuns()[0]);
    run.results = [run.results[0]];
    run.results[0].attempts[0].actualModel = "opencode-reasoner";
    const rows = compareRuns([run]), details = comparisonDetails([run]);
    expect(comparisonCells(rows[0], details)[1]).toContain("opencode-reasoner");
    expect(JSON.stringify(comparisonDocument(rows, details, 1))).toContain("opencode-reasoner");
  });
});
