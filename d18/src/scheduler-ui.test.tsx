import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ToolData, SchedulerReports, reportDatasets, seriesFields, jsonReport } from "./scheduler-results";
import { cadence, type Occurrence } from "./scheduler-api";
import { LifecycleButtons, RunHistory, TaskStatus } from "./scheduler-workspace";

function run(response: string, structured: Occurrence["structured"] = []): Occurrence {
  return {
    id: "run",
    due_at: 1,
    started_at: 1,
    finished_at: 2,
    state: "Completed",
    result: { answer: "delivered", response },
    error: null,
    response,
    structured,
  };
}
describe("Scheduler results", () => {
  it("charts numeric persisted fields against explicit timestamps and keeps sources separate", () => {
    const rows = [
      run(
        "A memo with 9.6 units at 20:00.",
        ["a", "b"].map((source) => ({
          source,
          name: "sample",
          value: {
            samples: [
              { at: "2026-11-25T12:00:00Z", reading: 0, humidity: null },
              { at: "2026-11-25T12:01:00Z", reading: null, humidity: 65 },
            ],
          },
        })),
      ),
    ];
    const data = reportDatasets(rows);
    expect(data).toHaveLength(2);
    expect(data[0].id).not.toBe(data[1].id);
    expect(seriesFields(data[0].rows)).toEqual({ times: ["at"], metrics: ["reading", "humidity"] });
    const html = renderToStaticMarkup(<ToolData rows={rows} />);
    expect(html).toContain("reading over at");
    expect(html).toContain("Persisted structured data");
    expect(html).not.toContain("No measurements");
  });
  it("renders Markdown and complete JSON documents, without extracting numbers from prose", () => {
    expect(jsonReport('The result is [{"speed":8}]')).toBeUndefined();
    expect(reportDatasets([run("Wind 12 at 2026-01-01T00:00:00Z")])).toEqual([]);
    expect(seriesFields([{ time: "yesterday", value: "2.5" }])).toEqual({ times: [], metrics: [] });
    const html = renderToStaticMarkup(
      <SchedulerReports
        rows={[run(JSON.stringify({ version: 1, format: "markdown", content: "**Stored report**" }))]}
      />,
    );
    expect(html).toContain("<strong>Stored report</strong>");
    expect(html).not.toContain("<svg");
    expect(reportDatasets([run('{"results":[{"value":0}]}')])[0].rows).toEqual([{ value: 0 }]);
  });
  it("uses backend status labels and displays millisecond or multi-hour cadence", () => {
    expect(renderToStaticMarkup(<TaskStatus status="RequiresReview" />)).toContain("Requires review");
    expect(cadence({ kind: "interval", startAt: 0, everyMs: 7200000 })).toBe("Every 2 hours");
    expect(cadence({ kind: "interval", startAt: 0, everyMs: 25 })).toBe("Every 25 milliseconds");
  });
});

import { possibleStarts, localStart, intervalParts } from "./schedule-time";
import { taskReport } from "./task-report";
import { ResponseView } from "./scheduler-results";
import { ProviderRegistry } from "./provider-registry";
describe("standalone scheduler configuration", () => {
  it("detects nonexistent and repeated wall times and supports fractional offsets", () => {
    expect(possibleStarts("2026-03-08T02:30", "America/Toronto")).toEqual([]);
    expect(possibleStarts("2026-11-01T01:30", "America/Toronto")).toEqual(
      ["2026-11-01T05:30Z", "2026-11-01T06:30Z"].map(Date.parse),
    );
    const [t] = possibleStarts("2026-07-01T00:05:01.125", "Asia/Kathmandu");
    expect(new Date(t).toISOString()).toBe("2026-06-30T18:20:01.125Z");
    expect(localStart(t, "Asia/Kathmandu")).toBe("2026-07-01T00:05:01.125");
    expect(possibleStarts("2026-02-30T12:00", "UTC")).toEqual([]);
    expect(intervalParts(300000)).toEqual({ unit: "minutes", value: 5 });
    expect(intervalParts(25)).toEqual({ unit: "seconds", value: 0.025 });
  });
  it("renders typed results, leaves missing cells empty and rejects malformed or unsupported charts", () => {
    function render(v: unknown) {
      return renderToStaticMarkup(<ResponseView row={run(JSON.stringify(v))} />);
    }
    expect(render({ version: 1, format: "table", columns: ["n"], rows: [{}, { n: 0 }] })).toContain(
      "Report table",
    );
    expect(
      render({
        version: 1,
        format: "chart",
        x: "time",
        y: "n",
        rows: [{ time: "2026-01-01T12:00Z", n: 0 }],
      }),
    ).toContain("n over time");
    for (const v of [
      { version: 2, format: "json", data: 2 },
      { version: 1, format: "chart", x: "time", y: "n", rows: [{ time: "today", n: 2 }] },
    ])
      expect(taskReport(JSON.stringify(v))).toEqual({ format: "text", content: JSON.stringify(v) });
    expect(taskReport('{"version":1,"format":"json","data":null}')).toEqual({
      format: "json",
      data: null,
    });
    expect(taskReport("**plain**")).toEqual({ format: "text", content: "**plain**" });
  });
  it("enumerates executable adapters and their model catalogs from the supplied registry", () => {
    const registry = new ProviderRegistry();
    registry.register({
      id: "fixture",
      label: "Fixture",
      catalog: () => ["observations"],
      allowUndiscoveredSelection: true,
      capabilities: () => undefined,
      validate: () => undefined,
      execute: async () => {
        throw Error("unused");
      },
    });
    expect(registry.executionOptions()).toEqual([{ id: "fixture", label: "Fixture" }]);
    expect(registry.modelOptionsFor("fixture")).toEqual(["observations"]);
  });
});

it("renders a composite visualization without duplicating history and safely falls back",()=>{
  const spec={version:1,format:"chart",chartType:"bar",x:"service",y:"count",rows:[{service:"<unsafe>",count:0},{service:"South",count:3}]};
  const report={version:1,format:"report",blocks:[{...spec,legend:["East","West"]},{...spec,chartType:"pie"},{format:"table",title:"Counts",columns:["service","count"],rows:spec.rows}]};
  const markup=renderToStaticMarkup(<SchedulerReports rows={[run(JSON.stringify(report))]}/>);
  for(const label of ["bar chart","pie chart","Report table","Counts","East · West","&lt;unsafe&gt;"]) expect(markup).toContain(label);
  for(const label of ["Previous executions","Raw result","Explore structured tool data","Execution journal"]) expect(markup).not.toContain(label);
  for(const blocks of [[],[null],[{format:"report",blocks:[]}]]) expect(taskReport(JSON.stringify({...report,blocks})).format).toBe("text");
  expect(markup).not.toContain("<unsafe>");
  expect(taskReport('{"samples":[1,2]}')).toEqual({format:"json",data:{samples:[1,2]}});
  const trend=renderToStaticMarkup(<ResponseView row={run(JSON.stringify({...spec,chartType:"line",rows:[{service:1,count:2},{service:2,count:4}]}))}/>);
  expect(trend).toContain('aria-label="count over service"');
  for(const invalid of [{...spec,chartType:"script"},{...spec,chartType:"pie",rows:[{service:"East",count:-3}]}])
    expect(taskReport(JSON.stringify(invalid)).format).toBe("text");
  expect(taskReport('```json\n'+JSON.stringify(spec)+'\n```').format).toBe("chart");
});

it("shows tables first in reports and retains the original block order in execution history", () => {
  const rows = [{ category: "A", value: 2 }];
  const chart = { format: "chart", chartType: "bar", x: "category", y: "value", rows };
  const table = { format: "table", columns: ["category", "value"], rows };
  const blocks = [chart, table, chart, table].map((block, index) => ({ ...block, title: "Visual " + index }));
  const row = run(JSON.stringify({ version: 1, format: "report", blocks }));
  const titles = (html: string) => [...html.matchAll(/>Visual (\d)</g)].map((match) => Number(match[1]));
  expect(titles(renderToStaticMarkup(<SchedulerReports rows={[row]} />))).toEqual([1, 3, 0, 2]);
  expect(titles(renderToStaticMarkup(<ResponseView row={row} />))).toEqual([0, 1, 2, 3]);
});

it("formats saved observations in the task timezone while keeping every original history column", () => {
  const observation = {
    timestamp: "2026-07-02T03:15:00Z", latitude: 45, longitude: -73, conditionsCode: 61,
    temperatureC: 0, relativeHumidityPercent: null, windSpeedKmH: 3.4, source: "open-meteo",
  };
  const row = run(JSON.stringify({ version: 1, format: "table", columns: Object.keys(observation), rows: [observation] }));
  const report = renderToStaticMarkup(<SchedulerReports rows={[row]} timezone="America/Toronto" />);
  expect(report.match(/<t[hd]\b[^>]*MuiTableCell-alignCenter/g)).toHaveLength(12);
  for (const label of ["Date", "Local Time", "Temperature (°C)", "Humidity (%)", "Wind (km/h)", "Source", "Jul 1, 2026", "23:15", "Open-Meteo", "0", "—"])
    expect(report).toContain(">" + label + "<");
  const history = renderToStaticMarkup(<ResponseView row={row} />);
  for (const raw of ["latitude", "longitude", "conditionsCode", observation.timestamp, observation.source]) {
    expect(history).toContain(raw);
    expect(report).not.toContain(raw);
  }
});

it("applies generic table presentation and falls back to the original columns for invalid metadata", () => {
  const table = { version: 1, format: "table", columns: ["id", "size"], rows: [{ id: "internal", size: 4.25 }] };
  const render = (presentation: unknown) => renderToStaticMarkup(
    <SchedulerReports rows={[run(JSON.stringify({ ...table, presentation }))]} timezone="UTC" />
  );
  const visible = render([{ key: "id", visible: false }, { key: "size", label: "Length", unit: "mm" }]);
  expect(visible).toContain(">Length (mm)<");
  expect(visible).toContain(">4.25<");
  expect(visible).not.toContain("internal");
  for (const invalid of [[{ key: "missing" }], [{ key: "size", format: "script" }], [{ key: "id", visible: false }]])
    expect(render(invalid)).toContain(">internal<");
});

it.each([
  ["Pending", "Start", true], ["Scheduled", "Pause", false], ["Running", "Pause", false],
  ["Paused", "Continue", false], ["Stopped", "Start", true],
] as const)("renders the confirmed %s lifecycle controls", (status, primary, stopDisabled) => {
  const metrics = { occurrences: 0, total: 0, success: 0, failed: 0, denied: 0, review: 0, active: 0, last: null };
  const html = renderToStaticMarkup(<LifecycleButtons
    task={{ status, stopped: status === "Stopped", review_definition: 0, metrics }}
    busy={false} control={() => {}} />);
  const buttons = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)];
  expect(buttons).toHaveLength(2);
  expect(buttons[0][2]).toMatch(new RegExp(primary + "$"));
  expect(buttons[0][1]).not.toContain("disabled");
  expect(buttons[1][2]).toMatch(/Stop$/);
  expect(buttons[1][1].includes("disabled")).toBe(stopDisabled);
});

describe("Scheduler execution history", () => {
  const task = { id: "fixture", timezone: "America/Toronto", metrics: { active: 0 } };

  it("renders five centered summary columns and keeps the response and diagnostics collapsed", () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({
      ...run("Persisted raw content"), id: "execution-" + i, error: "Fixture diagnostic",
    }));
    const html = renderToStaticMarkup(<RunHistory task={task} rows={rows} />);
    expect(Array.from(html.matchAll(/<th [^>]*class="([^"]*)"[^>]*>([^<]+)<\/th>/g), ([, css, label]) => {
      expect(css).toContain("MuiTableCell-alignCenter");
      return label;
    })).toEqual(["ID", "Started", "Completed", "Duration", "Status"]);
    expect(html.match(/aria-expanded="false"/g)).toHaveLength(25);
    expect(html.match(/>executio<\/button>/g)).toHaveLength(25);
    expect(html).not.toMatch(/execution-0|Persisted raw content|Fixture diagnostic|Report table/);
  });

  it("uses the task's 24-hour local time across midnight and shows missing timestamps as dashes", () => {
    const row = { ...run(""), started_at: Date.parse("2026-06-03T03:59:00Z"),
      finished_at: Date.parse("2026-06-03T04:00:00Z") };
    const html = renderToStaticMarkup(<RunHistory task={task} rows={[row, { ...row, id: "open", finished_at: null }]} />);
    expect(html).toContain(">2026-06-02 23:59:00</time>");
    expect(html).toContain(">2026-06-03 00:00:00</time>");
    expect(html.match(/>—<\/td>/g)).toHaveLength(2);
  });
});

it.each(["20:30:07", "20:30:07 EST", "20:30:07-05:00", "20:30:07 -05:00", "20:30"])(
  "formats already-local observation time %s without shifting its date or measurement", (localTime) => {
    const observation = { date: "2026-11-25", localTime, temperatureC: -2.7, humidityPercent: 78,
      windKmH: 1.9, source: "open-meteo" };
    const row = run(JSON.stringify({ version: 1, format: "table", columns: Object.keys(observation), rows: [observation] }));
    const html = renderToStaticMarkup(<SchedulerReports rows={[row]} timezone="America/Toronto" />);
    for (const value of ["Date", "Local Time", "Temperature (°C)", "Humidity (%)", "Wind (km/h)", "Source",
      "2026-11-25", "20:30", "-2.7", "78", "1.9", "Open-Meteo"])
      expect(html).toContain(">" + value + "<");
  },
);
