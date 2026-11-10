import type { TDocumentDefinitions } from "pdfmake/interfaces";
import type { ComparisonRow } from "./comparison-report";
import { captureExecutionParameters } from "./execution-parameters";
import { parseParameterValue } from "./api-parameters";
import { last, type Run } from "./models";
import { formatCost } from "./request-cost";
import { seconds } from "./result-format";
import { comparisonGroupKey } from "./comparison-group";
import { insufficientRecommendation } from "./comparison-recommendation";

type Details = { experts: string[]; parameters: string[] };
export type ComparisonDetails = Map<string, Details>;
export const comparisonHeaders = ["Expert", "Model", "Correct / Questions", "Average response time", "Input / Output tokens", "Total Cost (USD)"];

/** Supplemental display data uses the same participant and model identity as compareRuns. */
export function comparisonDetails(runs: readonly Run[]): ComparisonDetails {
  const details: ComparisonDetails = new Map();
  for (const run of runs) for (const result of run.results) {
    const attempt = last(result.attempts);
    const expert = run.snapshot.experts.find((item) => item.id === result.expert.id);
    const key = comparisonGroupKey(run, result, attempt, expert);
    const entry = details.get(key) ?? { experts: [], parameters: [] };
    const name = expert?.name || "Not available";
    if (!entry.experts.includes(name)) entry.experts.push(name);
    const raw: Record<string, unknown> = {};
    for (const row of expert?.parameters ?? []) {
      if (!row.enabled || !row.key.trim()) continue;
      try { raw[row.key] = parseParameterValue(row.value); } catch { raw[row.key] = "[invalid value]"; }
    }
    const safe = captureExecutionParameters(raw, "");
    const value = Object.entries(safe).map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`).join(", ").replace(/(?:oc_sk_|sk-|ghp_|opencode-)[a-zA-Z0-9_-]{8,}|bearer\s+\S+/gi, "[redacted]") || "None recorded";
    const label = value;
    if (!entry.parameters.includes(label)) entry.parameters.push(label);
    details.set(key, entry);
  }
  return details;
}

export function comparisonCells(row: ComparisonRow, details: ComparisonDetails): string[] {
  const item = details.get(row.key);
  const metric = (m: { sum: number; known: number; missing: number }) => m.known ? `${m.sum.toLocaleString("en-US")}${m.missing ? ` (partial; ${m.missing} missing)` : ""}` : "Not available";
  const known = row.reportedCost.known + row.estimatedCost.known;
  const parameters = item?.parameters.filter((value) => value !== "None recorded").join("\n");
  const indicators = [row.estimatedCost.known ? "estimated" : "", row.missingCost ? "partial" : ""].filter(Boolean);
  const cost = known ? `${formatCost(row.reportedCost.sum + row.estimatedCost.sum)}${indicators.length ? ` (${indicators.join("; ")})` : ""}` : "Not available";
  return [item?.experts.join("\n") || "Not available", `${row.model}${parameters ? `\n${parameters}` : ""}`, `${row.correct} / ${row.assigned}`, row.successful ? seconds(row.duration / row.successful) : "—", `${metric(row.input)} / ${metric(row.output)}`, cost];
}

// Allow long unbroken model identifiers and JSON values to wrap instead of clipping.
const wrapLong = (value: string, modelCell = false) => value
  .replace(modelCell ? /(?:oc_sk_|sk-|ghp_)[a-zA-Z0-9_-]{8,}|bearer\s+\S+/gi : /(?:oc_sk_|sk-|ghp_|opencode-)[a-zA-Z0-9_-]{8,}|bearer\s+\S+/gi, "[redacted]")
  .replace(/(\S{24})(?=\S)/gu, "$1\n");
export function comparisonDocument(rows: readonly ComparisonRow[], details: ComparisonDetails, count: number, date = new Date(), recommendation = insufficientRecommendation): TDocumentDefinitions {
  const body = [comparisonHeaders.map((text) => ({ text, bold: true, fillColor: "#fff3c4", alignment: "center" as const })), ...rows.map((row) => comparisonCells(row, details).map((text, index) => ({ text: wrapLong(text, index === 1), alignment: "center" as const })))];
  return {
    pageSize: "A4", pageOrientation: "landscape", pageMargins: [24, 30, 24, 30],
    defaultStyle: { font: "Roboto", fontSize: 7 },
    content: [
      { text: "Comparison Report", fontSize: 17, bold: true, margin: [0, 0, 0, 8] },
      { text: `Generated: ${date.toLocaleString("en-GB")}  |  Total experiments: ${count}`, margin: [0, 0, 0, 6] },
      { text: recommendation, margin: [0, 0, 0, 9] },
      ...(rows.length ? [{ table: { headerRows: 1, widths: [90, 165, 80, 80, 110, 115], body }, layout: "lightHorizontalLines" as const }] : [{ text: "No participant results are available in this session." }]),
    ],
  };
}

export async function exportComparisonPdf(rows: readonly ComparisonRow[], details: ComparisonDetails, count: number, recommendation: string): Promise<void> {
  const [pdfModule, fontsModule] = await Promise.all([import("pdfmake/build/pdfmake"), import("pdfmake/build/vfs_fonts")]);
  const pdf = pdfModule.default;
  pdf.addVirtualFileSystem(fontsModule.default);
  pdf.createPdf(comparisonDocument(rows, details, count, new Date(), recommendation)).download("expert-comparison-report.pdf");
}
