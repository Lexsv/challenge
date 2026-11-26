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
  schedulingState: "Running" | "Paused" | "Stopped";
  updated_at: number;
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
  resolutionIssues?: Array<{code:string; source:string; stage:string; toolId?:string; toolName?:string; required?:boolean; schemaSide?:string; schemaPath?:string; diagnostic?:string}>;
  result: { answer: string; response:string|null } | null;
  response: string | null;
  structured: { source: string; name: string; value: unknown }[];
};
export type HistoryPage = { rows: Occurrence[]; hasMore: boolean };
export async function schedulerApi<T>(path: string, method = "GET", body?: unknown,
  {ifMatch, signal}: {ifMatch?: string; signal?: AbortSignal} = {}): Promise<T> {
  const r = await fetch("/api/scheduler/" + path, {
    method,
    signal,
    headers: {
      "X-Day18-UI": "scheduler",
      ...(ifMatch && { "If-Match": ifMatch }),
      ...(body !== undefined && { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw Error((await r.json().catch(() => null))?.error ?? "Scheduler request failed.");
  return r.json();
}
export type LifecycleAction = "start" | "pause" | "resume" | "stop";
type LifecycleReply = Pick<Task, "id" | "status" | "schedulingState" | "enabled" | "stopped" | "next_due_at" | "revision" | "updated_at"> &
  {executionActive?: boolean};

export async function changeScheduling(task: Pick<Task, "id" | "revision" | "updated_at">, action: LifecycleAction): Promise<LifecycleReply> {
  const state = action === "pause" ? "Paused" : action === "stop" ? "Stopped" : "Running";
  const timeout = AbortSignal.timeout(10_000);
  let confirmed: LifecycleReply;
  try {
    confirmed = await schedulerApi<LifecycleReply>("tasks/" + task.id + "/" + action, "POST", undefined, {
      ifMatch: `"${task.revision}-${task.updated_at}"`, signal: timeout,
    });
  } catch (error) {
    if (!timeout.aborted) throw error;
    // A missing reply may follow a committed command. Read back the durable
    // intention without repeating the POST or inferring success from a tool run.
    const rows = await schedulerApi<Task[]>("tasks", "GET", undefined, {signal: AbortSignal.timeout(5000)});
    const latest = rows.find(row => row.id === task.id);
    if (!latest || latest.revision !== task.revision || latest.updated_at <= task.updated_at)
      throw Error("The Scheduler did not confirm the change in time.");
    confirmed = {...latest, executionActive: Boolean(latest.metrics.active)};
  }
  if (state === "Running" && confirmed.status === "Requires review")
    throw Error("Review the uncertain execution before enabling scheduling.");
  if (confirmed.id !== task.id || confirmed.schedulingState !== state)
    throw Error("The Scheduler did not confirm the requested state.");
  return confirmed;
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
