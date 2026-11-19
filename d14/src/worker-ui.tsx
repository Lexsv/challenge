import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  MenuItem,
  Paper,
  Stack,
  Menu,
  ButtonBase,
  LinearProgress,
  CircularProgress,
  Divider,
  TextField,
  Typography,
} from "@mui/material";
import MoreHoriz from "@mui/icons-material/MoreHoriz";
import Add from "@mui/icons-material/Add";

import { beginWorkerAction, endWorkerAction, subscribeWorkerAction, workerActionInFlight } from "./worker-action-flight";
import { saveWorker, deleteWorker, editorDocument, isQuizDocument, retryQuizSession, getWorkerStatus, sendWorkerAction, WorkerActionError, type WorkerDocument, type WorkerSession, type WorkerActionCommand, type WorkerAction, type WorkerStatus } from "./worker-api";
export type WorkerTemplate = {
  id: string;
  name: string;
  description: string;
  rules: string;
  steps: string;
  version?: number;
  document?: WorkerDocument;
  correctOptionIds?: string[];
};
export const demoWorkers: WorkerTemplate[] = [
  {
    id: "quiz",
    name: "Programming Quiz",
    description: "Five short multiple-choice programming questions.",
    rules: "Choose one answer for each question.",
    steps: [
      "Which keyword declares a constant in JavaScript? A) const B) var C) let D) static",
      "Which type represents true or false? A) string B) boolean C) number D) array",
      "Which operator checks strict equality in JavaScript? A) = B) == C) === D) !=",
      "Which structure stores ordered items? A) Array B) Boolean C) Null D) Function",
      "Which HTTP method retrieves a resource? A) POST B) DELETE C) GET D) PATCH",
    ].join("\n"),
  },
  {
    id: "chocolate",
    name: "Chocolate Production",
    description: "Walk through five chocolate production steps.",
    rules: "Review each step before validation.",
    steps: [
      "Select and inspect cocoa beans",
      "Roast the beans",
      "Grind and refine the cocoa",
      "Temper the chocolate",
      "Mould and inspect the finished chocolate",
    ].join("\n"),
  },
];
export const workerSteps = (worker: WorkerTemplate) =>
  worker.steps
    .split(/\r?\n/)
    .map((step) => step.trim())
    .filter(Boolean);

export function WorkerTemplates({
  workers,
  onChange,
}: {
  workers: WorkerTemplate[];
  onChange: (workers: WorkerTemplate[]) => void;
}) {
  const ordered = [...workers].sort(
    (a, b) =>
      (b.document?.schemaVersion ?? 1) - (a.document?.schemaVersion ?? 1),
  );
  const [draft, setDraft] = useState<WorkerTemplate | null>(
    () => ordered[0] ?? null,
  );
  const [menu, setMenu] = useState<{
    element: HTMLElement;
    worker: WorkerTemplate;
  } | null>(null);
  const [deleting, setDeleting] = useState<WorkerTemplate | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const save = async () => {
    if (!draft?.name.trim() || !workerSteps(draft).length) return;
    setPending(true);
    setError("");
    try {
      const clean = await saveWorker(draft);
      onChange(
        workers.some((item) => item.id === clean.id)
          ? workers.map((item) => (item.id === clean.id ? clean : item))
          : [...workers, clean],
      );
      setDraft(clean);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save Worker.");
    } finally {
      setPending(false);
    }
  };
  return (
    <Paper variant="outlined" sx={{ p: { xs: 2, md: 3 }, bgcolor: "white" }}>
      <Typography variant="h4" component="h2">
        Worker Templates
      </Typography>
      <Typography
        variant="body2"
        color="text.secondary"
        sx={{ mt: 0.5, mb: 3 }}
      >
        Create and manage reusable workflows for Worker sessions.
      </Typography>
      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: {
            xs: "1fr",
            sm: "minmax(190px, 32%) minmax(0, 1fr)",
          },
          gap: 2,
          alignItems: "start",
        }}
      >
        <Stack spacing={1} component="nav" aria-label="Worker templates">
          {ordered.map((worker) => (
            <Paper
              key={worker.id}
              variant="outlined"
              sx={{
                display: "flex",
                alignItems: "center",
                pr: 0.75,
                borderColor: draft?.id === worker.id ? "primary.light" : "divider",
                bgcolor: draft?.id === worker.id ? "action.selected" : "white",
              }}
            >
              <ButtonBase
                disabled={pending}
                aria-label={`Edit ${worker.name}`}
                aria-current={draft?.id === worker.id || undefined}
                sx={{
                  flex: 1,
                  minWidth: 0,
                  p: 1.5,
                  textAlign: "left",
                  justifyContent: "flex-start",
                }}
                onClick={() => {
                  setDraft({ ...worker });
                  setError("");
                }}
              >
                <Box>
                  <Typography variant="subtitle2" fontWeight={700}>
                    {worker.name}
                  </Typography>
                  <Typography variant="caption">
                    {worker.document?.steps.length ??
                      workerSteps(worker).length}{" "}
                    steps
                  </Typography>
                </Box>
              </ButtonBase>
              <IconButton
                size="small"
                disabled={pending}
                aria-label={`Actions for ${worker.name}`}
                aria-haspopup="menu"
                onClick={(event) =>
                  setMenu({ element: event.currentTarget, worker })
                }
              >
                <MoreHoriz />
              </IconButton>
            </Paper>
          ))}
          <Button
            disabled={pending}
            variant="outlined"
            startIcon={<Add />}
            sx={{ borderStyle: "dashed", py: 1.25 }}
            onClick={() => {
              setError("");
              setDraft({
                id: crypto.randomUUID(),
                name: "",
                description: "",
                rules: "Evaluate each selected answer against its configured correct option.",
                steps: "",
                document:{schemaVersion:2,steps:[]},correctOptionIds:[],
              });
            }}
          >
            New Worker
          </Button>
        </Stack>
        <Menu
          anchorEl={menu?.element}
          open={!!menu}
          onClose={() => setMenu(null)}
        >
          <MenuItem
            onClick={() => {
              if (menu) setDraft({ ...menu.worker });
              setMenu(null);
              setError("");
            }}
          >
            Edit
          </MenuItem>
          <MenuItem
            onClick={() => {
              if (menu) setDeleting(menu.worker);
              setMenu(null);
              setError("");
            }}
          >
            Delete
          </MenuItem>
        </Menu>
        <Paper
          variant="outlined"
          component="section"
          sx={{ p: { xs: 2, md: 2.5 }, minWidth: 0 }}
        >
          {error && !deleting && <Alert severity="error">{error}</Alert>}
          {draft ? (
            <Stack spacing={2}>
              <Typography variant="h6">
                {workers.some((item) => item.id === draft.id)
                  ? "Edit Worker Template"
                  : "Create Worker Template"}
              </Typography>
              {(["name", "description", "rules", "steps"] as const).map(
                (field) => (
                  <TextField
                    key={field}
                    label={field[0].toUpperCase() + field.slice(1)}
                    value={draft[field]}
                    required={field === "name" || field === "steps"}
                    multiline={field !== "name"}
                    minRows={
                      field === "steps" ? 5 : field === "name" ? undefined : 2
                    }
                    helperText={
                      field === "steps"
                        ? "Enter one step per line. For a question, append A) and B) choices (up to D)."
                        : undefined
                    }
                    onChange={(event) =>
                      setDraft(field==="steps" ? changeQuizSteps(draft,event.target.value) : { ...draft, [field]: event.target.value })
                    }
                  />
                ),
              )}
              <Box component="details" key={draft.id}>
                <Typography component="summary" variant="body2" sx={{cursor:'pointer',fontWeight:650}}>Correct answers</Typography>
                <QuizAnswerEditor draft={draft} onChange={setDraft}/>
              </Box>
              <Stack direction="row" justifyContent="flex-end" spacing={1}>
                <Button
                  disabled={pending}
                  onClick={() => {
                    setDraft(
                      workers.find((item) => item.id === draft.id) ??
                        ordered[0] ??
                        null,
                    );
                    setError("");
                  }}
                >
                  Cancel
                </Button>
                <Button
                  variant="contained"
                  disabled={
                    pending || !draft.name.trim() || !workerSteps(draft).length
                  }
                  onClick={() => void save()}
                >
                  Save
                </Button>
              </Stack>
            </Stack>
          ) : (
            <Typography color="text.secondary">
              Choose a template or create a Worker.
            </Typography>
          )}
        </Paper>
      </Box>
      <Dialog
        open={!!deleting}
        onClose={() => {
          if (!pending) setDeleting(null);
        }}
      >
        <DialogTitle>Delete worker template?</DialogTitle>
        <DialogContent>
          <Typography>
            Delete “{deleting?.name}”? Existing sessions retain their snapshot.
          </Typography>
          {error && <Alert severity="error">{error}</Alert>}
        </DialogContent>
        <DialogActions>
          <Button disabled={pending} onClick={() => setDeleting(null)}>
            Cancel
          </Button>
          <Button
            disabled={pending}
            color="error"
            onClick={async () => {
              if (!deleting) return;
              setPending(true);
              setError("");
              try {
                await deleteWorker(deleting.id);
                onChange(workers.filter((item) => item.id !== deleting.id));
                if (draft?.id === deleting.id)
                  setDraft(
                    ordered.find((item) => item.id !== deleting.id) ?? null,
                  );
                setDeleting(null);
              } catch (e) {
                setError(
                  e instanceof Error ? e.message : "Could not delete Worker.",
                );
              } finally {
                setPending(false);
              }
            }}
          >
            Delete
          </Button>
        </DialogActions>
      </Dialog>
    </Paper>
  );
}

function changeQuizSteps(draft: WorkerTemplate, steps: string): WorkerTemplate {
  const previous = draft.steps.split(/\r?\n/).filter((line) => line.trim());
  const keys = draft.correctOptionIds ?? [];
  const lines = steps.split(/\r?\n/).filter((line) => line.trim());
  const correctOptionIds = lines.map((line, i) => (line === previous[i] ? (keys[i] ?? "") : ""));
  return { ...draft, steps, correctOptionIds };
}
function QuizAnswerEditor({
  draft,
  onChange,
}: {
  draft: WorkerTemplate;
  onChange: (value: WorkerTemplate) => void;
}) {
  let document: WorkerDocument;
  try {
    document = editorDocument(draft);
  } catch {
    return <Typography variant="body2">Complete each question and its choices first.</Typography>;
  }
  const keys = draft.correctOptionIds ?? [];
  return (
    <Stack spacing={2} sx={{ mt: 2 }}>
      {document.steps.map((step, i) =>
        step.type === "question" ? (
          <TextField
            select
            required
            key={step.id}
            label={`Question ${i + 1} · ${step.prompt}`}
            value={keys[i] ?? ""}
            onChange={(event) => {
              const next = [...keys];
              next[i] = event.target.value;
              onChange({ ...draft, correctOptionIds: next });
            }}
          >
            {step.options.map((option, j) => (
              <MenuItem key={option.id} value={option.id}>
                {String.fromCharCode(65 + j)}. {option.text}
              </MenuItem>
            ))}
          </TextField>
        ) : (
          <Typography key={step.id}>Question {i + 1} needs two to four choices.</Typography>
        ),
      )}
    </Stack>
  );
}

const actionLabels: Record<WorkerAction, string> = { start: 'Start', next: 'Next', back: 'Back', retry: 'Retry', continue: 'Continue', complete: 'Complete',submit:'Submit',correct:'Correct',validate:'Validate',quiz_next:'Next',quiz_back:'Back',try_again:'Try Again' };
export function WorkerLifecycleMessage({ state, available, loaded, loading, pending }: { state: string; available: WorkerAction[]; loaded: boolean; loading: boolean; pending: WorkerActionCommand | null }) {
  if (state === 'completed') return <Typography>Completed — read only</Typography>;
  if (state !== 'failed') return <Typography>In progress</Typography>;
  const message = loading && pending?.action === 'retry' ? 'Retrying the failed operation…'
    : !loaded ? 'Worker execution failed. Checking recovery availability…'
    : available.includes('retry') ? 'Worker execution failed. You can retry the failed operation.'
    : 'Worker execution failed. Recovery is currently unavailable.';
  return <Typography>{message}</Typography>;
}
export function WorkerControls({ available, disabled, pending, onAction, retryValidation = false }: { available: WorkerAction[]; disabled: boolean; pending: WorkerActionCommand | null; onAction: (action: WorkerAction) => void; retryValidation?:boolean }) {
  return <Stack direction="row" spacing={1} flexWrap="wrap">
    {(['back','retry','continue','next','validate','complete'] as const).filter(action=>available.includes(action)).map(action => <Button key={action} variant={["next","validate","complete"].includes(action) ? "contained" : "outlined"} disabled={disabled || !!pending} onClick={() => onAction(action)}>{action==='validate' && retryValidation?'Retry Validate':actionLabels[action]}</Button>)}
    {pending && <Button disabled={disabled} onClick={() => onAction(pending.action)}>Reconcile {actionLabels[pending.action]}</Button>}
  </Stack>;
}
type Question = Extract<WorkerDocument["steps"][number], { type: "question" }>;
export function AnswerOptions({
  step,
  value,
  disabled,
  onSelect,
}: {
  step: Question;
  value?: string;
  disabled: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <Stack role="group" aria-label="Answer options" spacing={1}>
      {step.options.map((option, index) => {
        const selected = value === option.id;
        return (
          <ButtonBase
            key={option.id}
            disabled={disabled}
            aria-pressed={selected}
            onClick={() => onSelect(option.id)}
            sx={{
              justifyContent: "flex-start",
              gap: 1.5,
              p: 1,
              border: 1,
              borderRadius: 1,
              borderColor: selected ? "primary.main" : "divider",
              bgcolor: selected ? "action.selected" : "white",
              textAlign: "left",
              "&:hover": { bgcolor: "action.hover" },
            }}
          >
            <Box
              component="span"
              aria-hidden
              sx={{
                display: "grid",
                placeItems: "center",
                width: 30,
                height: 30,
                borderRadius: 0.65,
                bgcolor: selected ? "primary.main" : "secondary.light",
                color: selected ? "white" : "text.primary",
                fontWeight: 700,
              }}
            >
              {String.fromCharCode(65 + index)}
            </Box>
            {option.text}
          </ButtonBase>
        );
      })}
    </Stack>
  );
}

export function QuizQuestionCard({
  step,
  value,
  last,
  first,
  available,
  disabled,
  onAction,
  validationFailed,
  validating = false,
}: {
  step: Question;
  value?: string;
  first: boolean;
  last: boolean;
  available: WorkerAction[];
  disabled: boolean;
  onAction: (action: WorkerAction, payload?: Record<string, unknown>) => void;
  validationFailed: boolean;
  validating?: boolean;
}) {
  const save = available.includes("correct") ? "correct" : "submit";
  return (
    <Paper variant="outlined" sx={{ p: { xs: 2, md: 2.5 } }}>
      <Stack spacing={2}>
        <Typography variant="h5" component="h3">
          {step.prompt}
        </Typography>
        <AnswerOptions
          step={step}
          value={value}
          disabled={disabled || !available.includes(save)}
          onSelect={(optionId) => {
            if (optionId !== value) onAction(save, { result: { type: "question", optionId } });
          }}
        />
        <Stack direction="row" justifyContent="space-between">
          <Button
            variant="outlined"
            disabled={disabled || first || !available.includes("quiz_back")}
            onClick={() => onAction("quiz_back")}
          >
            Back
          </Button>
          <Button
            variant="contained"
            sx={validating ? { "&.Mui-disabled": { bgcolor: "action.selected", color: "primary.dark" } } : undefined}
            aria-busy={validating || undefined}
            startIcon={validating ? <CircularProgress aria-hidden color="inherit" size={14} /> : undefined}
            disabled={disabled || !available.includes(last ? "validate" : "quiz_next")}
            onClick={() => onAction(last ? "validate" : "quiz_next")}
          >
            {validating ? "Validating…" : last ? (validationFailed ? "Retry Validate" : "Validate") : "Next"}
          </Button>
        </Stack>
      </Stack>
    </Paper>
  );
}
function QuizResults({
  report,
  done,
  disabled,
  onAction,
}: {
  report: NonNullable<WorkerStatus["quizReport"]>;
  done: boolean;
  disabled: boolean;
  onAction: (action: WorkerAction) => void;
}) {
  return (
    <Paper variant="outlined" aria-label="Quiz results" sx={{ p: 2.5 }}>
      <Stack spacing={2}>
        <Typography variant="h5" component="h3">
          Quiz results
        </Typography>
        <Typography>
          <strong>{report.percentage}%</strong> · {report.total} questions · {report.correct}{" "}
          correct · {report.incorrect} incorrect
        </Typography>
        {report.questions.map((q, i) => (
          <Box key={q.stepId} sx={{ borderTop: 1, borderColor: "divider", pt: 1 }}>
            <Typography fontWeight={700}>
              {i + 1}. {q.prompt}
            </Typography>
            <Typography variant="body2" color={q.passed ? "success.main" : "error.main"}>
              {q.passed ? "Correct" : "Incorrect"}
            </Typography>
            <Typography variant="body2">Your answer: {q.selected}</Typography>
            <Typography variant="body2">Correct answer: {q.correct}</Typography>
          </Box>
        ))}
        <Stack direction="row" spacing={1}>
          <Button variant="outlined" disabled={disabled} onClick={() => onAction("try_again")}>
            Try Again
          </Button>
          {!done && (
            <Button variant="contained" disabled={disabled} onClick={() => onAction("complete")}>
              Finish
            </Button>
          )}
        </Stack>
      </Stack>
    </Paper>
  );
}

type ResultControlProps = {
  step: WorkerDocument["steps"][number];
  available: WorkerAction[];
  disabled: boolean;
  selectedOption: string;
  savedOption?: string;
  problem: string;
  reporting: boolean;
  onReporting: (open: boolean) => void;
  onSelectedOption: (value: string) => void;
  onProblem: (value: string) => void;
  onAction: (action: WorkerAction, payload: Record<string, unknown>) => void;
};

export function WorkerResultControls({
  step,
  available,
  disabled,
  selectedOption,
  savedOption,
  problem,
  reporting,
  onReporting,
  onSelectedOption,
  onProblem,
  onAction,
}: ResultControlProps) {
  const action = available.includes("submit") ? "submit" : "correct";
  if (step.type === "question")
    return (
      <Stack spacing={1.25}>
        <AnswerOptions step={step} value={selectedOption || savedOption} disabled={disabled} onSelect={onSelectedOption}/>
        <Button
          sx={{ alignSelf: "flex-start" }}
          variant={action === "correct" ? "outlined" : "contained"}
          disabled={
            disabled || !selectedOption || selectedOption === savedOption
          }
          onClick={() =>
            onAction(action, {
              result: { type: "question", optionId: selectedOption },
            })
          }
        >
          {actionLabels[action]}
        </Button>
      </Stack>
    );
  if (reporting)
    return (
      <Stack spacing={1.5}>
        <TextField
          autoFocus
          required
          label="Problem description"
          value={problem}
          onChange={(event) => onProblem(event.target.value)}
          multiline
          minRows={2}
          disabled={disabled}
          slotProps={{ htmlInput: { maxLength: 10000 } }}
        />
        <Stack direction="row" spacing={1}>
          <Button
            variant="contained"
            disabled={disabled || !problem.trim() || problem.length > 10000}
            onClick={() =>
              onAction(action, {
                result: { type: "action", status: "problem", reason: problem },
              })
            }
          >
            Submit Problem
          </Button>
          <Button disabled={disabled} onClick={() => onReporting(false)}>
            Cancel
          </Button>
        </Stack>
      </Stack>
    );
  return (
    <Stack direction="row" gap={1} flexWrap="wrap">
      <Button
        variant={action === "correct" ? "outlined" : "contained"}
        disabled={disabled}
        onClick={() =>
          onAction(action, { result: { type: "action", status: "completed" } })
        }
      >
        Confirm Done
      </Button>
      <Button
        variant="outlined"
        disabled={disabled}
        onClick={() => onReporting(true)}
      >
        Report Problem
      </Button>
    </Stack>
  );
}

export const workerStateLabels: Record<string, string> = {
  not_started: "Not started",
  in_progress: "Active",
  failed: "Failed",
  completed: "Completed",
};

function WorkerTimeline({ stage, validating }: { stage: number; validating: boolean }) {
  return (
    <Box
      component="ol"
      aria-label="Worker timeline"
      sx={{ display: "flex", listStyle: "none", p: 0, m: 0 }}
    >
      {["Planning", "Execution", "Validation", "Done"].map((label, index) => (
        <Box
          component="li"
          key={label}
          aria-current={index === stage ? "step" : undefined}
          aria-label={index === 2 && validating ? "Validation in progress" : undefined}
          sx={{
            position: "relative",
            flex: 1,
            textAlign: "center",
            color: index <= stage ? "primary.dark" : "text.secondary",
            "&:not(:first-of-type)::before": {
              content: '""',
              position: "absolute",
              width: "calc(100% - 32px)",
              height: 2,
              top: 15,
              right: "calc(50% + 16px)",
              bgcolor: index <= stage ? "primary.main" : "divider",
            },
          }}
        >
          <Box
            component="span"
            sx={{
              position: "relative",
              display: "grid",
              placeItems: "center",
              mx: "auto",
              width: 32,
              height: 32,
              borderRadius: "50%",
              border: 1,
              borderColor: index <= stage ? "primary.main" : "divider",
              bgcolor:
                index === stage
                  ? "primary.main"
                  : index < stage
                    ? "action.selected"
                    : "white",
              color: index === stage ? "white" : "inherit",
              fontWeight: 700,
            }}
          >
            {index === 2 && validating && (
              <CircularProgress aria-hidden color="primary" size={38} thickness={3} sx={{ position: "absolute" }} />
            )}
            {index + 1}
          </Box>
          <Typography
            variant="caption"
            fontWeight={index === stage ? 750 : 550}
          >
            {label}
          </Typography>
        </Box>
      ))}
    </Box>
  );
}

// A pending command is retained per tab so an interrupted action can be retried
// with the same idempotency key, including after a page reload.
export function WorkerSessionPreview({ session, active = true, onRefresh, onAttempt, sidebar }: { onAttempt?:(session:WorkerSession)=>void; sidebar?:React.ReactNode; session: WorkerSession; active?: boolean; onRefresh?:(session: WorkerSession)=>void }) {
  const [status, setStatus] = useState<WorkerStatus | null>(null);
  const current = status?.session ?? session;
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [notice, setNotice] = useState(() =>
    readPending(session.id) && !workerActionInFlight(session.id)
      ? "The action outcome could not be confirmed. Retry to reconcile the same request."
      : "",
  );
  const [pending, setPending] = useState<WorkerActionCommand | null>(() =>
    readPending(session.id),
  );
  const [selectedOption, setSelectedOption] = useState("");
  const [problem, setProblem] = useState("");
  const [reporting, setReporting] = useState(false);
  const [showReport, setShowReport] = useState(false);
  const subscribeFlight = useCallback(
    (listener: () => void) => subscribeWorkerAction(session.id, listener),
    [session.id],
  );
  const flightSnapshot = useCallback(
    () => workerActionInFlight(session.id),
    [session.id],
  );
  const actionBusy = useSyncExternalStore(
    subscribeFlight,
    flightSnapshot,
    () => false,
  );
  const wasBusy = useRef(actionBusy);
  const fetchGeneration = useRef(0);
  const refresh = async () => {
    const generation = ++fetchGeneration.current;
    const data = await getWorkerStatus(session.id);
    if (generation === fetchGeneration.current) {
      setStatus(data);
      setLoaded(true);
      const outstanding = readPending(session.id);
      if (outstanding?.action === 'validate' && data.evaluation) {
        sessionStorage.removeItem(`worker-start:${session.id}`);
        setPending(null);
        setNotice("");
      }
      onRefresh?.(data.session);
    }
    return data;
  };
  useEffect(() => {
    if (!active) return;
    let alive = true;
    setLoading(true);
    setLoaded(false);
    refresh()
      .catch((error) => {
        if (alive)
          setNotice(
            error instanceof WorkerActionError &&
              [
                "integrity_failure",
                "corrupt_events",
                "projection_mismatch",
              ].includes(error.code)
              ? "Worker data integrity could not be verified."
              : error instanceof WorkerActionError && error.code === "not_found"
                ? "This Worker session no longer exists."
                : "Could not load this Worker session.",
          );
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
      fetchGeneration.current++;
    };
  }, [active, session.id]);
  // A remounted view re-reads the durable pending command and server state
  // when the earlier view's request settles.
  useEffect(() => {
    const settled = wasBusy.current && !actionBusy;
    wasBusy.current = actionBusy;
    if (!settled) return;
    const remaining = readPending(session.id);
    setPending(remaining);
    if (remaining)
      setNotice(
        "The action outcome could not be confirmed. Retry to reconcile the same request.",
      );
    if (active)
      void refresh().catch(() =>
        setNotice("Could not load this Worker session."),
      );
  }, [actionBusy, active, session.id]);
  // A reload can lose the browser's fetch while the evaluator is still running.
  // Poll the read endpoint only; a status check never resubmits a validation.
  useEffect(() => {
    if (!active || !loaded || actionBusy || !status?.validationPending) return;
    const timer = window.setTimeout(() => {
      void refresh().catch(() => {
        setLoaded(false);
        setNotice("Could not check validation. Check the session status before retrying.");
      });
    }, 600);
    return () => window.clearTimeout(timer);
  }, [active, loaded, actionBusy, status]);

  const checkValidationStatus = async () => {
    setLoading(true);
    try {
      const latest = await refresh();
      if (latest.evaluation || latest.validationPending || !readPending(session.id)) setNotice("");
    } catch {
      setLoaded(false);
      setNotice("Could not check validation. Check the session status before retrying.");
    } finally { setLoading(false); }
  };
  const perform = async (
    action: WorkerAction,
    payload: Record<string, unknown> = {},
  ) => {
    if (loading || !beginWorkerAction(session.id)) return;
    let command = pending;
    try {
      if (!command) {
        command = {
          requestId: crypto.randomUUID(),
          expectedRevision: current.revision,
          action,
          payload,
        };
        // Never send an unrecoverable command if its identity cannot be retained.
        sessionStorage.setItem(
          `worker-start:${session.id}`,
          JSON.stringify(command),
        );
        setPending(command);
      }
      setNotice("");
      if(command.action==='try_again'){
        const attempt=await retryQuizSession(session.id,command);
        onAttempt?.(attempt);
      }else{
        await sendWorkerAction(session.id, command);
        await refresh();
      }
      sessionStorage.removeItem(`worker-start:${session.id}`);
      setPending(null);
    } catch (error) {
      const code =
        error instanceof WorkerActionError ? error.code : "unknown_outcome";
      if (code === "revision_conflict") {
        sessionStorage.removeItem(`worker-start:${session.id}`);
        setPending(null);
        setLoaded(false);
        try {
          await refresh();
          setNotice(
            "This session changed. Its current state has been reloaded.",
          );
        } catch {
          setNotice(
            "This session changed, but its current state could not be loaded.",
          );
        }
      } else if (
        code === "invalid_transition" ||
        code === "request_id_conflict" ||
        code === "integrity_failure" ||
        code === "corrupt_events" ||
        code === "projection_mismatch" ||
        code === "invalid_input" ||
        code === "not_found" ||
        code === "validation_unavailable" ||
        code === "legacy_outcome_unavailable"
      ) {
        sessionStorage.removeItem(`worker-start:${session.id}`);
        setPending(null);
        setNotice(
          [
            "integrity_failure",
            "corrupt_events",
            "projection_mismatch",
          ].includes(code)
            ? "Worker data integrity could not be verified."
            : code === "request_id_conflict"
              ? "The request ID conflicts with an earlier command."
              : code === "not_found"
                ? "This Worker session no longer exists."
                : code === "validation_unavailable"
                  ? "Validation is unavailable."
                  : code === "invalid_input"
                    ? "The action request was invalid."
                    : code === "legacy_outcome_unavailable"
                      ? "The earlier action outcome is unavailable."
                      : "This action is not allowed in the current state.",
        );
      } else {
        if (command?.action === "validate") {
          setLoaded(false);
          try {
            const latest = await refresh();
            if (latest.evaluation || latest.validationPending) return;
          } catch {
            setNotice("Could not check validation. Check the session status before retrying.");
            return;
          }
        }
        setNotice(
          "The action outcome could not be confirmed. Retry to reconcile the same request.",
        );
      }
    } finally {
      endWorkerAction(session.id);
    }
  };
  const template = current.templateSnapshot;
  const quiz=isQuizDocument(template.document);
  const available = status?.availableActions ?? [];
  const validating = quiz && !status?.evaluation && (
    (actionBusy && pending?.action === "validate") || (loaded && status?.validationPending === true)
  );
  const busy = loading || actionBusy || validating;
  const step = template.document.steps[current.stepIndex];
  const total = status?.totalSteps ?? template.document.steps.length;
  const resolved = status?.resolvedSteps;
  const percent =
    resolved !== undefined && total > 0
      ? Math.round((resolved * 100) / total)
      : null;
  const stage =
    current.state === "not_started"
      ? 0
      : current.state === "completed"
        ? 3
        : validating || status?.evaluation ||
            (!quiz && available.includes("validate")) ||
            available.includes("complete")
          ? 2
          : 1;
  const effective = status?.results?.[current.stepIndex]?.result;
  const resultText =
    effective?.type === "question" && step?.type === "question"
      ? step.options.find((o) => o.id === effective.optionId)?.text
      : effective?.type === "action"
        ? effective.status === "problem"
          ? effective.reason
          : "Completed"
        : null;
  const currentStep =
    current.state === "not_started"
      ? "—"
      : `${current.stepIndex + 1} of ${total}`;
  useEffect(() => {
    setSelectedOption("");
    setProblem("");
    setReporting(false);
  }, [current.id, current.stepIndex, status?.session.revision]);
  const stateLabel = workerStateLabels[current.state];
  const canEditResult =
    available.includes("submit") || available.includes("correct");
  return (
    <Paper
      variant="outlined"
      sx={{
        display: "grid",
        minWidth: 0,
        overflow: "hidden",
        bgcolor: "white",
        gridTemplateColumns: {
          xs: "minmax(0,1fr)",
          md: sidebar
            ? "minmax(165px,19%) minmax(0,1fr) minmax(155px,20%)"
            : "minmax(0,1fr) minmax(155px,20%)",
        },
        "& > aside": { border: 0, borderRadius: 0 },
      }}
    >
      <Stack
        direction="row"
        spacing={1.5}
        alignItems="center"
        sx={{
          gridColumn: "1 / -1",
          p: 2.25,
          borderBottom: 1,
          borderColor: "divider",
        }}
      >
        <Typography variant="h5" component="h2">
          {session.name}
        </Typography>
        <Box
          component="span"
          sx={{
            px: 1.15,
            py: 0.35,
            borderRadius: 4,
            fontSize: 12,
            fontWeight: 650,
            color: current.state === "in_progress" ? "success.main" : "text.primary",
            bgcolor:
              current.state === "failed"
                ? "error.light"
                : current.state === "in_progress"
                  ? "success.light"
                  : "secondary.light",
          }}
        >
          ● {stateLabel}
        </Box>
      </Stack>
      {sidebar}
      <Box
        component="section"
        sx={{
          bgcolor: "white",
          minWidth: 0,
          minHeight: { md: 425 },
          borderInline: { md: "1px solid" },
          borderColor: { md: "divider" },
        }}
      >
        <Stack spacing={2.5} sx={{ p: { xs: 2, md: 2.5 } }}>
          <WorkerTimeline stage={stage} validating={validating} />
          <Stack direction="row" alignItems="center" gap={1.5}>
            <Typography variant="caption" fontWeight={700}>
              {current.state === "not_started"
                ? "Not started"
                : `Step ${currentStep}`}
            </Typography>
            <LinearProgress
              aria-label="Step progress"
              variant={percent === null ? "indeterminate" : "determinate"}
              value={percent ?? 0}
              sx={{ flex: 1 }}
            />
            <Typography variant="caption" fontWeight={700}>
              {percent === null ? "—" : `${percent}%`}
            </Typography>
          </Stack>
          {!quiz && actionBusy && pending && (
            <Typography role="status">
              {pending.action === "validate"
                ? "Validating…"
                : `${actionLabels[pending.action]} in progress…`}
            </Typography>
          )}
          {notice && !validating && <Alert severity="warning">{notice}</Alert>}
          {current.state === "not_started" ? (
            <Paper variant="outlined" sx={{ p: 2 }}>
              <Typography sx={{ mb: 2 }}>{template.description}</Typography>
              <Button
                variant="contained"
                disabled={
                  busy || !loaded || (!pending && !available.includes("start"))
                }
                onClick={() => perform(pending?.action ?? "start")}
              >
                {busy ? "Loading…" : pending ? "Retry Start" : "Start"}
              </Button>
            </Paper>
          ) : (
            <>
              {current.state === "failed" && (
                <WorkerLifecycleMessage
                  state={current.state}
                  available={available}
                  loaded={loaded}
                  loading={busy}
                  pending={pending}
                />
              )}
              {quiz && current.state==='failed' && available.includes('retry') && <Button disabled={busy||!!pending} onClick={()=>perform('retry')}>Retry</Button>}
              {quiz && !busy && !loaded && (pending?.action === 'validate' || status?.validationPending) &&
                <Button onClick={checkValidationStatus}>Check validation status</Button>}
              {quiz && pending && !busy && loaded &&
                <Button onClick={()=>perform(pending.action)}>Reconcile {actionLabels[pending.action]}</Button>}
              {quiz && status?.quizReport && <QuizResults report={status.quizReport} done={current.state==='completed'} disabled={busy||!loaded||!!pending} onAction={perform}/>}
              {quiz && !status?.evaluation && current.state==='in_progress' && step?.type==='question' &&
                <QuizQuestionCard step={step} first={current.stepIndex===0} last={current.stepIndex===total-1} value={effective?.type==='question'?effective.optionId:undefined}
                  disabled={busy||!loaded||!!pending} available={available} onAction={perform} validating={validating} validationFailed={notice==='Validation is unavailable.'}/>}
              {!quiz && step && current.state !== "completed" && (
                <Paper variant="outlined" sx={{ p: { xs: 2, md: 2.5 } }}>
                  <Stack spacing={2}>
                    <Typography variant="h5" component="h3">
                      {step.prompt}
                    </Typography>
                    {resultText && (
                      <Typography
                        variant="body2"
                        sx={{
                          borderLeft: 3,
                          borderColor: "primary.light",
                          pl: 1.25,
                        }}
                      >
                        Current result ·{" "}
                        {effective?.type === "action" &&
                        effective.status === "problem"
                          ? "Problem: "
                          : ""}
                        {resultText}
                      </Typography>
                    )}
                    {template.document.schemaVersion === 2 && canEditResult && (
                      <WorkerResultControls
                        step={step}
                        available={available}
                        disabled={busy || !loaded || !!pending}
                        selectedOption={selectedOption}
                        savedOption={
                          effective?.type === "question"
                            ? effective.optionId
                            : undefined
                        }
                        problem={problem}
                        reporting={reporting}
                        onReporting={(open) => {
                          setReporting(open);
                          if (!open) setProblem("");
                        }}
                        onSelectedOption={setSelectedOption}
                        onProblem={setProblem}
                        onAction={perform}
                      />
                    )}
                    {template.document.schemaVersion !== 2 && (
                      <>
                        {step.type === "question" &&
                          step.options.map((option) => (
                            <Typography key={option.id}>
                              {option.text}
                            </Typography>
                          ))}
                        <Alert severity="info">
                          Answer and task validation is not yet available.
                        </Alert>
                      </>
                    )}
                  </Stack>
                </Paper>
              )}
              {current.state === "completed" && (
                <Typography>Completed — read only</Typography>
              )}
              {!quiz && current.state === "completed" && pending && (
                <Button disabled={busy} onClick={() => perform(pending.action)}>
                  Reconcile {actionLabels[pending.action]}
                </Button>
              )}
              {!quiz && status?.evaluation && (
                <>
                  <Button onClick={() => setShowReport(!showReport)}>
                    {showReport ? "Hide Report" : "View Report"}
                  </Button>
                  {showReport && (
                    <Box aria-label="Worker report">
                      <Typography>
                        {status.evaluation.success ? "Passed" : "Errors found"}{" "}
                        · {status.evaluation.errorCount} errors
                      </Typography>
                      <Typography>{status.evaluation.reason}</Typography>
                      {status.evaluation.findings.map((finding) => (
                        <Typography key={finding.stepId}>
                          {template.document.steps.find(
                            (item) => item.id === finding.stepId,
                          )?.prompt ?? finding.stepId}
                          : {finding.passed ? "Passed" : "Error"} —{" "}
                          {finding.reason} ({finding.evidence})
                        </Typography>
                      ))}
                      {status.submissions?.map((item, index) => {
                        const effective = status.results?.some(
                          (result) =>
                            result?.stepId === item.stepId &&
                            result.visit === item.visit &&
                            result.attempt === item.attempt,
                        );
                        const source = template.document.steps[item.stepIndex],
                          result = item.result;
                        return (
                          <Typography
                            key={`${item.visit}-${item.attempt}-${index}`}
                            variant="body2"
                          >
                            {item.stepId} · visit {item.visit} · attempt{" "}
                            {item.attempt} · {effective ? "Current" : "Earlier"}
                            :{" "}
                            {result.type === "question"
                              ? source?.type === "question"
                                ? (source.options.find(
                                    (option) => option.id === result.optionId,
                                  )?.text ?? result.optionId)
                                : result.optionId
                              : result.status === "problem"
                                ? `Problem: ${result.reason}`
                                : "Completed"}
                          </Typography>
                        );
                      })}
                    </Box>
                  )}
                </>
              )}
            </>
          )}
        </Stack>
      </Box>
      <Paper
        variant="outlined"
        component="aside"
        aria-label="Worker session stats"
        sx={{ p: 2, bgcolor: "white" }}
      >
        <Typography variant="h6" component="h3" sx={{ mb: 2 }}>
          Session Stats
        </Typography>
        <Stack component="dl" spacing={1.5} divider={<Divider />} sx={{ m: 0 }}>
          {Object.entries({
            "Worker Template": template.name,
            "Total Steps": total,
            "Current Step": currentStep,
            Progress: percent === null ? "—" : `${percent}%`,
            Status: stateLabel,
          }).map(([label, value]) => (
            <Box key={label}>
              <Typography
                component="dt"
                variant="caption"
                color="text.secondary"
              >
                {label}
              </Typography>
              <Typography
                component="dd"
                variant="body2"
                fontWeight={650}
                sx={{ m: 0 }}
              >
                {value}
              </Typography>
              {label === "Progress" && percent !== null && (
                <LinearProgress
                  aria-label="Collected step progress"
                  variant="determinate"
                  value={percent}
                  sx={{ mt: 0.75 }}
                />
              )}
            </Box>
          ))}
        </Stack>
        {template.document.schemaVersion === 1 && template.rules && (
          <Typography variant="body2" sx={{ mt: 2, whiteSpace: "pre-wrap" }}>
            {template.rules}
          </Typography>
        )}
      </Paper>
      {!quiz && current.state !== "not_started" && current.state !== "completed" && (
        <Stack
          direction="row"
          alignItems="center"
          justifyContent="space-between"
          flexWrap="wrap"
          gap={1}
          sx={{
            gridColumn: "1 / -1",
            m: 1,
            bgcolor: "action.hover",
            border: 1,
            borderColor: "divider",
            p: 1.5,
            borderRadius: 1,
          }}
        >
          <Typography variant="body2">
            {step?.type === "question" && available.includes("submit")
              ? selectedOption
                ? "Submit your selected answer"
                : "Choose an answer to continue"
              : resolved === undefined
                ? "Loading progress…"
                : `${template.document.schemaVersion === 2 ? "Collected" : "Resolved"} ${resolved} of ${total} steps`}
          </Typography>
          {step?.type === "question" && canEditResult && (
            <Stack
              direction="row"
              spacing={1}
              role="group"
              aria-label="Answer shortcuts"
            >
              {step.options.map((option, index) => {
                const letter = String.fromCharCode(65 + index);
                const selected =
                  (selectedOption ||
                    (effective?.type === "question"
                      ? effective.optionId
                      : "")) === option.id;
                return (
                  <Button
                    key={option.id}
                    size="small"
                    sx={{
                      minWidth: 40,
                      bgcolor: selected ? "action.selected" : "white",
                    }}
                    variant="outlined"
                    aria-label={`Select ${letter}: ${option.text}`}
                    aria-pressed={selected}
                    disabled={busy || !loaded || !!pending}
                    onClick={() => setSelectedOption(option.id)}
                  >
                    {letter}
                  </Button>
                );
              })}
            </Stack>
          )}
          <WorkerControls
            available={available}
            disabled={busy || !loaded}
            pending={pending}
            retryValidation={notice === "Validation is unavailable."}
            onAction={(action) => perform(action)}
          />
        </Stack>
      )}
    </Paper>
  );
}
function readPending(id: string): WorkerActionCommand | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(`worker-start:${id}`) ?? 'null');
    if (value && typeof value.requestId === 'string' && Number.isSafeInteger(value.expectedRevision) && value.expectedRevision > 0 && ['start','next','back','retry','continue','complete','submit','correct','validate','quiz_next','quiz_back','try_again'].includes(value.action) && value.payload && typeof value.payload === 'object' && !Array.isArray(value.payload)) return value;
  } catch { /* No stored command is available. */ }
  return null;
}
