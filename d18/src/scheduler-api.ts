export type Permission = { connectionId: string; toolId: string };
export type ToolChoice = Permission & {
  server: string;
  name: string;
  eligible: boolean;
  definition: string;
  revision: number;
};
export type Schedule =
  { kind: "once"; at: number } | { kind: "interval"; startAt: number; everyMs: number };
export type Task = {
  review_definition:number;
  reviewIds?:string[];
  tools: { server: string; name: string }[];
  id: string;
  name: string;

  provider: string;
  model: string;
  instructions: string;
  timezone: string;
  schedule: Schedule;
  permissions: Permission[];
  enabled: boolean;
  stopped: boolean;
  revision: number;
  next_due_at: number | null;
  status: string;
  metrics: {
    total: number;
    occurrences: number;
    success: number;
    failed: number;
    denied: number;
    active: number;
    review: number;
    last: number | null;
  };
};
export type Occurrence = {
  id: string;
  due_at: number;
  started_at: number | null;
  finished_at: number | null;
  state: string;
  error: string | null;
  resolutionIssues?: Array<{code:string; source:string; stage:string; toolId?:string; schemaSide?:string; diagnostic?:string}>;
  result: { answer: string; response:string|null } | null;
  response: string | null;
  structured: { source: string; name: string; value: unknown }[];
};
export type HistoryPage = { rows: Occurrence[]; hasMore: boolean };
export async function schedulerApi<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const r = await fetch("/api/scheduler/" + path, {
    method,
    headers: {
      "X-Day18-UI": "scheduler",
      ...(body !== undefined && { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw Error((await r.json().catch(() => null))?.error ?? "Scheduler request failed.");
  return r.json();
}
export function stamp(ms: number | null, zone?: string) {
  return ms === null
    ? "—"
    : new Date(ms).toLocaleString("en-CA", {
        timeZone: zone,
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        timeZoneName: "short",
      });
}
export function cadence(s: Schedule) {
  if (s.kind === "once") return "One time";
  for (const [unit, ms] of [
    ["day", 86400000],
    ["hour", 3600000],
    ["minute", 60000],
    ["second", 1000],
    ["millisecond", 1],
  ] as const) {
    if (s.everyMs % ms === 0) {
      const n = s.everyMs / ms;
      return "Every " + (n === 1 ? unit : n + " " + unit + "s");
    }
  }
  return "Recurring interval";
}
