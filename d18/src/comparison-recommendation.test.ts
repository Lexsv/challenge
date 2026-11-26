import { describe, expect, it } from "vitest";
import { compareRuns } from "./comparison-report";
import { comparisonDetails, comparisonDocument } from "./comparison-report-pdf";
import { comparisonRecommendation, insufficientRecommendation } from "./comparison-recommendation";
import { tableFixtureRuns } from "./result-table-fixture";

function pairedRuns() {
  return [0, 1].map((index) => {
    const run = structuredClone(tableFixtureRuns()[0]);
    (run.snapshot as { question: string }).question = `Question ${index}`;
    run.id = `run-${index}`;
    run.started += index;
    run.results = run.results.slice(0, 2);
    for (const [i, result] of run.results.entries()) {
      const expert = run.snapshot.experts.find((item) => item.id === result.expert.id)!;
      expert.name = i === 0 ? "Alpha" : "Beta";
      expert.model = "shared-model";
      expert.parameters = [{ id: "effort", enabled: true, key: "reasoning_effort", value: i === 0 ? "high" : "low" }];
      result.attempts = [{ id: `attempt-${i}`, status: "succeeded", text: "answer", actualModel: expert.model, ms: i === 0 ? 2000 : 1000, usage: { input: 100, output: 20 }, cost: { usd: i === 0 ? 0.02 : 0.005, source: "provider", estimated: false } }];
    }
    run.evaluationStatus = "completed";
    run.evaluations[0].judgments = run.results.map((result, i) => ({ resultId: result.id, verdict: i === 1 && index === 1 ? "incorrect" : "correct", explanation: "" }));
    return run;
  });
}
const recommend = (runs: ReturnType<typeof pairedRuns>) => comparisonRecommendation(runs, compareRuns(runs), comparisonDetails(runs));

describe("deterministic comparison recommendations", () => {
  it("identifies best, worst and cost-effectiveness on the same questions without confusing settings", () => {
    const runs = pairedRuns();
    const original = JSON.stringify(runs);
    const text = recommend(runs);
    expect(text).toContain("Alpha (shared-model");
    expect(text).toContain("reasoning_effort: high");
    expect(text).toContain("лучший результат показала");
    expect(text).toContain("2 / 2 правильных ответов");
    expect(text).toContain("Beta (shared-model");
    expect(text).toContain("reasoning_effort: low");
    expect(text).toContain("худший — Beta");
    expect(text).toContain("выгоднее Beta");
    expect(text).toContain("2.0 с и 1.0 с");
    expect(text).toContain("240 и 240 токенов");
    expect(text).toContain("Размеры моделей и типы задач не зафиксированы");
    expect(JSON.stringify(runs)).toBe(original);
  });
  it("does not invent a ranking when common evaluated questions are absent", () => {
    const runs = pairedRuns();
    runs[1].evaluationStatus = "not_evaluated";
    expect(recommend(runs)).toBe(insufficientRecommendation);
    expect(recommend([])).toBe(insufficientRecommendation);
  });
  it("does not claim cost-effectiveness when pricing is missing", () => {
    const runs = pairedRuns();
    delete runs[1].results[1].attempts[0].cost;
    expect(recommend(runs)).toContain("Недостаточно данных о стоимости");
  });
  it("does not reuse an older judgment when the latest answer is unevaluated", () => {
    const runs = pairedRuns();
    const later = structuredClone(runs[1]);
    later.started += 100;
    later.evaluationStatus = "not_evaluated";
    expect(recommend([...runs, later])).toBe(insufficientRecommendation);
  });
  it("counts a failed request without claiming it was a wrong answer", () => {
    const runs = pairedRuns();
    const failure = runs[1].results[1].attempts[0];
    failure.status = "failed";
    failure.actualModel = undefined;
    delete failure.cost;
    const text = recommend(runs);
    expect(text).toContain("(1 / 2)");
    expect(text).toContain("Недостаточно данных о стоимости");
  });
  it("does not rank configurations when all requests failed", () => {
    const runs = pairedRuns();
    for (const run of runs) for (const result of run.results) result.attempts[0].status = "failed";
    expect(recommend(runs)).toBe(insufficientRecommendation);
  });
  it("uses the identical recommendation above the PDF table", () => {
    const runs = pairedRuns(), rows = compareRuns(runs), details = comparisonDetails(runs);
    const text = comparisonRecommendation(runs, rows, details);
    const doc = comparisonDocument(rows, details, runs.length, new Date("2026-01-01"), text);
    const content = doc.content as Array<{ text?: string; table?: unknown }>;
    const header = content.findIndex((item) => item.text === text);
    expect(header).toBeGreaterThanOrEqual(0);
    expect(header).toBeLessThan(content.findIndex((item) => item.table));
    expect(JSON.stringify(doc)).not.toContain("Conclusion — When Is a Small Model Sufficient?");
  });
});
