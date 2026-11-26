import { useEffect, useState } from "react";
import { JsonView } from "./json-view";
import { callTransitions } from "./execution-policy";
import Check from "@mui/icons-material/Check";
import Close from "@mui/icons-material/Close";
import ChevronRight from "@mui/icons-material/ChevronRight";
import ExpandMore from "@mui/icons-material/ExpandMore";
import {
  Accordion,
  AccordionSummary,
  AccordionDetails,
  Alert,
  Box,
  Button,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  MenuItem,
  Stack,
  Select,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from "@mui/material";

export type JournalRow = {
  id: string;
  runId: string;
  runState: string;
  llmCallId: string | null;
  toolId: string;
  connectionId: string | null;
  type: string;
  name: string;
  server: string | null;
  status: string;
  hasWarning?: boolean;
  created: number;
  ended: number | null;
  attempts: number;
  spans: [number, number | null][];
  duration: number;
};
type Attempt = {
  id: string;
  ordinal: number;
  started: number;
  ended: number | null;
  state: string;
  error: unknown;
  request?: string;
  response?: string;
  returned?: string;
};
type Detail = {
  arguments: string | null;
  result: string | null;
  error: unknown;
  attempts: Attempt[];
  proposedArguments?: string;
  proposedFields?: string[];
  authorization?: string;
  validation?: string;
  dependencies: string[];
  restricted: boolean;
};
function useJournalRead<T>(url: string | null, revision: string, poll = false) {
  const [result, set] = useState<{ key: string; data?: T; error?: boolean }>();
  const key = url + "|" + revision;
  useEffect(() => {
    if (!url) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const response = await fetch(url!, {
          signal: abort.signal,
          cache: "no-store",
          ...(url?.startsWith("/api/scheduler/") && {headers:{"X-Day18-UI":"scheduler"}}),
        });
        if (!response.ok) throw Error();
        const data = (await response.json()) as T;
        if (!abort.signal.aborted) set({ key, data });
      } catch {
        if (!abort.signal.aborted) set({ key, error: true });
      } finally {
        if (poll && !abort.signal.aborted) timer = setTimeout(load, 1500);
      }
    }
    void load();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [url, key, poll]);
  return result?.key === key ? result : undefined;
}
export const journalUrl = (session: string) =>
  "/api/week4/sessions/" + encodeURIComponent(session) + "/execution-journal";
export function useSessionToolJournal(
  session: string,
  active: boolean,
  revision: string,
  running: boolean,
  baseUrl?:string,
) {
  return useJournalRead<JournalRow[]>(
    active ? baseUrl ?? journalUrl(session) : null,
    revision,
    running,
  );
}
const typeNames: Record<string, string> = {
  MCP: "MCP",
  http: "API",
  agent: "AI Agent",
  function: "Function",
  unknown: "Unknown",
  unavailable: "Unavailable",
};
export function journalStatus(row: JournalRow) {
  return row.status === "Success" && row.hasWarning ? "Success with warning" : row.status;
}
export function compactToolLabel(r: JournalRow) {
  return [typeNames[r.type] ?? r.type, r.server, r.name, journalStatus(r)]
    .filter(Boolean)
    .join(" | ");
}
export function toolUsage(rows: JournalRow[]) {
  const groups = new Map<
    string,
    {
      row: JournalRow;
      calls: number;
      success: number;
      warnings: number;
      failed: number;
      other: Record<string, number>;
      retries: number;
      duration: number;
    }
  >();
  for (const r of rows) {
    const key = JSON.stringify([r.connectionId, r.toolId]);
    const g = groups.get(key) ?? {
      row: r,
      calls: 0,
      success: 0,
      warnings: 0,
      failed: 0,
      other: {} as Record<string, number>,
      retries: 0,
      duration: 0,
    };
    g.calls++;
    g.success += Number(r.status === "Success");
    g.warnings += Number(journalStatus(r) === "Success with warning");
    g.failed += Number(r.status === "Failed");
    if (r.status !== "Success" && r.status !== "Failed")
      g.other[r.status] = (g.other[r.status] ?? 0) + 1;
    g.retries += Math.max(0, r.attempts - 1);
    g.duration += r.duration;
    groups.set(key, g);
  }
  return [...groups.values()].sort(
    (a, b) =>
      (a.row.server ?? "").localeCompare(b.row.server ?? "") ||
      a.row.name.localeCompare(b.row.name),
  );
}
const count = (n: number, label: string) =>
  n + " " + label + (n === 1 ? "" : "s");
function Timestamp({ value }: { value: number }) {
  const iso = new Date(value).toISOString();
  return (
    <time dateTime={iso} title={iso}>
      {iso.slice(0, 19).replace("T", " ")}
    </time>
  );
}
const duration = (ms: number) =>
  ms < 1000 ? ms + " ms" : Number((ms / 1000).toFixed(2)) + " s";
const entryName = (r: JournalRow) =>
  [
    r.server || typeNames[r.type] || r.type,
    r.name && r.name !== r.toolId ? r.name : "Tool",
  ].join(" | ");
const statusName = (s: string) =>
  s === ""
    ? "All"
    : s.replace(/([a-z])([A-Z])/g, "$1 $2");

const statusOrder = [
  ...new Set(["Success", "Success with warning", "Skipped", "Failed", "Unknown", ...Object.keys(callTransitions)]),
];

export function journalView(
  rows: JournalRow[],
  server: string,
  status: string,
) {
  const scoped = rows.filter(
    (row) => !server || (row.type === "MCP" && row.connectionId === server),
  );
  const present = new Set(scoped.map(journalStatus));
  const statuses = [
    "",
    ...statusOrder.filter((value) => present.has(value)),
    ...[...present]
      .filter((value) => value && !statusOrder.includes(value))
      .sort(),
  ];
  const selected = statuses.includes(status) ? status : "";
  const entries = scoped
    .filter((row) => !selected || journalStatus(row) === selected)
    .reverse()
    .sort((a, b) => b.created - a.created);
  return { statuses, selected, entries };
}
export function journalStatusStyle(status: string) {
  switch (status) {
    case "":
    case "Running":
      return { color: "primary.dark", bgcolor: "primary.light" };
    case "Success":
      return { color: "success.main", bgcolor: "success.light" };
    case "Failed":
      return { color: "error.main", bgcolor: "error.light" };
    case "Pending":
    case "WaitingForRetry":
      return { color: "warning.main", bgcolor: "warning.light" };
    case "Success with warning":
      return { color: "#695000", bgcolor: "#fff1b8" };
    case "Skipped":
      return { color: "#464b60", bgcolor: "#e8eaf0" };
    case "Unknown":
      return { color: "#8a3800", bgcolor: "#ffe3cc" };
    default:
      return { color: "secondary.dark", bgcolor: "secondary.light" };
  }
}
function segmentStyle(status: string) {
  const colors = journalStatusStyle(status);
  return {
    color: colors.color,
    "&.Mui-selected, &.Mui-selected:hover": colors,
  };
}
const correlationFields = new Set([
  "runid",
  "toolid",
  "callid",
  "toolcallid",
  "llmcallid",
  "mcptoolid",
  "connectionid",
  "mcpconnectionid",
  "attemptid",
  "sessionid",
  "requestid",
  "operationid",
  "parentllmid",
]);
function presentValue(value: unknown): unknown {
  if (typeof value === "string" && /^[\s]*[\[{]/.test(value)) {
    // Text blocks sometimes contain serialized JSON with their own correlation fields.
    const parsed = decoded(value);
    if (typeof parsed !== "string") {
      const visible = JSON.stringify(presentValue(parsed));
      return visible === JSON.stringify(parsed) ? value : visible;
    }
  }
  if (Array.isArray(value)) return value.map(presentValue);
  if (!value || typeof value !== "object") return value;
  const object = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(object)
      .filter(
        ([k]) =>
          !correlationFields.has(k.replaceAll("_", "").toLowerCase()) &&
          !(k === "id" && object.jsonrpc === "2.0"),
      )
      .map(([k, v]) => [k, presentValue(v)]),
  );
}
function decoded(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
function Payload({ name, value }: { name: string; value: unknown }) {
  return (
    <Box sx={{ minWidth: 0 }}>
      <Typography variant="subtitle2" sx={{ mb: 0.25 }}>
        {name}
      </Typography>
      {value === undefined ? (
        <Typography variant="caption" color="text.secondary">
          Not captured
        </Typography>
      ) : typeof value === "string" ? (
        <Box
          component="pre"
          sx={{
            m: 0,
            p: 1.5,
            bgcolor: "secondary.light",
            borderRadius: 1,
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
          }}
        >
          {value}
        </Box>
      ) : (
        <JsonView journal value={presentValue(value)} />
      )}
    </Box>
  );
}
function Decision({ label, value }: { label: string; value: string }) {
  const positive = [
    "passed",
    "approved",
    "approved once",
    "attached capability",
    "session-approved read",
    "session grant",
    "connection auto-approve",
    "internal registration",
  ].includes(value);
  return (
    <Stack direction="row" spacing={1} alignItems="center">
      {positive ? (
        <Check fontSize="small" sx={{ color: "success.main" }} />
      ) : ["failed", "denied"].includes(value) ? (
        <Close fontSize="small" sx={{ color: "error.main" }} />
      ) : null}
      <span>
        {label} · {value}
      </span>
    </Stack>
  );
}
export function ExecutionDetails({
  baseUrl,  row,
  session,
  revision,
  peers,
}: {
  baseUrl?:string;
  row: JournalRow;
  session: string;
  revision: string;
  peers: JournalRow[];
}) {
  const response = useJournalRead<Detail>(
    (baseUrl ?? journalUrl(session)) + "/" + row.id,
    revision + row.status + row.attempts,
  );
  if (!response?.data)
    return (
      <Typography role="status">
        {response?.error
          ? "Execution details unavailable."
          : "Loading details…"}
      </Typography>
    );
  return <JournalDetails detail={response.data} row={row} peers={peers} />;
}
export function JournalDetails({
  detail: d,
  row,
  peers,
}: {
  detail: Detail;
  row: JournalRow;
  peers: JournalRow[];
}) {
  const record = d.result == null ? undefined : decoded(d.result);
  // Prefer the server's structured result. Retain other captured blocks in attempt details.
  const isEnvelope = row.type === "MCP" && Array.isArray(record?.content);
  const primary = isEnvelope
    ? (record.structuredContent ??
      (record.content.length === 1 &&
      typeof record.content[0]?.text === "string"
        ? decoded(record.content[0].text)
        : record))
    : record;
  const overlapping = peers.filter(
    (peer) =>
      peer.id !== row.id &&
      peer.spans.some(([a, b]) =>
        row.spans.some(
          ([c, d]) => Math.max(a, c) < Math.min(b ?? Infinity, d ?? Infinity),
        ),
      ),
  );
  return (
    <Stack spacing={1} sx={{ overflowWrap: "anywhere", typography: "body2" }}>
      {d.authorization && (
        <Decision label="Authorization" value={d.authorization} />
      )}
      {d.validation && (
        <Decision label="Argument validation" value={d.validation} />
      )}
      {d.restricted ? (
        <Alert severity="info">
          Session rules restrict payload inspection.
        </Alert>
      ) : (
        <>
          {d.proposedArguments && (
            <Payload
              name="Proposed arguments (not sent)"
              value={decoded(d.proposedArguments)}
            />
          )}
          {!d.proposedArguments && d.proposedFields && (
            <Typography variant="body2">
              Proposed fields · {d.proposedFields.join(", ") || "None"}. Values
              withheld before dispatch.
            </Typography>
          )}
          <Payload
            name="Arguments"
            value={d.arguments == null ? undefined : decoded(d.arguments)}
          />
          <Payload name="Result" value={primary} />
        </>
      )}
      {row.hasWarning && <Alert severity="warning">The tool completed with a response-format warning.</Alert>}
      {d.error != null && <Payload name={row.status === "Skipped" ? "Skip reason" : "Execution error"} value={d.error} />}
      {row.runState && row.runState !== "Completed" && (
        <Typography variant="body2">
          Run outcome · {statusName(row.runState)}
        </Typography>
      )}
      {d.dependencies.length > 0 && (
        <Typography variant="body2">
          Prerequisites ·{" "}
          {d.dependencies
            .map((id) => {
              const peer = peers.find((r) => r.id === id);
              return peer ? entryName(peer) : "Earlier call";
            })
            .join(", ")}
        </Typography>
      )}
      {overlapping.length > 0 && (
        <Typography variant="body2">
          Overlapping attempts · {overlapping.map(entryName).join(", ")}
        </Typography>
      )}
      {(d.attempts.length > 0 || primary !== record) && (
        <Box
          component="details"
          sx={{
            typography: "body2",
            color: "text.secondary",
            "& summary": { cursor: "pointer", width: "fit-content" },
          }}
        >
          <summary>Attempt details</summary>
          <Stack spacing={1.25} sx={{ mt: 1 }}>
            {d.attempts.map((a) => (
              <Stack key={a.id} spacing={0.75}>
                <Typography variant="subtitle2">
                  Attempt {a.ordinal} · {statusName(a.state === "Success" ? journalStatus(row) : a.state)}
                </Typography>
                <Typography variant="caption">
                  <Timestamp value={a.started} /> →{" "}
                  {a.ended === null ? (
                    "In progress"
                  ) : (
                    <Timestamp value={a.ended} />
                  )}
                </Typography>
                {!d.restricted && (
                  <>
                    {a.request && (
                      <Payload name="Request" value={decoded(a.request)} />
                    )}
                    {a.response && (
                      <Payload name="Response" value={decoded(a.response)} />
                    )}
                    {a.returned && (
                      <Payload
                        name="Tool return value"
                        value={decoded(a.returned)}
                      />
                    )}
                  </>
                )}
                {a.error != null && (
                  <Payload name="Attempt error" value={a.error} />
                )}
              </Stack>
            ))}
            {!d.restricted && primary !== record && (
              <Payload name="Complete result" value={record} />
            )}
          </Stack>
        </Box>
      )}
    </Stack>
  );
}

export function SessionTools({
  rows,
  error,
  session,
  revision,
}: {
  rows?: JournalRow[];
  error?: boolean;
  session: string;
  revision: string;
}) {
  const [open, setOpen] = useState(false),
    [expanded, setExpanded] = useState("");
  const [server, setServer] = useState("");
  const [status, setStatus] = useState("");
  const groups = toolUsage(rows ?? []);
  const services = new Map(
    rows
      ?.filter((r) => r.type === "MCP" && r.connectionId && r.server)
      .map((r) => [r.connectionId!, r.server!]),
  );
  const selectedServer = services.has(server) ? server : "";
  const {
    statuses,
    selected,
    entries: visible,
  } = journalView(rows ?? [], selectedServer, status);
  useEffect(() => {
    if (!rows) return;
    if (server !== selectedServer) setServer(selectedServer);
    if (status !== selected) setStatus(selected);
  }, [rows, server, selectedServer, status, selected]);
  return (
    <>
      <Accordion
        disableGutters
        elevation={0}
        sx={{ borderTop: 1, borderColor: "divider" }}
      >
        <AccordionSummary expandIcon={<ExpandMore />} sx={{ px: 0 }}>
          <Typography variant="subtitle2" sx={{ flexGrow: 1 }}>
            Tools
          </Typography>
          <Typography variant="caption">
            {rows
              ? count(rows.length, "call")
              : error
                ? "Unavailable"
                : "Loading…"}
          </Typography>
        </AccordionSummary>
        <AccordionDetails sx={{ px: 0 }}>
          {error && (
            <Alert severity="error">Tool statistics could not be loaded.</Alert>
          )}
          {groups.map(
            ({ row, calls, success, warnings, failed, other, retries, duration }) => (
              <Box key={row.toolId} sx={{ mb: 1 }}>
                <Typography variant="subtitle2">
                  {[row.server, row.name].filter(Boolean).join(" · ")}{" "}
                  <Typography component="span" variant="caption">
                    {typeNames[row.type]}
                  </Typography>
                </Typography>
                <Typography variant="caption">
                  {count(calls, "call")} · {success} successful{warnings > 0 && ` (${warnings} with warning)`} · {failed}{" "}
                  failed
                  {Object.entries(other).map(
                    ([status, n]) => " · " + n + " " + status.toLowerCase(),
                  )}{" "}
                  · {retries} retries · {duration} ms
                </Typography>
              </Box>
            ),
          )}
          <Button size="small" disabled={!rows} onClick={() => setOpen(true)}>
            Open Execution Journal
          </Button>
        </AccordionDetails>
      </Accordion>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        fullWidth
        maxWidth={false}
        slotProps={{
          paper: {
            sx: {
              width: "96vw",
              maxWidth: 1472,
              m: 1,
              height: "96dvh",
              maxHeight: "96dvh",
              borderRadius: 2,
            },
          },
        }}
        aria-labelledby="execution-journal-title"
      >
        <DialogTitle id="execution-journal-title">
          Tool Execution Journal
        </DialogTitle>
        <DialogContent>
          <Stack
            direction="row"
            alignItems="center"
            justifyContent="space-between"
            spacing={{ xs: 1, sm: 2 }}
            sx={{ mb: 2, minWidth: 0 }}
          >
            <Stack
              direction="row"
              alignItems="center"
              spacing={1.25}
              sx={{ flexShrink: 0 }}
            >
              <Typography
                id="journal-service-label"
                variant="body2"
                sx={{ whiteSpace: "nowrap" }}
              >
                MCP Service
              </Typography>
              <Select
                size="small"
                displayEmpty
                labelId="journal-service-label"
                value={selectedServer}
                onChange={(e) => setServer(e.target.value)}
                sx={{
                  width: { xs: 82, sm: 130, lg: "clamp(190px,21vw,350px)" },
                  typography: "body2",
                  "& fieldset": { borderColor: "divider" },
                  bgcolor: "background.paper",
                }}
              >
                <MenuItem value="">All</MenuItem>
                {[...services].map(([id, name]) => (
                  <MenuItem key={id} value={id}>
                    {name}
                  </MenuItem>
                ))}
              </Select>
            </Stack>
            <Box sx={{ minWidth: 0, overflowX: "auto", py: 0.25 }}>
              <ToggleButtonGroup
                exclusive
                aria-label="Execution status"
                size="small"
                value={selected}
                onChange={(_, v: string | null) => {
                  if (v !== null) setStatus(v);
                }}
                sx={{
                  p: 0.4,
                  border: 1,
                  borderRadius: 2,
                  borderColor: "divider",
                  bgcolor: "background.default",
                  "& .MuiToggleButtonGroup-grouped": {
                    border: 0,
                    borderRadius: "8px !important",
                    m: 0,
                    whiteSpace: "nowrap",
                    px: { xs: 1, lg: 1.6 },
                    py: 0.5,
                  },
                }}
              >
                {statuses.map((value) => (
                  <ToggleButton
                    key={value}
                    value={value}
                    sx={segmentStyle(value)}
                  >
                    {statusName(value)}
                  </ToggleButton>
                ))}
              </ToggleButtonGroup>
            </Box>
          </Stack>
          {visible.length === 0 && (
            <Typography variant="body2" color="text.secondary">
              No matching tool calls.
            </Typography>
          )}
          {visible.map((r) => (
            <Accordion
              key={r.id}
              expanded={expanded === r.id}
              onChange={(_, on) => setExpanded(on ? r.id : "")}
              disableGutters
              elevation={0}
              sx={{
                mb: 0.75,
                border: 1,
                borderColor: "divider",
                borderRadius: "10px !important",
                overflow: "hidden",
                "&:before": { display: "none" },
              }}
            >
              <AccordionSummary
                expandIcon={<ChevronRight fontSize="small" />}
                sx={{
                  px: { xs: 1, sm: 2 },
                  minHeight: 40,
                  flexDirection: "row-reverse",
                  gap: { xs: 1, sm: 1.5 },
                  bgcolor: "background.paper",
                  "& .MuiAccordionSummary-expandIconWrapper": {
                    color: "text.primary",
                  },
                  "&.Mui-expanded": { bgcolor: "action.hover" },
                  "& .MuiAccordionSummary-expandIconWrapper.Mui-expanded": {
                    transform: "rotate(90deg)",
                  },
                  "& .MuiAccordionSummary-content": {
                    minWidth: 0,
                    my: 0.5,
                    display: "flex",
                    alignItems: "center",
                    flexWrap: "wrap",
                    gap: { xs: 0.7, sm: 1.5 },
                  },
                }}
              >
                <Typography
                  component="span"
                  variant="subtitle2"
                  sx={{ overflowWrap: "anywhere" }}
                >
                  {entryName(r)}
                </Typography>
                <Box
                  component="span"
                  sx={{
                    ...journalStatusStyle(journalStatus(r)),
                    typography: "caption",
                    px: 1,
                    py: 0.25,
                    borderRadius: 5,
                  }}
                >
                  {statusName(journalStatus(r))}
                </Box>
                <Box
                  component="span"
                  sx={{
                    ml: { sm: "auto" },
                    display: { xs: "inline-flex", lg: "grid" },
                    gridTemplateColumns: "auto minmax(0,1fr)",
                    minWidth: { lg: "min(36vw,560px)" },
                    alignItems: "center",
                    flexWrap: "wrap",
                    gap: { xs: 0.5, md: 2.5, lg: 4 },
                    typography: "body2",
                    color: "text.secondary",
                  }}
                >
                  <Timestamp value={r.created} />
                  <span>
                    {duration(r.duration)} · {count(r.attempts, "attempt")}
                    {r.runState === "Completed" && " · Completed"}
                  </span>
                </Box>
              </AccordionSummary>
              <AccordionDetails
                sx={{
                  pl: { xs: 2, sm: 6 },
                  pr: { xs: 2, md: 3 },
                  pt: 1.5,
                  pb: 1.5,
                }}
              >
                {expanded === r.id && open && (
                  <ExecutionDetails
                    row={r}
                    session={session}
                    revision={revision}
                    peers={rows ?? []}
                  />
                )}
              </AccordionDetails>
            </Accordion>
          ))}
        </DialogContent>
        <DialogActions sx={{ borderTop: 1, borderColor: "divider" }}>
          <Button onClick={() => setOpen(false)}>Close</Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
