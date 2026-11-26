import { observationTablePresentation } from "./observation-table-presentation";
import { taskReport, type DisplayColumn } from "./task-report";
import { useState } from "react";
import {
  Box,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
  useTheme,
} from "@mui/material";
import { AnswerMarkdown } from "./answer-markdown";
import { JsonView } from "./json-view";
import { stamp, type Occurrence } from "./scheduler-api";

type RecordRow = Record<string, unknown>;
type Dataset = { id: string; label: string; rows: RecordRow[] };
function plain(x: unknown): x is RecordRow {
  return !!x && typeof x === "object" && !Array.isArray(x);
}
export function jsonReport(text: string | null) {
  if (!text || !/^\s*[\[{]/.test(text)) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return plain(value) || Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}
export function reportDatasets(
  history: Occurrence[],
  includeAgentResponse = true,
) {
  const groups = new Map<string, Dataset>();
  function visit(
    value: unknown,
    source: string,
    label: string,
    path: string[],
    depth: number,
  ) {
    if (depth > 12) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, source, label, path, depth + 1);
      return;
    }
    if (!plain(value)) return;
    const entries = Object.entries(value);
    const cells = entries.filter(
      ([, v]) =>
        v === null || ["string", "number", "boolean"].includes(typeof v),
    );
    if (cells.length) {
      const id = JSON.stringify([source, path]);
      const group = groups.get(id) ?? {
        id,
        label: [label, ...path].join(" / "),
        rows: [],
      };
      group.rows.push(Object.fromEntries(cells));
      groups.set(id, group);
    }
    for (const [key, item] of entries)
      if (item && typeof item === "object")
        visit(item, source, label, [...path, key], depth + 1);
  }
  for (const row of [...history].reverse()) {
    for (const result of row.structured)
      visit(result.value, result.source, result.name, [], 0);
    if (includeAgentResponse)
      visit(jsonReport(row.response), "assistant", "Agent report", [], 0);
  }
  return [...groups.values()];
}
function instant(value: unknown) {
  return typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}.*(?:Z|[+-]\d\d:\d\d)$/i.test(value)
    ? Date.parse(value)
    : NaN;
}
export function seriesFields(rows: RecordRow[]) {
  const keys = [...new Set(rows.flatMap(Object.keys))];
  return {
    times: keys.filter((k) => rows.some((r) => Number.isFinite(instant(r[k])))),
    metrics: keys.filter((k) =>
      rows.some((r) => typeof r[k] === "number" && Number.isFinite(r[k])),
    ),
  };
}
function Series({
  rows,
  x,
  y,
  generalAxis = false,
  zone="UTC",
}: {
  rows: RecordRow[];
  x: string;
  y: string;
  generalAxis?: boolean;
  zone?:string;
}) {
  const theme = useTheme();
  const timeAxis =
    !generalAxis || rows.every((r) => Number.isFinite(instant(r[x])));
  const samples = rows
    .map((r, i) => ({
      t: timeAxis ? instant(r[x]) : typeof r[x] === "number" ? Number(r[x]) : i,
      label: String(r[x]),
      v: r[y],
    }))
    .filter((p) => Number.isFinite(p.t))
    .sort((a, b) => a.t - b.t);
  const valid = samples.flatMap((p) =>
    typeof p.v === "number" && Number.isFinite(p.v) ? [p.v] : [],
  );
  if (!valid.length)
    return (
      <Typography color="text.secondary">
        No measurements for this series.
      </Typography>
    );
  const t0 = samples[0].t,
    t1 = samples.at(-1)!.t,
    lo = valid.reduce((a, b) => Math.min(a, b)),
    hi = valid.reduce((a, b) => Math.max(a, b));
  const px = (t: number) =>
    t1 === t0 ? 315 : 57 + ((t - t0) / (t1 - t0)) * 530;
  const py = (v: number) =>
    hi === lo ? 90 : 155 - ((v - lo) / (hi - lo)) * 130;
  let line = "",
    move = true;
  for (const p of samples) {
    if (typeof p.v !== "number" || !Number.isFinite(p.v)) {
      move = true;
      continue;
    }
    line += (move ? "M" : "L") + px(p.t) + " " + py(p.v) + " ";
    move = false;
  }
  return (
    <Box component="figure" sx={{ m: 0 }}>
      <svg
        role="img"
        aria-label={y + " over " + x}
        viewBox="0 0 615 192"
        style={{ display: "block", width: "100%", maxHeight: 240 }}
      >
        {(hi === lo ? [hi] : [lo, (hi + lo) / 2, hi]).map((v) => (
          <g key={v}>
            <line
              x1="57"
              x2="588"
              y1={py(v)}
              y2={py(v)}
              stroke={theme.palette.divider}
            />
            <text
              x="49"
              y={py(v) + 4}
              textAnchor="end"
              fontSize="11"
              fill={theme.palette.text.secondary}
            >
              {Number(v.toPrecision(4))}
            </text>
          </g>
        ))}
        <path
          d={line}
          fill="none"
          stroke={theme.palette.primary.main}
          strokeWidth="2.5"
        />
        {samples.map((p, i) =>
          typeof p.v === "number" && Number.isFinite(p.v) ? (
            <circle
              key={i}
              cx={px(p.t)}
              cy={py(p.v)}
              r="3.5"
              fill={theme.palette.primary.main}
            >
              <title>{[timeAxis ? stamp(p.t) : p.label, p.v].join(" · ")}</title>
            </circle>
          ) : null,
        )}
        <text x="57" y="182" fontSize="11" fill={theme.palette.text.secondary}>
          {timeAxis ? stamp(t0, zone) : samples[0].label}
        </text>
        {t0 !== t1 && (
          <text
            x="588"
            y="182"
            textAnchor="end"
            fontSize="11"
            fill={theme.palette.text.secondary}
          >
            {timeAxis ? stamp(t1, zone) : samples.at(-1)!.label}
          </text>
        )}
      </svg>
    </Box>
  );
}
// React renders labels as text. Neither chart configuration nor data is executable.
function CategoryChart({
  report,
}: {
  report: Extract<ReturnType<typeof taskReport>, { format: "chart" }>;
}) {
  const theme = useTheme();
  const points = report.rows.flatMap((row) =>
    typeof row[report.y] === "number"
      ? [{ label: String(row[report.x]), value: Number(row[report.y]) }]
      : [],
  );
  const scale = points.reduce((m, p) => Math.max(m, Math.abs(p.value)), 0) || 1;
  const normalized = points.map((p) => p.value / scale);
  const lo = normalized.reduce((v, n) => Math.min(v, n), 0);
  const hi = normalized.reduce((v, n) => Math.max(v, n), 0);
  const pos = (v: number) => (100 * (v - lo)) / (hi - lo || 1);
  const colors = [
    theme.palette.primary.main,
    theme.palette.success.main,
    theme.palette.warning.main,
    theme.palette.secondary.main,
    theme.palette.info.main,
  ];
  const total = normalized.reduce((sum, n) => sum + n, 0);
  let cumulative = 0;
  return (
    <Box
      component="figure"
      sx={{ m: 0 }}
      aria-label={report.chartType + " chart"}
    >
      {report.chartType === "pie" && (
        <svg
          viewBox="0 0 200 200"
          height="160"
          role="img"
          aria-label={report.y + " by " + report.x}
        >
          {points.map((p, i) => {
            const start = cumulative;
            cumulative += (normalized[i] / total) * 2 * Math.PI;
            const coord = (a: number) =>
              [100 + 92 * Math.sin(a), 100 - 92 * Math.cos(a)].join(" ");
            const label = (
              <title>{[p.label, p.value].join(" · ")}</title>
            );
            return normalized[i] === total ? (
              <circle
                key={i}
                cx="100"
                cy="100"
                r="92"
                fill={colors[i % colors.length]}
              >
                {label}
              </circle>
            ) : (
              <path
                key={i}
                fill={colors[i % colors.length]}
                d={`M100 100 L${coord(start)} A92 92 0 ${cumulative - start > Math.PI ? 1 : 0} 1 ${coord(cumulative)} Z`}
              >
                {label}
              </path>
            );
          })}
        </svg>
      )}
      <Stack spacing={0.5} sx={{ maxHeight: 320, overflowY: "auto" }}>
        {points.map((p, i) => (
          <Stack key={i} direction="row" alignItems="center" gap={1}>
            {report.chartType === "pie" && (
              <Box
                sx={{
                  width: 10,
                  height: 10,
                  flexShrink: 0,
                  bgcolor: colors[i % colors.length],
                }}
              />
            )}
            <Typography
              variant="caption"
              sx={{
                overflowWrap: "anywhere",
                width: report.chartType === "bar" ? "28%" : undefined,
              }}
            >
              {p.label}
            </Typography>
            {report.chartType === "bar" && (
              <Box
                sx={{
                  flex: 1,
                  position: "relative",
                  height: 12,
                  borderLeft: 1,
                  borderColor: "divider",
                }}
              >
                <Box
                  sx={{
                    height: "100%",
                    position: "absolute",
                    bgcolor: "primary.main",
                    left: Math.min(pos(0), pos(normalized[i])) + "%",
                    width: Math.abs(pos(normalized[i]) - pos(0)) + "%",
                  }}
                />
              </Box>
            )}
            <Typography variant="caption">{p.value}</Typography>
          </Stack>
        ))}
      </Stack>
    </Box>
  );
}
function axisZone(label?:string) {
  const zone=label?.match(/\b[A-Z][A-Za-z_]+(?:\/[A-Za-z_+-]+)+\b/)?.[0];
  if(zone) try {return new Intl.DateTimeFormat("en",{timeZone:zone}).resolvedOptions().timeZone;} catch { /* Default to UTC for unrecognized labels. */ }
  return "UTC";
}
function ReportTable({ report, timezone }: {
  report: Extract<ReturnType<typeof taskReport>, { format: "table" }>;
  timezone?: string;
}) {
  const rawColumns: DisplayColumn[] = report.columns.map(key => ({ key }));
  const columns = timezone && report.presentation
    ? report.presentation.filter(c => c.visible !== false)
    : rawColumns;
  const formats = new Map<"date" | "time", Intl.DateTimeFormat>();
  function display(value: string | number | boolean | null | undefined, column: DisplayColumn) {
    if (value == null) return "—";
    if (typeof value !== "string") return String(value);
    if (column.valueLabels && Object.hasOwn(column.valueLabels, value)) return column.valueLabels[value];
    // Some saved reports contain an already-local clock time rather than an instant.
    if (column.format === "time") {
      const clock = /^((?:[01]\d|2[0-3]):[0-5]\d)(?::[0-5]\d(?:\.\d+)?)?(?:\s*(?:[+-]\d{2}:?\d{2}|[A-Z]{1,5}))?$/.exec(value);
      if (clock) return clock[1];
    }
    if (!column.format || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/i.test(value)) return value;
    const instant = Date.parse(value);
    if (!Number.isFinite(instant)) return value;
    let formatter = formats.get(column.format);
    if (!formatter) {
      const options: Intl.DateTimeFormatOptions = column.format === "date"
        ? { month: "short", day: "numeric", year: "numeric" }
        : { hour: "2-digit", minute: "2-digit", hourCycle: "h23" };
      formatter = new Intl.DateTimeFormat("en-CA", { ...options, timeZone: timezone });
      formats.set(column.format, formatter);
    }
    return formatter.format(instant);
  }
  return (
    <TableContainer>
      {report.title && <Typography variant="subtitle2">{report.title}</Typography>}
      <Table size="small" aria-label="Report table" sx={timezone ? {
        "& .MuiTableCell-root": { px: { xs: 0.25, sm: 1 }, py: 0.5, fontSize: { xs: "0.75rem", sm: "0.875rem" }, fontVariantNumeric: "tabular-nums" },
        "& th": { whiteSpace: { xs: "normal", sm: "nowrap" } },
      } : undefined}>
        <TableHead>
          <TableRow>
            {columns.map((column, i) => (
              <TableCell key={i} align={timezone ? "center" : "left"}>
                {column.label ?? column.key}{column.unit && ` (${column.unit})`}
              </TableCell>
            ))}
          </TableRow>
        </TableHead>
        <TableBody>
          {report.rows.map((row, i) => (
            <TableRow key={i}>
              {columns.map((column, j) => (
                <TableCell key={j} align={timezone ? "center" : "left"}>
                  {display(Object.hasOwn(row, column.key) ? row[column.key] : null, column)}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

function ReportView({report, tableTimezone}: {report:ReturnType<typeof taskReport>; tableTimezone?: string}) {
  if (report.format==="report") return <Stack spacing={3}>{report.blocks.map((block,index)=>
    <ReportView key={index} report={block} tableTimezone={tableTimezone}/>)}</Stack>;
  let content;
  switch (report.format) {
    case "markdown":
      content = <AnswerMarkdown text={report.content} />;
      break;
    case "json":
      content = <JsonView value={report.data} />;
      break;
    case "chart":
      content = (
        <>
          <Typography variant="subtitle2">
            {report.title ?? (report.y+" over "+report.x)}
          </Typography>
          <Typography component="div" variant="caption" color="text.secondary">
            {report.yLabel ?? report.y}{report.unit && !report.yLabel?.includes(report.unit) && " ("+report.unit+")"}
          </Typography>
          {report.chartType === "line" ? (
            <Series generalAxis zone={axisZone(report.xLabel)} rows={report.rows} x={report.x} y={report.y} />
          ) : (
            <CategoryChart report={report} />
          )}
          <Stack direction="row" justifyContent="space-between">
            <Typography variant="caption">{report.xLabel ?? report.x}</Typography>
            <Typography variant="caption" color="primary">● {report.legend ?? report.yLabel ?? report.y}</Typography>
          </Stack>
        </>
      );
      break;
    case "table":
      content = <ReportTable report={report} timezone={tableTimezone} />;
      break;
    case "text":
      content = (
        <Typography sx={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
          {report.content}
        </Typography>
      );
  }
  return content;
}
export function ResponseView({row}: {row:Occurrence}) {
  if(row.response===null) return <Typography color="text.secondary">No saved response.</Typography>;
  return (
    <Stack spacing={1.5}>
      <ReportView report={taskReport(row.response)}/>
      <Box component="details">
        <summary>Raw result</summary>
        <Box
          component="pre"
          sx={{
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
            fontSize: 12,
          }}
        >
          {row.response}
        </Box>
      </Box>
    </Stack>
  );
}
export function SchedulerReports({rows, timezone = "UTC"}: {rows:Pick<Occurrence,"response">[]; timezone?: string}) {
  const raw=rows[0]?.response;
  if (!raw) return <Typography color="text.secondary">No result available yet.</Typography>;
  const report=taskReport(raw);
  if (report.format==="text" && report.content===raw && /^\s*(?:[\[{]|```json)/i.test(raw))
    return <Typography color="text.secondary">This response could not be visualized.</Typography>;
  const presentTable = (table: Extract<typeof report, { format: "table" }>) => ({
    ...table, presentation: observationTablePresentation(table.columns) ?? table.presentation,
  });
  if (report.format === "report") {
    const tables = report.blocks.filter((block) => block.format === "table").map(presentTable);
    const charts = report.blocks.filter((block) => block.format === "chart");
    return <ReportView report={{ ...report, blocks: [...tables, ...charts] }} tableTimezone={timezone} />;
  }
  return <ReportView report={report.format === "table" ? presentTable(report) : report} tableTimezone={timezone}/>;
}
export function ToolData({ rows }: { rows: Occurrence[] }) {
  const datasets = reportDatasets(rows, false);
  const [chosen, setChosen] = useState(""),
    [axis, setAxis] = useState(""),
    [metric, setMetric] = useState("");
  const data =
    datasets.find((d) => d.id === chosen) ??
    datasets.find((d) => {
      const f = seriesFields(d.rows);
      return f.times.length && f.metrics.length;
    }) ??
    datasets[0];
  const { times, metrics } = seriesFields(data?.rows ?? []),
    x = times.includes(axis) ? axis : times[0],
    y = metrics.includes(metric) ? metric : metrics[0];
  const cols = [...new Set(data?.rows.flatMap(Object.keys))];
  return (
    <Stack spacing={2}>
      {data && (
        <>
          <Stack direction={{ xs: "column", sm: "row" }} spacing={1}>
            <FormControl size="small" fullWidth>
              <InputLabel id="data-label">Data source</InputLabel>
              <Select
                labelId="data-label"
                label="Data source"
                value={data.id}
                onChange={(e) => setChosen(e.target.value)}
              >
                {datasets.map((d) => (
                  <MenuItem key={d.id} value={d.id}>
                    {d.label}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            {x && y && (
              <>
                <FormControl size="small" fullWidth>
                  <InputLabel id="axis-label">Time field</InputLabel>
                  <Select
                    labelId="axis-label"
                    label="Time field"
                    value={x}
                    onChange={(e) => setAxis(e.target.value)}
                  >
                    {times.map((k) => (
                      <MenuItem key={k} value={k}>
                        {k}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
                <FormControl size="small" fullWidth>
                  <InputLabel id="measure-label">Measurement</InputLabel>
                  <Select
                    labelId="measure-label"
                    label="Measurement"
                    value={y}
                    onChange={(e) => setMetric(e.target.value)}
                  >
                    {metrics.map((k) => (
                      <MenuItem key={k} value={k}>
                        {k}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
              </>
            )}
          </Stack>
          {x && y && <Series rows={data.rows} x={x} y={y} />}
          <TableContainer sx={{ maxHeight: 250 }}>
            <Table
              stickyHeader
              size="small"
              aria-label="Persisted structured data"
            >
              <TableHead>
                <TableRow>
                  {cols.map((k) => (
                    <TableCell key={k}>{k}</TableCell>
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {data.rows.map((r, i) => (
                  <TableRow key={i}>
                    {cols.map((k) => (
                      <TableCell key={k}>
                        {!Object.hasOwn(r, k) || r[k] == null
                          ? "—"
                          : String(r[k])}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </>
      )}
    </Stack>
  );
}
