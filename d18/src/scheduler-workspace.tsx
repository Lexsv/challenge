import { useEffect, useRef, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
  IconButton,
  Tooltip,
  List,
  ListItemButton,
  Paper,
  Stack,
  Tab,
  Tabs,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from "@mui/material";
import Add from "@mui/icons-material/Add";
import ScheduleOutlined from "@mui/icons-material/ScheduleOutlined";
import PlayArrowOutlined from "@mui/icons-material/PlayArrowOutlined";
import PauseOutlined from "@mui/icons-material/PauseOutlined";
import PlayCircleOutline from "@mui/icons-material/PlayCircleOutline";
import History from "@mui/icons-material/History";
import ArrowBack from "@mui/icons-material/ArrowBack";
import StopOutlined from "@mui/icons-material/StopOutlined";
import DeleteOutline from "@mui/icons-material/DeleteOutline";
import EditOutlined from "@mui/icons-material/EditOutlined";
import type { ProviderRegistry } from "./provider-registry";
import { ExecutionDetails, journalStatus, useSessionToolJournal } from "./session-tool-journal";
import { SchedulerForm } from "./scheduler-form";
import { SchedulerReports } from "./scheduler-results";
import { cadence, schedulerApi, stamp, type Task, type HistoryPage, type Occurrence } from "./scheduler-api";

export function TaskStatus({ status }: { status: string }) {
  const color = ["Completed", "Scheduled", "Success"].includes(status)
    ? "success"
    : status === "Running"
      ? "primary"
      : status === "Failed"
        ? "error"
        : ["Requires review", "RequiresReview", "PartialSuccess", "Interrupted"].includes(status)
          ? "warning"
          : "default";
  return (
    <Chip
      size="small"
      variant="outlined"
      color={color}
      label={status === "RequiresReview" ? "Requires review" : status}
      sx={{ height: 22, fontSize: "0.75rem" }}
    />
  );
}
type HistoryTask = Pick<Task, "id" | "timezone"> & { metrics: Pick<Task["metrics"], "active"> };

function Execution({ row, task }: { row: Occurrence; task: HistoryTask }) {
  const baseUrl = "/api/scheduler/tasks/" + task.id + "/history/" + row.id + "/journal";
  const journal = useSessionToolJournal(task.id, true, row.id + row.state, !!task.metrics.active, baseUrl);
  const peers = journal?.data?.filter((r) => r.runId === row.id) ?? [];
  return (
    <Stack spacing={1} sx={{ p: 1, minWidth: 0, overflowWrap: "anywhere" }}>
      <Typography variant="subtitle2">Attempt Details</Typography>
      {row.error && <Alert severity="warning">{row.error}</Alert>}
      {row.resolutionIssues?.map((issue, i) => (
        <Alert severity="error" key={i}>
          {issue.code} · {issue.source} / {issue.stage}
          {issue.schemaSide && " · " + issue.schemaSide + " schema"}
          {issue.toolId && " · Tool " + issue.toolId}
          {issue.diagnostic && " · " + issue.diagnostic}
        </Alert>
      ))}
      {!journal?.data ? (
        <Typography variant="body2">{journal?.error ? "Journal unavailable." : "Loading journal…"}</Typography>
      ) : !peers.length ? (
        <Typography variant="body2">No recorded tool calls.</Typography>
      ) : (
        peers.map((op) => (
          <Box component="details" key={op.id}>
            <Typography component="summary" sx={{ cursor: "pointer" }}>
              {[op.server, op.name].filter(Boolean).join(" · ")} · {journalStatus(op)} · {op.duration} ms
            </Typography>
            <ExecutionDetails
              row={op}
              peers={peers}
              session={task.id}
              baseUrl={baseUrl}
              revision={row.id + op.status}
            />
          </Box>
        ))
      )}
    </Stack>
  );
}
function HistoryRow({ row, task, dates }: { row: Occurrence; task: HistoryTask; dates: Intl.DateTimeFormat }) {
  const [expanded, setExpanded] = useState(false);
  const toggle = () => setExpanded((open) => !open);
  const detailsId = "history-details-" + row.id;
  return (
    <>
      <TableRow hover selected={expanded}>
        <TableCell align="center">
          <Button
            size="small"
            color="primary"
            aria-label={`${expanded ? "Collapse" : "Expand"} execution ${row.id.slice(0, 8)}`}
            aria-expanded={expanded}
            aria-controls={expanded ? detailsId : undefined}
            onClick={toggle}
            sx={{ minWidth: 0, px: 0.5, textTransform: "none" }}
          >
            {row.id.slice(0, 8)}
          </Button>
        </TableCell>
        {[row.started_at, row.finished_at].map((value, i) => (
          <TableCell key={i} align="center">
            {value === null ? "—" : <time dateTime={new Date(value).toISOString()}>{dates.format(value)}</time>}
          </TableCell>
        ))}
        <TableCell align="center">
          {row.finished_at !== null && row.started_at !== null ? row.finished_at - row.started_at + " ms" : "—"}
        </TableCell>
        <TableCell align="center"><TaskStatus status={row.state} /></TableCell>
      </TableRow>
      {expanded && (
        <TableRow id={detailsId}>
          <TableCell colSpan={5}><Execution row={row} task={task} /></TableCell>
        </TableRow>
      )}
    </>
  );
}

export function RunHistory({ rows, task }: { rows: Occurrence[]; task: HistoryTask }) {
  if (!rows.length) return <Typography color="text.secondary">No executions recorded yet.</Typography>;
  const dates = new Intl.DateTimeFormat("sv-SE", {
    timeZone: task.timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  return (
    <TableContainer>
      <Table size="small" aria-label="Execution history" sx={{
        tableLayout: "fixed",
        "& th, & td:not([colspan])": {
          px: { xs: 0.25, sm: 1 }, fontSize: { xs: "0.75rem", sm: "0.875rem" }, fontVariantNumeric: "tabular-nums",
        },
        "& td > button": { fontSize: { xs: "0.6875rem", sm: "0.8125rem" } },
        "& td .MuiChip-label": { px: { xs: 0.4, sm: 1 }, whiteSpace: { xs: "normal", sm: "nowrap" }, lineHeight: 1.1 },
        "& td .MuiChip-root": { height: "auto", minHeight: 22, fontSize: { xs: "0.6875rem", sm: "0.75rem" } },
      }}>
        <TableHead>
          <TableRow>
            {[["ID", "19%"], ["Started", "23%"], ["Completed", "23%"], ["Duration", "14%"], ["Status", "21%"]].map(([label, width]) => (
              <TableCell key={label} align="center" sx={{ width }}>
                {label}
              </TableCell>
            ))}
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.map((row) => <HistoryRow key={row.id} row={row} task={task} dates={dates} />)}
        </TableBody>
      </Table>
    </TableContainer>
  );
}
function Configuration({ task: t }: { task: Task }) {
  const fields = [
    ["Provider / model", t.provider + " / " + t.model],
    ["Schedule", cadence(t.schedule)],
    ["Start", stamp(t.schedule.kind === "once" ? t.schedule.at : t.schedule.startAt, t.timezone)],
    ["Timezone", t.timezone],
    ["Last execution", stamp(t.metrics.last, t.timezone)],
    ["Next execution", t.enabled && !t.metrics.review ? stamp(t.next_due_at, t.timezone) : "—"],
  ];
  return (
    <Stack spacing={2}>
      <Box>
        <Typography variant="subtitle2">Agent instructions</Typography>
        <Typography variant="body2" sx={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", mt: 0.5 }}>
          {t.instructions}
        </Typography>
      </Box>
      <Divider />
      <Box
        component="dl"
        sx={{ m: 0, display: "grid", gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" }, gap: 1.5 }}
      >
        {fields.map(([k, v]) => (
          <Box key={k}>
            <Typography component="dt" variant="caption" color="text.secondary">
              {k}
            </Typography>
            <Typography component="dd" variant="body2" sx={{ m: 0, overflowWrap: "anywhere" }}>
              {v}
            </Typography>
          </Box>
        ))}
      </Box>
      <Divider />
      <Box>
        <Typography variant="subtitle2" mb={1}>
          Authorized MCP tools
        </Typography>
        {t.tools.length ? (
          <Stack direction="row" gap={1} flexWrap="wrap">
            {t.tools.map((o) => (
              <Chip key={o.server + "/" + o.name} size="small" label={o.server + " / " + o.name} />
            ))}
          </Stack>
        ) : (
          <Typography variant="body2" color="text.secondary">
            No MCP tools selected.
          </Typography>
        )}
      </Box>
    </Stack>
  );
}
export function LifecycleButtons({ task, busy, control }: {
  task: Pick<Task, "status" | "review_definition" | "metrics" | "stopped">;
  busy: boolean;
  control: (action: string) => void;
}) {
  const status = task.status;
  const active = status === "Scheduled" || status === "Running";
  const paused = status === "Paused";
  const canStart = ["Pending", "Stopped", "Finished", "Failed"].includes(status) && !task.review_definition;
  const primaryEnabled = active || (!task.metrics.active && (paused || canStart));
  return (
    <>
      <Button
        size="small"
        variant={active ? "outlined" : "contained"}
        sx={{ width: "7rem", height: 32 }}
        startIcon={active ? <PauseOutlined /> : paused ? <PlayCircleOutline /> : <PlayArrowOutlined />}
        disabled={busy || !primaryEnabled}
        onClick={() => control(active ? "pause" : paused ? "resume" : "start")}
      >
        {active ? "Pause" : paused ? "Continue" : "Start"}
      </Button>
      <Button
        size="small"
        variant="outlined"
        sx={{ width: "5rem", height: 32 }}
        startIcon={<StopOutlined />}
        disabled={busy || status === "Pending" || task.stopped || status === "Stopped" || status === "Deleting"}
        onClick={() => control("stop")}
      >
        Stop
      </Button>
    </>
  );
}
const sections = ["Results & Reports", "Execution History", "Configuration"] as const;
export function SchedulerWorkspace({ registry }: { registry: ProviderRegistry }) {
  const [tasks, setTasks] = useState<Task[]>([]),
    [ready, setReady] = useState(false),
    [id, select] = useState("");
  const [tab, setTab] = useState(0),
    [offset, setOffset] = useState(0),
    [page, setPage] = useState<{ key: string; value: HistoryPage } | null>(null);
  const [latest, setLatest] = useState<{ key: string; rows: Pick<Occurrence, "response">[] } | null>(null);
  const [archive, setArchive] = useState(false);
  const [review, setReview] = useState<Task | null>(null);
  const [deleting, setDeleting] = useState<Task | null>(null);
  const [form, setForm] = useState<"create" | Task | null>(null),
    [busy, setBusy] = useState(false),
    lock = useRef(false);
  const [revision, refresh] = useState(0),
    [error, setError] = useState(""),
    [readError, setReadError] = useState("");
  const task = tasks.find((t) => t.id === id),
    pageKey = (task?.id ?? "") + "/" + tab + "/" + offset;
  useEffect(() => {
    let active = true,
      running = false;
    async function read() {
      if (running || document.hidden) return;
      running = true;
      try {
        const list = await schedulerApi<Task[]>(archive ? "archive" : "tasks");
        if (!active || lock.current) return;
        setTasks(list);
        setReady(true);
        const item = list.find((t) => t.id === id);
        if (id && !item) select("");
        if (item && tab === 0) {
          const result = await schedulerApi<{ rows: Pick<Occurrence, "response">[] }>(
            "tasks/" + item.id + "/result",
          );
          if (active) setLatest({ key: item.id, rows: result.rows });
        } else if (item && tab === 1) {
          const value = await schedulerApi<HistoryPage>("tasks/" + item.id + "/history?offset=" + offset);
          if (active) setPage({ key: item.id + "/" + tab + "/" + offset, value });
        }
        if (active) setReadError("");
      } catch (e) {
        if (active) {
          setPage(null);
          setLatest(null);
          setReadError((e as Error).message);
        }
      } finally {
        running = false;
      }
    }
    void read();
    const timer = setInterval(read, 4000);
    document.addEventListener("visibilitychange", read);
    return () => {
      active = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", read);
    };
  }, [id, offset, tab, revision, archive]);
  async function control(action: string) {
    const target = action === "delete" ? deleting : action === "review" ? review : task;
    if (!target || lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      if (action === "delete") {
        await schedulerApi("tasks/" + target.id, "DELETE");
        setDeleting(null);
      } else if (action === "review" && review) {
        await schedulerApi("tasks/" + review.id + "/review", "POST", {
          confirmed: true,
          revision: review.revision,
          occurrenceIds: review.reviewIds,
        });
        setReview(null);
      } else await schedulerApi("tasks/" + target.id + "/" + action, "POST");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      refresh((x) => x + 1);
      lock.current = false;
      setBusy(false);
    }
  }
  const history = page?.key === pageKey ? page.value : null;
  const status = task?.status ?? "";
  const canEdit = ["Pending", "Failed", "Finished", "Review configuration", "Requires review", "Stopped"].includes(status);
  const archiveAction = archive ? "Back to scheduled tasks" : "Deleted Task History";
  return (
    <Stack spacing={2}>
      <Typography variant="h5" component="h2">
        Scheduler
      </Typography>
      {((!deleting && !review && error) || readError) && (
        <Alert severity="error" action={<Button onClick={() => refresh((v) => v + 1)}>Refresh</Button>}>
          {(!deleting && !review && error) || readError}
        </Alert>
      )}
      <Dialog
        open={!!review}
        onClose={() => {
          if (!busy) setReview(null);
        }}
        aria-labelledby="scheduler-review"
      >
        <DialogTitle id="scheduler-review">Review uncertain execution</DialogTitle>
        <DialogContent>
          <DialogContentText>
            An external operation may have taken effect. Inspect its journal and verify the remote state before
            authorizing another run. Repeating the task could duplicate a write. Confirmation leaves the
            schedule stopped.
          </DialogContentText>
          {review?.reviewIds?.map((id) => (
            <Typography variant="caption" display="block" key={id}>
              {id}
            </Typography>
          ))}
          {error && <Alert severity="error">{error}</Alert>}
        </DialogContent>
        <DialogActions>
          <Button disabled={busy} onClick={() => setReview(null)}>
            Cancel
          </Button>
          <Button disabled={busy} onClick={() => control("review")}>
            Confirm review
          </Button>
        </DialogActions>
      </Dialog>
      <Dialog
        open={!!deleting}
        onClose={() => {
          if (!busy) setDeleting(null);
        }}
        aria-labelledby="scheduler-delete-title"
      >
        <DialogTitle id="scheduler-delete-title">Delete scheduled task?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Delete “{deleting?.name}”? New executions will stop. Admitted executions can finish, and their
            history will be preserved.
          </DialogContentText>
          {error && (
            <Alert severity="error" sx={{ mt: 1 }}>
              {error}
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button
            disabled={busy}
            onClick={() => {
              setDeleting(null);
              setError("");
            }}
          >
            Cancel
          </Button>
          <Button
            color="error"
            variant="contained"
            disabled={busy}
            onClick={() => control("delete")}
            startIcon={busy && <CircularProgress size={16} />}
          >
            {busy ? "Deleting…" : "Delete task"}
          </Button>
        </DialogActions>
      </Dialog>
      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: { xs: "minmax(0,1fr)", md: "minmax(255px, 0.85fr) minmax(0,2.5fr)" },
          gap: 2,
          alignItems: "start",
        }}
      >
        <Paper variant="outlined" component="aside" sx={{ overflow: "hidden" }}>
          <Stack sx={{ p: 2 }} spacing={1.5}>
            <Stack direction="row" alignItems="center" justifyContent="space-between" gap={1}>
              <Typography variant="h6">{archive ? "Deleted task history" : "Scheduled tasks"}</Typography>
              <Tooltip title={archiveAction}>
                <IconButton
                  size="small"
                  aria-label={archiveAction}
                  onClick={() => {
                    setArchive(!archive);
                    setTasks([]);
                    setReady(false);
                    select("");
                    setOffset(0);
                    setTab(archive ? 0 : 1);
                    setError("");
                  }}
                >
                  {archive ? <ArrowBack fontSize="small" /> : <History fontSize="small" />}
                </IconButton>
              </Tooltip>
            </Stack>
            {!archive && tasks.length > 0 && (
              <Button variant="contained" startIcon={<Add />} onClick={() => setForm("create")}>
                Create Scheduler
              </Button>
            )}
          </Stack>
          <Divider />
          <List disablePadding aria-label="Scheduled tasks">
            {tasks.map((t) => (
              <ListItemButton
                key={t.id}
                selected={t.id === task?.id}
                onClick={() => {
                  select(t.id);
                  setOffset(0);
                  setError("");
                }}
                sx={{
                  p: 1.75,
                  alignItems: "start",
                  borderLeft: 3,
                  borderColor: t.id === task?.id ? "primary.main" : "transparent",
                }}
              >
                <Stack spacing={0.7} minWidth={0} width="100%">
                  <Stack direction="row" justifyContent="space-between" alignItems="center" gap={1}>
                    <Typography variant="subtitle2" sx={{ overflowWrap: "anywhere" }}>
                      {t.name}
                    </Typography>
                    <TaskStatus status={t.status} />
                  </Stack>
                  <Typography variant="body2">{cadence(t.schedule)}</Typography>
                  <Typography variant="caption" color="text.secondary">
                    Next · {stamp(t.enabled && !t.metrics.review ? t.next_due_at : null, t.timezone)}
                  </Typography>
                </Stack>
              </ListItemButton>
            ))}
          </List>
          {!tasks.length && !readError && (
            <Typography sx={{ p: 2 }} color="text.secondary">
              {ready ? (archive ? "No deleted tasks." : "No scheduled tasks.") : "Loading tasks…"}
            </Typography>
          )}
        </Paper>
        <Paper variant="outlined" component="section" sx={{ minWidth: 0, p: { xs: 1.5, md: 2.5 } }}>
          {!task ? (
            <Stack alignItems="center" justifyContent="center" minHeight={240} spacing={1}>
              {tasks.length ? (
                <Typography color="text.secondary">Select a scheduled task to view its details.</Typography>
              ) : (
                !readError &&
                !archive &&
                (ready ? (
                  <Button variant="contained" startIcon={<Add />} onClick={() => setForm("create")}>
                    Create Scheduler
                  </Button>
                ) : (
                  <CircularProgress size={22} aria-label="Loading Scheduler" />
                ))
              )}
            </Stack>
          ) : (
            <Stack spacing={2}>
              <Stack direction="row" alignItems="center" gap={1} flexWrap="wrap">
                <ScheduleOutlined color="primary" />
                <Typography variant="h6" sx={{ overflowWrap: "anywhere" }}>
                  {task.name}
                </Typography>
                <TaskStatus status={task.status} />
              </Stack>
              {!archive && (
                <Stack direction="row" gap={1} flexWrap="wrap">
                  <LifecycleButtons task={task} busy={busy} control={control} />
                  <Button
                    size="small"
                    startIcon={<EditOutlined />}
                    sx={{ visibility: canEdit ? "visible" : "hidden" }}
                    disabled={!canEdit || busy || !!task.metrics.active}
                    onClick={() => setForm(task)}
                  >
                    Edit configuration
                  </Button>
                  <Button
                    size="small"
                    color="error"
                    startIcon={<DeleteOutline />}
                    disabled={busy || task.status === "Deleting"}
                    onClick={() => {
                      setError("");
                      setDeleting(task);
                    }}
                  >
                    Delete
                  </Button>
                  {task.status === "Requires review" && (
                    <Button
                      size="small"
                      color="warning"
                      disabled={busy || !!task.metrics.active}
                      onClick={() => {
                        setTab(1);
                        setOffset(0);
                        setError("");
                        setReview(task);
                      }}
                    >
                      Review
                    </Button>
                  )}
                </Stack>
              )}
              {!!task.review_definition && !archive && (
                <Alert severity="warning">
                  Review and save the standalone configuration before starting this migrated task.
                </Alert>
              )}
              {!!task.metrics.active && !task.enabled && (
                <Alert severity="info">An admitted execution is still running.</Alert>
              )}
              {!!task.metrics.review && (
                <Alert severity="warning">An execution requires review. Further runs are held.</Alert>
              )}
              <Tabs
                value={tab}
                onChange={(_, v) => {
                  setOffset(0);
                  setTab(v);
                }}
                variant="scrollable"
                aria-label="Scheduler task sections"
              >
                {sections.map((s, i) => (
                  <Tab key={s} label={s} disabled={archive && i !== 1} />
                ))}
              </Tabs>
              {tab === 1 && (
                <Box
                  sx={{
                    display: "grid",
                    gridTemplateColumns: { xs: "repeat(2,1fr)", sm: "repeat(4,1fr)" },
                    border: 1,
                    borderColor: "divider",
                    borderRadius: 1,
                    p: 1.5,
                    gap: 1,
                  }}
                >
                  {(
                    [
                      ["Total executions", task.metrics.total],
                      ["Successful", task.metrics.success],
                      ["Failed", task.metrics.failed],
                      ["Authorization failures", task.metrics.denied],
                    ] as const
                  ).map(([k, n]) => (
                    <Box key={k}>
                      <Typography variant="caption" color="text.secondary">
                        {k}
                      </Typography>
                      <Typography variant="h6">{n}</Typography>
                    </Box>
                  ))}
                </Box>
              )}
              {tab === 2 ? (
                <Configuration task={task} />
              ) : tab === 0 && latest?.key === task.id ? (
                <SchedulerReports rows={latest.rows} timezone={task.timezone} />
              ) : tab === 1 && history ? (
                <>
                  <Box key={task.id + "/" + offset}>
                    <RunHistory rows={history.rows} task={task} />
                  </Box>
                  {tab === 1 && (offset > 0 || history.hasMore) && (
                    <Stack direction="row" alignItems="center" justifyContent="space-between">
                      <Button disabled={!offset} onClick={() => setOffset((v) => v - 25)}>
                        Newer
                      </Button>
                      <Typography variant="caption">Page {1 + offset / 25}</Typography>
                      <Button disabled={!history.hasMore} onClick={() => setOffset((v) => v + 25)}>
                        Older
                      </Button>
                    </Stack>
                  )}
                </>
              ) : (
                !readError && <CircularProgress size={22} aria-label="Loading execution history" />
              )}
            </Stack>
          )}
        </Paper>
      </Box>
      {form && (
        <SchedulerForm
          registry={registry}
          task={form === "create" ? undefined : form}
          onClose={() => setForm(null)}
          onSaved={(next) => {
            setForm(null);
            select(next);
            setTab(0);
            setOffset(0);
            refresh((v) => v + 1);
          }}
        />
      )}
    </Stack>
  );
}
