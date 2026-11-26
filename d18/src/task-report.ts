export const reportInstruction =
  'Return plain text by default. For an explicitly requested presentation, return a single JSON object with version:1 and format. For text or markdown use content (string). For json use data (any JSON value). For table use columns (unique string keys) and rows (array of objects with scalar cells). When a chart is requested, return the chart envelope itself as the final answer. Example shape: {"version":1,"format":"chart","chartType":"line","x":"timestamp","y":"measurement","rows":[]}. Populate rows with actual retrieved data. For time series use ISO 8601 timestamps with offsets; other line series can use numeric or category x values. For bar and pie charts x is the category label. For every chart y is a numeric value; pie values must be nonnegative. Use only verified measurements, preserve missing cells as null, and never fabricate data. When multiple visuals are requested, return one {"version":1,"format":"report","blocks":[...]} envelope. Each block is a chart or table as defined above, with its own format, title and rows. For charts include short text xLabel, yLabel, unit and legend. Use UTC for time-axis ticks. In tables, columns are string keys and every row is an object keyed by those columns. Keep different units in separate charts. Sort observations by their actual timestamp and show a single measurement as one point. Use JSON only for explicit JSON requests. Put technical details in the journal. For history queries use the requested period and timezone; when unspecified, use a recent bounded period and label its dates. Never use minimum/maximum representable dates as open bounds. Check both instants after UTC conversion. Follow the declared pagination contract until exhausted for the period, and disclose incomplete coverage if limited. No code fences around a presentation object.';

// Ordered display columns may reference the same stored field (for example, date and time).
export type DisplayColumn = {
  key: string;
  label?: string;
  unit?: string;
  visible?: boolean;
  format?: "date" | "time";
  valueLabels?: Record<string, string>;
};

function validPresentation(value: unknown, columns: string[]): value is DisplayColumn[] {
  const shortText = (s: unknown) => typeof s === "string" && s.length > 0 && s.length <= 120;
  return Array.isArray(value) && value.length > 0 && value.length <= 100 &&
    value.every(c => c && columns.includes(c.key) &&
      (c.label === undefined || shortText(c.label)) &&
      (c.unit === undefined || shortText(c.unit)) &&
      (c.visible === undefined || typeof c.visible === "boolean") &&
      (c.format === undefined || c.format === "date" || c.format === "time") &&
      (c.valueLabels === undefined || (c.valueLabels !== null && typeof c.valueLabels === "object" &&
        !Array.isArray(c.valueLabels) && Object.keys(c.valueLabels).length <= 100 &&
        Object.entries(c.valueLabels).every(([key, label]) => shortText(key) && shortText(label))))) &&
    value.some(c => c.visible !== false);
}

type Row = Record<string, string | number | boolean | null>;
type Leaf = (
  | { format: "text" | "markdown"; content: string }
  | { format: "json"; data: unknown }
  | { format: "table"; columns: string[]; rows: Row[]; presentation?: DisplayColumn[] }
  | {
      format: "chart";
      chartType: "line" | "bar" | "pie";
      x: string;
      y: string;
      rows: Row[];
    }
) & {
  title?: string;
  xLabel?: string;
  yLabel?: string;
  unit?: string;
  legend?: string;
};
export type Report = Leaf | { format: "report"; blocks: Leaf[] };
export function taskReport(raw: string): Report {
  const fallback: Report = { format: "text", content: raw };
  if (raw.length > 1000000) return fallback;
  let v;
  try {
    const fence = /^\s*```(?:json)?\s*\n([\s\S]*?)\n```\s*$/i.exec(raw);
    v = JSON.parse(fence?.[1] ?? raw);
  } catch {
    return fallback;
  }
  if (
    v &&
    typeof v === "object" &&
    !Object.hasOwn(v, "version") &&
    !Object.hasOwn(v, "format")
  )
    v = { version: 1, format: "json", data: v };
  if (v?.version !== 1) return fallback;
  if (v.format === "report") {
    if (!Array.isArray(v.blocks) || !v.blocks.length || v.blocks.length > 16)
      return fallback;
    const blocks: Leaf[] = [];
    for (const block of v.blocks) {
      if (block?.format !== "table" && block?.format !== "chart")
        return fallback;
      const parsed = parseLeaf(block);
      if (!parsed) return fallback;
      blocks.push(parsed);
    }
    return { format: "report", blocks };
  }
  return parseLeaf(v) ?? fallback;
}
function parseLeaf(v: Record<string, any>): Leaf | undefined {
  const labels: Partial<
    Record<"title" | "xLabel" | "yLabel" | "unit" | "legend", string>
  > = {};
  for (const key of ["title", "xLabel", "yLabel", "unit", "legend"] as const) {
    if (v[key] === undefined) continue;
    if(key==="legend" && Array.isArray(v[key])) {
      const items=v[key];
      if (!items.length || items.length>16 || !items.every((item:unknown)=>typeof item==="string" && item.length>0 && item.length<=120)) return;
      labels.legend=items.join(" · ");
      continue;
    }
    if (typeof v[key] !== "string" || v[key].length > 200) return;
    labels[key] = v[key];
  }
  if (
    (v.format === "text" || v.format === "markdown") &&
    typeof v.content === "string"
  )
    return { format: v.format, content: v.content };
  if (v.format === "json" && Object.hasOwn(v, "data")) {
    function bounded(value: unknown, depth: number): boolean {
      if (depth > 32) return false;
      if (typeof value === "number") return Number.isFinite(value);
      return (
        value === null ||
        typeof value !== "object" ||
        Object.values(value).every((child) => bounded(child, depth + 1))
      );
    }
    return bounded(v.data, 0) ? { format: "json", data: v.data } : undefined;
  }
  if (
    !Array.isArray(v.rows) ||
    v.rows.length > 10000 ||
    !v.rows.every(
      (r: unknown) =>
        r &&
        typeof r === "object" &&
        !Array.isArray(r) &&
        Object.values(r).every(
          (c) =>
            c === null ||
            typeof c === "string" ||
            typeof c === "boolean" ||
            Number.isFinite(c),
        ),
    )
  )
    return undefined;
  if (
    v.format === "table" &&
    Array.isArray(v.columns) &&
    v.columns.length > 0 &&
    v.columns.length <= 100 &&
    v.columns.every((c: unknown) => typeof c === "string" && c.length > 0) &&
    new Set(v.columns).size === v.columns.length
  )
    return {
      ...labels, format: "table", columns: v.columns, rows: v.rows,
      ...(validPresentation(v.presentation, v.columns) ? { presentation: v.presentation } : {}),
    };
  const chartType = v.chartType === undefined ? "line" : v.chartType;
  const legacyLine = chartType === "line" && v.chartType === undefined;
  function validX(value: unknown) {
    if (legacyLine)
      return (
        typeof value === "string" &&
        /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/i.test(value) &&
        Number.isFinite(Date.parse(value))
      );
    return typeof value === "string"
      ? value.trim().length > 0
      : Number.isFinite(value);
  }
  if (
    v.format === "chart" &&
    ["line", "bar", "pie"].includes(chartType) &&
    typeof v.x === "string" &&
    v.x.length &&
    typeof v.y === "string" &&
    v.y.length &&
    v.x !== v.y &&
    v.rows.length &&
    v.rows.every(
      (r: Row) =>
        Object.hasOwn(r, v.x) &&
        validX(r[v.x]) &&
        typeof r[v.x] === typeof v.rows[0][v.x] &&
        (r[v.y] == null ||
          (Number.isFinite(r[v.y]) &&
            (chartType !== "pie" || Number(r[v.y]) >= 0))),
    ) &&
    v.rows.some(
      (r: Row) =>
        Number.isFinite(r[v.y]) && (chartType !== "pie" || Number(r[v.y]) > 0),
    )
  )
    return {
      ...labels,
      format: "chart",
      chartType,
      x: v.x,
      y: v.y,
      rows: v.rows,
    };
  return undefined;
}
