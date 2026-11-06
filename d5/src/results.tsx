import { useState } from "react";
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  LinearProgress,
  MenuItem,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from "@mui/material";
import { alpha } from "@mui/material/styles";
import Close from "@mui/icons-material/Close";
import ExpandMore from "@mui/icons-material/ExpandMore";
import {
  last,
  evaluationRequested,
  type Judgment,
  type Result,
  type Run,
  type Verdict,
} from "./models";
import { statusLabel } from "./labels";
import { formatTokens, seconds } from "./result-format";
import { ExpertRoleLabel } from "./expert-role-label";
import {
  technicalExplanation,
  verdictExplanation,
} from "./result-explanations";
import { ResultBadge } from "./result-badge";
import { AnswerDialog } from "./answer-dialog";
import { AnswerPreview } from "./answer-preview";
import { ExecutionParametersReport } from "./execution-parameters-report";
import { AnswerMarkdown } from "./answer-markdown";
import { ResultMetadata, resultHeadingStyle } from "./result-metadata";

const fullText = {
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
  minWidth: 0,
} as const;
const visibleFocus = {
  "&:focus-visible, &.Mui-focusVisible": {
    outline: "2px solid",
    outlineColor: "primary.dark",
    outlineOffset: 3,
  },
};

function AttemptHistory({ result }: { result: Result }) {
  return (
    <Accordion defaultExpanded={false} disableGutters elevation={0}>
      <AccordionSummary expandIcon={<ExpandMore />}>
        <Typography
          component="span"
          variant="subtitle1"
          sx={resultHeadingStyle}
        >
          Attempt history · {result.attempts.length}
        </Typography>
      </AccordionSummary>
      <AccordionDetails>
        <Stack spacing={2}>
          {!result.attempts.length && <Typography>No attempts yet.</Typography>}
          {result.attempts.map((attempt, index) => (
            <Paper
              key={attempt.id}
              variant="outlined"
              sx={{ p: 1.5, minWidth: 0 }}
            >
              <Typography
                variant="subtitle2"
                sx={{ ...resultHeadingStyle, mb: 1 }}
              >
                Attempt {index + 1} · {statusLabel(attempt.status)}
              </Typography>
              <ResultMetadata
                result={result}
                attempt={attempt}
                includeTotals={false}
                labelPrefix={`Attempt ${index + 1}`}
              />
              <Box sx={{ mt: 2 }}>
                <ExecutionParametersReport
                  parameters={attempt.executionParameters}
                />
              </Box>
              {attempt.error && (
                <Alert
                  severity="error"
                  sx={{ my: 1, overflowWrap: "anywhere" }}
                >
                  {attempt.error}
                </Alert>
              )}
              {attempt.text && (
                <Box sx={{ mt: 1.5 }}>
                  <AnswerMarkdown text={attempt.text} />
                </Box>
              )}
              {attempt.manual && (
                <Typography variant="body2">
                  Manual verdict: {statusLabel(attempt.manual)}
                </Typography>
              )}
            </Paper>
          ))}
        </Stack>
      </AccordionDetails>
    </Accordion>
  );
}

export function ParticipantDetails({
  run,
  result,
  judgment,
  disabled,
  refresh,
  retry,
}: {
  run: Run;
  result: Result;
  judgment?: Judgment;
  disabled: boolean;
  refresh: () => void;
  retry: () => void;
}) {
  const attempt = last(result.attempts);
  return (
    <Stack spacing={3} sx={{ minWidth: 0 }}>
      <Chip
        label={`Technical status: ${statusLabel(attempt?.status || "pending")}`}
        variant="outlined"
        sx={{ alignSelf: "flex-start", maxWidth: "100%" }}
      />
      {attempt?.error && (
        <Alert severity="error" sx={{ overflowWrap: "anywhere" }}>
          {attempt.error}
        </Alert>
      )}
      <Box component="section" sx={{ minWidth: 0 }}>
        <Typography
          variant="subtitle1"
          component="h3"
          sx={{ ...resultHeadingStyle, mb: 1 }}
        >
          Full answer
        </Typography>
        {attempt?.text ? (
          <AnswerMarkdown text={attempt.text} />
        ) : (
          <Typography>No answer available.</Typography>
        )}
      </Box>
      <Box component="section" sx={{ minWidth: 0 }}>
        <Typography
          variant="subtitle1"
          component="h3"
          sx={{ ...resultHeadingStyle, mb: 1 }}
        >
          Captured role prompt
        </Typography>
        <Typography sx={fullText}>{result.expert.rolePrompt}</Typography>
      </Box>
      <Box component="section" sx={{ minWidth: 0 }}>
        <Typography
          variant="subtitle1"
          component="h3"
          sx={{ ...resultHeadingStyle, mb: 1 }}
        >
          Model and captured execution settings
        </Typography>
        <ResultMetadata result={result} attempt={attempt} />
      </Box>
      <ExecutionParametersReport parameters={attempt?.executionParameters} />
      {evaluationRequested(run) && (
        <Box component="section" sx={{ minWidth: 0 }}>
          <Typography
            variant="subtitle1"
            component="h3"
            sx={{ ...resultHeadingStyle, mb: 1 }}
          >
            AI evaluation
          </Typography>
          {run.evaluationStatus === "stale" && (
            <Alert severity="info">
              Previous AI evaluations are stale while the participant retry is
              pending.
            </Alert>
          )}
          {run.evaluationStatus === "running" && (
            <Alert severity="info">
              Evaluation is in progress. Previous AI verdicts are not current.
            </Alert>
          )}
          {run.evaluationStatus === "failed" && (
            <Alert severity="warning">
              Evaluation failed. Previous AI verdicts are not current; answers
              are preserved.
            </Alert>
          )}
          <Typography sx={{ overflowWrap: "anywhere" }}>
            {judgment
              ? `${statusLabel(judgment.verdict)} — ${judgment.explanation}`
              : "No current evaluation."}
          </Typography>
          {attempt?.status === "succeeded" && (
            <TextField
              select
              label="Manual verdict override (this answer attempt)"
              sx={{ mt: 2 }}
              value={attempt.manual || "none"}
              onChange={(event) => {
                attempt.manual = (
                  event.target.value === "none" ? undefined : event.target.value
                ) as Verdict | undefined;
                refresh();
              }}
            >
              <MenuItem value="none">No manual override</MenuItem>
              {["correct", "incorrect", "unable_to_assess"].map((verdict) => (
                <MenuItem key={verdict} value={verdict}>
                  {statusLabel(verdict)}
                </MenuItem>
              ))}
            </TextField>
          )}
        </Box>
      )}
      {attempt &&
        attempt.status !== "succeeded" &&
        attempt.status !== "running" && (
          <Button
            variant="outlined"
            disabled={disabled}
            onClick={retry}
            sx={{ alignSelf: "flex-start" }}
          >
            Retry this participant
          </Button>
        )}
      <AttemptHistory result={result} />
    </Stack>
  );
}

export function RunView({
  run,
  disabled,
  refresh,
  retry,
  retryEvaluation,
}: {
  run: Run;
  disabled: boolean;
  refresh: () => void;
  retry: (index: number) => void;
  retryEvaluation: () => void;
}) {
  const [selectedResultId, setSelectedResultId] = useState<string | null>(null);
  const [answerResultId, setAnswerResultId] = useState<string | null>(null);
  const answerResult = run.results.find(
    (result) => result.id === answerResultId,
  );
  const selectedIndex = run.results.findIndex(
    (result) => result.id === selectedResultId,
  );
  const selected = run.results[selectedIndex];
  const completed = run.results.filter(
    (result) =>
      last(result.attempts) && last(result.attempts)!.status !== "running",
  ).length;
  const succeeded = run.results.filter(
    (result) => last(result.attempts)?.status === "succeeded",
  ).length;
  const currentEvaluation =
    run.evaluationStatus === "completed" ? last(run.evaluations) : undefined;
  const dialogTitleId = `result-dialog-title-${run.id}`;
  return (
    <Paper variant="outlined" sx={{ p: 2, minWidth: 0 }}>
      <Stack
        direction="row"
        alignItems="baseline"
        spacing={1.5}
        flexWrap="wrap"
      >
        <Typography
          variant="subtitle1"
          fontWeight={700}
          component="h3"
          title={run.id}
        >
          Run {run.id.slice(0, 8)}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {new Date(run.started).toLocaleString("en-US")}
        </Typography>
      </Stack>
      <Box role="status" aria-live="polite" my={1}>
        <Typography variant="body2">
          {completed} of {run.results.length} finished · {succeeded} succeeded ·
          Evaluation: {statusLabel(run.evaluationStatus)}
        </Typography>
        {run.busy && (
          <LinearProgress
            aria-label="Participant operations finished"
            variant="determinate"
            value={(100 * completed) / run.results.length}
            sx={{ mt: 1 }}
          />
        )}
      </Box>
      {completed > succeeded && (
        <Alert severity="warning" sx={{ mb: 1 }}>
          Partial failure: {completed - succeeded} participants did not produce
          a complete answer. Successful answers are preserved.
        </Alert>
      )}
      {run.evaluationStatus === "skipped" && (
        <Alert severity="info">No successful answers to evaluate</Alert>
      )}
      {run.evaluationStatus === "stale" && (
        <Alert severity="info">
          Previous AI evaluations are stale while the participant retry is
          pending.
        </Alert>
      )}
      {run.evaluationStatus === "failed" && (
        <Alert
          severity="error"
          action={
            <Button disabled={disabled} onClick={retryEvaluation}>
              Retry evaluation
            </Button>
          }
        >
          {last(run.evaluations)?.error || "Evaluation failed"}. Answers saved;
          previous verdicts are not current.
        </Alert>
      )}
      <TableContainer
        sx={{ mt: 1, overflowX: "auto" }}
        tabIndex={0}
        aria-label="Scrollable participant results"
        role="region"
      >
        <Table
          size="small"
          aria-label="Participant results"
          sx={{
            tableLayout: "fixed",
            minWidth: "70rem",
            "& td": {
              textAlign: "center",
              verticalAlign: "middle",
              overflowWrap: "anywhere",
              px: 1.5,
              py: 1.25,
            },
            "& tbody tr:last-child td": { borderBottom: 0 },
            "& td:first-of-type": { textAlign: "left", verticalAlign: "top" },
            "& td:nth-of-type(4)": { textAlign: "left" },
            "& td:nth-of-type(5), & td:nth-of-type(6), & td:nth-of-type(7)": {
              fontVariantNumeric: "tabular-nums",
              whiteSpace: "nowrap",
            },
          }}
        >
          <colgroup>
            <col style={{ width: "9rem" }} />
            <col style={{ width: "8rem" }} />
            <col style={{ width: "8rem" }} />
            <col />
            <col style={{ width: "6.5rem" }} />
            <col style={{ width: "6.5rem" }} />
            <col style={{ width: "6.5rem" }} />
            {evaluationRequested(run) && <col style={{ width: "9rem" }} />}
          </colgroup>
          <TableHead
            sx={{
              bgcolor: (theme) => alpha(theme.palette.primary.main, 0.1),
              "& th": {
                fontWeight: 700,
                color: "primary.dark",
                borderBottom: "2px solid",
                borderColor: (theme) => alpha(theme.palette.primary.main, 0.35),
                px: 1.5,
                py: 1.25,
                textAlign: "center",
                verticalAlign: "middle",
              },
            }}
          >
            <TableRow>
              {[
                "Expert",
                "Actual model",
                "Technical status",
                "Answer",
                "Input tokens",
                "Output tokens",
                "Request time",
                ...(evaluationRequested(run) ? ["Verdict"] : []),
              ].map((label) => (
                <TableCell key={label} align="center">
                  {["Input tokens", "Output tokens", "Request time"].includes(
                    label,
                  ) ? (
                    <>
                      {label.split(" ")[0]}
                      <br />
                      {label.split(" ")[1]}
                    </>
                  ) : (
                    label
                  )}
                </TableCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {run.results.map((result) => {
              const attempt = last(result.attempts);
              const judgment = currentEvaluation?.judgments?.find(
                (item) => item.resultId === result.id,
              );
              return (
                <TableRow key={result.id}>
                  <TableCell
                    role="button"
                    tabIndex={0}
                    aria-label={`View result for ${result.expert.name}`}
                    aria-haspopup="dialog"
                    onClick={() => setSelectedResultId(result.id)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setSelectedResultId(result.id);
                      }
                    }}
                    sx={{
                      cursor: "pointer",
                      "&:hover": {
                        bgcolor: (theme) =>
                          alpha(theme.palette.primary.main, 0.06),
                      },
                      ...visibleFocus,
                    }}
                  >
                    <Box sx={{ maxWidth: 180 }}>
                      <Typography
                        component="span"
                        sx={{
                          display: "block",
                          color: "primary.dark",
                          fontWeight: 650,
                          fontSize: "0.8125rem",
                          overflowWrap: "anywhere",
                        }}
                      >
                        {result.expert.name}
                      </Typography>
                      <ExpertRoleLabel roleLabel={result.expert.roleLabel} />
                    </Box>
                  </TableCell>
                  <TableCell>
                    {attempt?.actualModel || result.expert.model}
                  </TableCell>
                  <TableCell>
                    <ResultBadge
                      value={attempt?.status || "pending"}
                      explanation={technicalExplanation(attempt)}
                    />
                  </TableCell>
                  <TableCell>
                    <AnswerPreview
                      text={attempt?.text || ""}
                      expertName={result.expert.name}
                      onMore={() => setAnswerResultId(result.id)}
                    />
                  </TableCell>
                  <TableCell
                    align="center"
                    sx={{ fontVariantNumeric: "tabular-nums" }}
                  >
                    {formatTokens(attempt?.usage?.input)}
                  </TableCell>
                  <TableCell
                    align="center"
                    sx={{ fontVariantNumeric: "tabular-nums" }}
                  >
                    {formatTokens(attempt?.usage?.output)}
                  </TableCell>
                  <TableCell
                    align="center"
                    sx={{ fontVariantNumeric: "tabular-nums" }}
                  >
                    {attempt?.status === "running"
                      ? "Running"
                      : attempt
                        ? seconds(attempt.ms)
                        : "—"}
                  </TableCell>
                  {evaluationRequested(run) && (
                    <TableCell>
                      <ResultBadge
                        automated
                        explanation={verdictExplanation(
                          run.evaluationStatus,
                          judgment,
                        )}
                        value={
                          judgment?.verdict ??
                          (run.evaluationStatus === "stale"
                            ? "stale"
                            : ["pending", "running"].includes(
                                  run.evaluationStatus,
                                )
                              ? run.evaluationStatus
                              : "Not available")
                        }
                      />
                      {attempt?.manual && (
                        <Box sx={{ mt: 0.5 }}>
                          <ResultBadge
                            manual
                            value={attempt.manual}
                            explanation="This verdict was set manually for this answer attempt. It is separate from the AI evaluation and its explanation."
                          />
                        </Box>
                      )}
                    </TableCell>
                  )}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableContainer>
      <AnswerDialog
        key={answerResultId ?? "closed"}
        open={!!answerResult}
        text={last(answerResult?.attempts ?? [])?.text ?? ""}
        onClose={() => setAnswerResultId(null)}
      />
      <Dialog
        open={!!selected}
        onClose={() => setSelectedResultId(null)}
        aria-labelledby={dialogTitleId}
        fullWidth
        maxWidth="md"
        scroll="paper"
        slotProps={{
          paper: {
            sx: {
              m: { xs: 1, sm: 4 },
              width: { xs: "calc(100% - 16px)", sm: "calc(100% - 64px)" },
              maxHeight: "calc(100% - 32px)",
            },
          },
        }}
      >
        <DialogTitle
          id={dialogTitleId}
          sx={{ display: "flex", alignItems: "center", gap: 1 }}
        >
          <Box
            component="span"
            sx={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}
          >
            {selected?.expert.name} — Result details
            <ExpertRoleLabel roleLabel={selected?.expert.roleLabel} />
          </Box>
          <IconButton
            autoFocus
            aria-label="Close participant details"
            onClick={() => setSelectedResultId(null)}
          >
            <Close />
          </IconButton>
        </DialogTitle>
        <DialogContent dividers sx={{ minWidth: 0 }}>
          {selected && (
            <ParticipantDetails
              key={selected.id}
              run={run}
              result={selected}
              judgment={currentEvaluation?.judgments?.find(
                (item) => item.resultId === selected.id,
              )}
              disabled={disabled}
              refresh={refresh}
              retry={() => retry(selectedIndex)}
            />
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setSelectedResultId(null)}>Close</Button>
        </DialogActions>
      </Dialog>
    </Paper>
  );
}
