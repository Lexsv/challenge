import { centeredTable } from "./table-alignment";
import { useState } from "react";
import { Button, Dialog, DialogActions, DialogContent, DialogTitle, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Typography } from "@mui/material";
import { alpha } from "@mui/material/styles";
import { last, type Run } from "./models";
import { requestCost } from "./request-cost";
import { comparisonDetails, comparisonCells, comparisonHeaders, exportComparisonPdf } from "./comparison-report-pdf";
import { comparisonGroupKey } from "./comparison-group";
import { comparisonRecommendation } from "./comparison-recommendation";

type Metric = { sum: number; known: number; missing: number };
export type ComparisonRow = { key: string; provider: string; model: string; assigned: number; correct: number; evaluated: number; duration: number; successful: number; input: Metric; output: Metric; reportedCost: Metric; estimatedCost: Metric; missingCost: number; failures: number };
const metric = (): Metric => ({ sum: 0, known: 0, missing: 0 });
const addMetric = (metric: Metric, value: number | undefined) => {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) { metric.sum += value; metric.known++; }
  else metric.missing++;
};

/** One latest participant attempt per result; no evaluator or earlier retry requests. */
export function compareRuns(runs: readonly Run[]): ComparisonRow[] {
  const rows = new Map<string, ComparisonRow>();
  for (const run of runs) {
    const judgments = run.evaluationStatus === "completed" ? last(run.evaluations)?.judgments : undefined;
    for (const result of run.results) {
      const attempt = last(result.attempts);
      const expert = run.snapshot.experts.find((entry) => entry.id === result.expert.id);
      const provider = expert?.provider || "Not available";
      const model = attempt?.actualModel || expert?.model || "Not available";
      const key = comparisonGroupKey(run, result, attempt, expert);
      let row = rows.get(key);
      if (!row) {
        row = { key, provider, model, assigned: 0, correct: 0, evaluated: 0, duration: 0, successful: 0, input: metric(), output: metric(), reportedCost: metric(), estimatedCost: metric(), missingCost: 0, failures: 0 };
        rows.set(key, row);
      }
      row.assigned++;
      if (attempt?.status === "succeeded") {
        if (Number.isFinite(attempt.ms) && attempt.ms >= 0) { row.duration += attempt.ms; row.successful++; }
        const judgment = judgments?.find((entry) => entry.resultId === result.id);
        if (judgment?.verdict === "correct" || judgment?.verdict === "incorrect") { row.evaluated++; if (judgment.verdict === "correct") row.correct++; }
      }
      if (attempt && ["failed", "timed-out", "incomplete"].includes(attempt.status)) row.failures++;
      addMetric(row.input, attempt?.usage?.input);
      addMetric(row.output, attempt?.usage?.output);
      const cost = requestCost(attempt, expert?.provider);
      if (!cost) row.missingCost++;
      else if (cost.estimated || cost.source === "catalog") addMetric(row.estimatedCost, cost.usd);
      else addMetric(row.reportedCost, cost.usd);
    }
  }
  return Array.from(rows.values());
}
export function ComparisonReport({ runs }: { runs: readonly Run[] }) {
  const [open, setOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState(false);
  const rows = open ? compareRuns(runs) : [];
  const details = open ? comparisonDetails(runs) : new Map();
  const recommendation = open ? comparisonRecommendation(runs, rows, details) : "";
  return <>
    <Button variant="outlined" onClick={() => setOpen(true)} sx={{ mb: 2 }}>Comparison Report</Button>
    <Dialog open={open} onClose={() => setOpen(false)} fullWidth maxWidth="xl" scroll="paper" aria-labelledby="comparison-report-title">
      <DialogTitle id="comparison-report-title">Comparison Report</DialogTitle>
      <DialogContent dividers>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>{recommendation}</Typography>
        {!rows.length ? <Typography>No participant results are available in this session.</Typography> : <TableContainer tabIndex={0} role="region" aria-label="Scrollable comparison report" sx={{ overflowX: "auto" }}>
          <Table size="small" aria-label="Model comparison" sx={{ minWidth: 1050, "& tbody td": { borderBottom: (theme) => `1px solid ${alpha(theme.palette.text.primary, 0.16)}`, overflowWrap: "anywhere" }, "& tbody tr:last-child td": { borderBottom: 0 }, "& th": { fontWeight: 700, color: "primary.dark", bgcolor: (theme) => alpha(theme.palette.primary.main, 0.1) }, ...centeredTable }}>
            <TableHead><TableRow>{comparisonHeaders.map((label) => <TableCell key={label}>{label}</TableCell>)}</TableRow></TableHead>
            <TableBody>{rows.map(row => { const cells = comparisonCells(row, details); return <TableRow key={row.key}>
              {cells.map((cell, index) => <TableCell key={index} sx={{ whiteSpace: "pre-wrap", overflowWrap: index >= 4 ? "normal" : "anywhere", ...(index === 4 ? { minWidth: 200 } : index === 5 ? { minWidth: 125 } : {}) }}>{cell}</TableCell>)}
            </TableRow>})}</TableBody>
          </Table>
        </TableContainer>}
      </DialogContent>
      <DialogActions>
        {exportError && <Typography role="alert" color="error">PDF export failed. Please try again.</Typography>}
        <Button disabled={exporting} onClick={async () => { setExporting(true); setExportError(false); try { await exportComparisonPdf(rows, details, runs.length, recommendation); } catch { setExportError(true); } finally { setExporting(false); } }}>{exporting ? "Preparing PDF…" : "Export PDF"}</Button>
        <Button onClick={() => setOpen(false)}>Close</Button>
      </DialogActions>
    </Dialog>
  </>;
}
