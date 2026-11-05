import React, { useRef, useState, useSyncExternalStore } from "react";
import {
  ThemeProvider,
  CssBaseline,
  Container,
  Box,
  Stack,
  Typography,
  Paper,
  Button,
  IconButton,
  Chip,
  TextField,
  MenuItem,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Alert,
  CircularProgress,
  Card,
  CardContent,
  CardActionArea,
  Tooltip,
  InputAdornment,
} from "@mui/material";
import SettingsOutlined from "@mui/icons-material/SettingsOutlined";
import Add from "@mui/icons-material/Add";
import ContentCopyOutlined from "@mui/icons-material/ContentCopyOutlined";
import { duplicateExpert } from "./duplicate-expert";
import DeleteOutline from "@mui/icons-material/DeleteOutline";
import Visibility from "@mui/icons-material/Visibility";
import VisibilityOff from "@mui/icons-material/VisibilityOff";
import Close from "@mui/icons-material/Close";
import ScienceOutlined from "@mui/icons-material/ScienceOutlined";
import CheckCircleOutline from "@mui/icons-material/CheckCircleOutline";
import { theme } from "./theme";
import {
  catalog,
  capabilities,
  resolveExpert,
  known,
  validSettings,
  settings,
  type Expert,
  type Run,
  type Attempt,
} from "./models";
import { respond, type Adapter } from "./openai";
import {
  architectInstructions,
  expertSchema,
  validateExperts,
} from "./generation";
import { createRun, Engine } from "./engine";
import { ConnectionController, connectionGuidance } from "./connection";
import { statusLabel } from "./labels";
import { ExpertConfigurationChips } from "./expert-configuration-chips";
import { ExpertRoleLabel } from "./expert-role-label";
import { RunView } from "./results";
import { usage, seconds } from "./result-format";
function ModelField({
  label,
  value,
  onChange,
  inherit = false,
  allowCustom = true,
}: {
  label: string;
  value: string;
  onChange: (s: string) => void;
  inherit?: boolean;
  allowCustom?: boolean;
}) {
  const custom =
    !!value && !catalog.includes(value as (typeof catalog)[number]);
  return (
    <Stack spacing={1}>
      <TextField
        select
        label={label}
        value={custom ? "custom" : inherit && !value ? "__default" : value}
        onChange={(e) =>
          onChange(
            e.target.value === "custom"
              ? "custom-model"
              : e.target.value === "__default"
                ? ""
                : e.target.value,
          )
        }
      >
        {inherit && <MenuItem value="__default">Use default</MenuItem>}
        {catalog.map((m) => (
          <MenuItem key={m} value={m}>
            {m}
          </MenuItem>
        ))}
        {allowCustom && <MenuItem value="custom">Custom model ID</MenuItem>}
      </TextField>
      {custom && (
        <TextField
          label="Custom model ID"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          helperText="Responses text only; reasoning omitted; limit 4,096 tokens. Compatibility unverified."
        />
      )}
    </Stack>
  );
}
function Section({
  title,
  children,
  tinted = false,
}: {
  title: string;
  children: React.ReactNode;
  tinted?: boolean;
}) {
  return (
    <Paper
      component="section"
      variant="outlined"
      sx={{
        p: { xs: 2, sm: 3 },
        bgcolor: tinted ? "#edf0db" : undefined,
        borderColor: "#e2e1d4",
      }}
    >
      <Typography variant="h5" component="h2" mb={2}>
        {title}
      </Typography>
      {children}
    </Paper>
  );
}
export function App({
  adapter = respond,
  controller,
}: {
  adapter?: Adapter;
  controller?: ConnectionController;
}) {
  const [connectionController] = useState(
    () => controller || new ConnectionController(),
  );
  const connectionState = useSyncExternalStore(
    connectionController.subscribe,
    connectionController.getSnapshot,
  );
  const { key, verification, attempts: verifyAttempts } = connectionState;
  const verifying = verification === "verifying";
  const guidance = connectionGuidance(connectionState);
  const [model, setModel] = useState<string>("gpt-5.6-terra");
  const [connection, setConnection] = useState(false);
  const [visible, setVisible] = useState(false);
  const [experts, setExperts] = useState<Expert[]>([]);
  const [teamText, setTeamText] = useState("");
  const [addText, setAddText] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<Expert | null>(null);
  const [generating, setGenerating] = useState<"team" | "single" | null>(null);
  const generationLock = useRef(false);
  const [generationAttempts, setGenerationAttempts] = useState<Attempt[]>([]);
  const [generationError, setGenerationError] = useState("");
  const [question, setQuestion] = useState("");
  const [reference, setReference] = useState("");
  const [runs, setRuns] = useState<Run[]>([]);
  const [runError, setRunError] = useState("");
  const [, redraw] = useState(0);
  const engine = useRef<Engine | null>(null);
  if (!engine.current)
    engine.current = new Engine(() => redraw((n) => n + 1), adapter);
  const active = !!engine.current.active;
  const connectionValid =
    !!key.trim() && !!capabilities(model)?.structuredOutput;
  const disabledReason = active
    ? "An experiment or retry is active."
    : !experts.length
      ? "Add at least one expert to enable running an experiment."
      : !question.trim() || !reference.trim()
        ? "Enter both a question and reference answer."
        : !connectionValid
          ? "Configure an API key and supported model."
          : experts.some((e) => !validSettings(resolveExpert(e, model)))
            ? "Check expert reasoning settings and output limits for their effective models."
            : "";
  const changeConfig = (fn: () => void) => {
    connectionController.invalidate();
    fn();
  };
  const verify = () => connectionController.verify(model, adapter);
  async function generate(single: boolean) {
    if (generationLock.current || !connectionValid || !known(model)) return;
    generationLock.current = true;
    setGenerating(single ? "single" : "team");
    setGenerationError("");
    const a = {
      id: crypto.randomUUID(),
      ...(await adapter(key, {
        settings: settings(model),
        instructions: architectInstructions(single),
        input: single ? addText : teamText,
        schema: expertSchema,
      })),
    };
    if (a.status === "succeeded") {
      try {
        const generated = validateExperts(a.text, single);
        if (single) {
          setExperts((v) => [...v, ...generated]);
          setAddOpen(false);
          setAddText("");
        } else setExperts(generated);
      } catch {
        a.status = "failed";
        a.error =
          "The Architect returned malformed expert data. Existing experts are unchanged; retry generation.";
      }
    }
    setGenerationAttempts((v) => [...v, a]);
    if (a.status !== "succeeded")
      setGenerationError(a.error || "Generation failed");
    setGenerating(null);
    generationLock.current = false;
  }
  function launch() {
    if (disabledReason || engine.current!.active) return;
    try {
      const run = createRun(question, reference, experts, model);
      setRuns((v) => [run, ...v]);
      setRunError("");
      void engine.current!.execute(run, connectionController.getKey);
    } catch {
      setRunError(
        "Check required inputs, expert settings, and the shared model.",
      );
    }
  }
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Container maxWidth="xl" sx={{ py: { xs: 2, sm: 4 } }}>
        <Paper
          component="header"
          variant="outlined"
          sx={{ p: 2.5, mb: 3, bgcolor: "#e3e7cb", borderColor: "#d9dec0" }}
        >
          <Stack direction="row" alignItems="center" gap={2} flexWrap="wrap">
            <Typography variant="h4" component="h1">
              Expert Lab
            </Typography>
            <Typography color="text.secondary">Week 1 · Day 3</Typography>
            <Stack
              direction="row"
              alignItems="center"
              gap={0.5}
              sx={{ ml: "auto" }}
            >
              <Chip
                icon={
                  verification === "verified" ? (
                    <CheckCircleOutline />
                  ) : undefined
                }
                label={
                  verification === "verified" ? "Connected" : "Not verified"
                }
                variant="outlined"
              />
              <Tooltip title="Connection settings">
                <IconButton
                  aria-label="Connection settings"
                  onClick={() => setConnection(true)}
                >
                  <SettingsOutlined />
                </IconButton>
              </Tooltip>
            </Stack>
          </Stack>
          {guidance && (
            <Stack
              direction={{ xs: "column", sm: "row" }}
              alignItems={{ xs: "flex-start", sm: "center" }}
              gap={0.5}
              sx={{ mt: 1 }}
            >
              <Typography
                role="status"
                aria-live="polite"
                variant="body2"
                sx={{ minWidth: 0, overflowWrap: "anywhere" }}
              >
                {guidance}
              </Typography>
              <Button
                size="small"
                sx={{ flexShrink: 0 }}
                onClick={() => setConnection(true)}
              >
                Open settings
              </Button>
            </Stack>
          )}
          {connectionState.error && (
            <Typography role="alert" variant="body2" sx={{ mt: 0.5 }}>
              {connectionState.error}
            </Typography>
          )}
          {connectionState.storageWarning && (
            <Typography role="status" variant="body2" sx={{ mt: 0.5 }}>
              {connectionState.storageWarning}
            </Typography>
          )}
        </Paper>
        <Stack spacing={3}>
          <Section title="Architect" tinted>
            <Typography mb={2} color="text.secondary">
              Create your expert team. Generating a team replaces the current
              team; previous runs stay intact.
            </Typography>
            <Stack
              direction={{ xs: "column", md: "row" }}
              spacing={2}
              alignItems="flex-start"
            >
              <TextField
                label="Team description"
                multiline
                minRows={3}
                maxRows={8}
                sx={{
                  minWidth: 0,
                  "& textarea": {
                    overflowWrap: "anywhere",
                    wordBreak: "break-word",
                    overflowX: "hidden",
                  },
                }}
                value={teamText}
                onChange={(e) => setTeamText(e.target.value)}
              />
              <Button
                variant="contained"
                sx={{ minWidth: 160, flexShrink: 0, py: 1.4 }}
                disabled={
                  !!generating ||
                  !teamText.trim() ||
                  !connectionValid ||
                  !known(model)
                }
                onClick={() => void generate(false)}
              >
                {generating === "team" ? (
                  <>
                    <CircularProgress size={18} sx={{ mr: 1 }} />
                    Generating…
                  </>
                ) : (
                  "Generate team"
                )}
              </Button>
            </Stack>
            {!known(model) && (
              <Alert severity="info" sx={{ mt: 2 }}>
                Choose a catalog default model for structured Architect
                generation.
              </Alert>
            )}
            {!key.trim() && (
              <Typography variant="body2" mt={1}>
                Open connection settings to enter your API key.
              </Typography>
            )}
            {generationError && (
              <Alert severity="error" sx={{ mt: 2 }}>
                {generationError}
              </Alert>
            )}
            {generationAttempts.length > 0 && (
              <Typography variant="body2" mt={2}>
                Architect usage (all attempts): {usage(generationAttempts)} ·{" "}
                {seconds(generationAttempts.reduce((n, a) => n + a.ms, 0))}
              </Typography>
            )}
          </Section>
          <Section title={`Experts · ${experts.length}`}>
            <Box
              sx={{
                display: "grid",
                gridTemplateColumns:
                  "repeat(auto-fill, minmax(min(100%, 250px), 1fr))",
                gap: 2,
              }}
            >
              {experts.map((e) => (
                <Card key={e.id}>
                  <CardContent>
                    <Stack direction="row" alignItems="center">
                      <Box sx={{ flex: 1, minWidth: 0 }}>
                        <Typography
                          variant="h6"
                          sx={{ overflowWrap: "anywhere" }}
                        >
                          {e.name}
                        </Typography>
                        <ExpertRoleLabel roleLabel={e.roleLabel} />
                      </Box>
                      <Tooltip title={`Edit ${e.name}`}>
                        <IconButton
                          aria-label={`Edit ${e.name}`}
                          onClick={() => setEditing(structuredClone(e))}
                        >
                          <SettingsOutlined fontSize="small" />
                        </IconButton>
                      </Tooltip>
                      <Tooltip title="Duplicate expert">
                        <IconButton
                          aria-label={`Duplicate expert ${e.name}`}
                          onClick={() =>
                            setExperts((current) =>
                              duplicateExpert(current, e.id),
                            )
                          }
                        >
                          <ContentCopyOutlined fontSize="small" />
                        </IconButton>
                      </Tooltip>
                      <Tooltip title={`Delete ${e.name}`}>
                        <IconButton
                          aria-label={`Delete ${e.name}`}
                          onClick={() =>
                            setExperts((v) => v.filter((x) => x.id !== e.id))
                          }
                        >
                          <DeleteOutline fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    </Stack>
                    <Typography sx={{ my: 2, overflowWrap: "anywhere" }}>
                      {e.description}
                    </Typography>
                    <ExpertConfigurationChips expert={e} defaultModel={model} />
                  </CardContent>
                </Card>
              ))}
              <Card
                variant="outlined"
                sx={{
                  border: "1px dashed #606d29",
                  minHeight: 200,
                  boxShadow: "none",
                }}
              >
                <CardActionArea
                  disabled={!!generating}
                  onClick={() => {
                    setGenerationError("");
                    setAddOpen(true);
                  }}
                  sx={{ height: "100%", p: 3, textAlign: "center" }}
                >
                  <Add
                    sx={{
                      fontSize: 44,
                      bgcolor: "#e9edce",
                      borderRadius: "50%",
                      p: 1,
                    }}
                  />
                  <Typography variant="h6">Add expert</Typography>
                  {!experts.length && (
                    <Typography color="text.secondary">
                      Create your first expert to run an experiment
                    </Typography>
                  )}
                </CardActionArea>
              </Card>
            </Box>
            <Typography variant="body2" color="text.secondary" mt={2}>
              Add or remove experts. Previous runs keep their original team.
            </Typography>
          </Section>
          <Section title="Experiment" tinted>
            <Stack direction={{ xs: "column", md: "row" }} spacing={2}>
              <TextField
                label="Question"
                multiline
                minRows={3}
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
              />
              <TextField
                label="Reference answer"
                multiline
                minRows={3}
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                helperText="Reserved for evaluation; never sent to participants."
              />
            </Stack>
            <Button
              variant="contained"
              startIcon={<ScienceOutlined />}
              sx={{ mt: 2 }}
              disabled={!!disabledReason}
              onClick={launch}
            >
              Run experiment
            </Button>
            {disabledReason && (
              <Typography variant="body2" mt={1}>
                {disabledReason}
              </Typography>
            )}
            {runError && <Alert severity="error">{runError}</Alert>}
          </Section>
          <Section title="Results / run history">
            {!runs.length ? (
              <Box sx={{ py: 5, textAlign: "center" }}>
                <ScienceOutlined
                  sx={{ fontSize: 48, color: "text.secondary" }}
                />
                <Typography>No runs yet.</Typography>
              </Box>
            ) : (
              <Stack spacing={3}>
                {runs.map((run) => (
                  <RunView
                    key={run.id}
                    run={run}
                    disabled={active || !key.trim()}
                    refresh={() => redraw((n) => n + 1)}
                    retry={(index) =>
                      void engine.current!.execute(
                        run,
                        connectionController.getKey,
                        index,
                      )
                    }
                    retryEvaluation={() =>
                      void engine.current!.execute(
                        run,
                        connectionController.getKey,
                        undefined,
                        true,
                      )
                    }
                  />
                ))}
              </Stack>
            )}
          </Section>
          <Typography variant="body2" color="text.secondary" textAlign="center">
            Experts and history reset on reload. The key is retained in this
            tab’s sessionStorage when available; verification resets. Requests
            go directly to OpenAI. Verification and retries may consume tokens.
          </Typography>
        </Stack>
        <Dialog
          open={connection}
          onClose={() => {
            setConnection(false);
            setVisible(false);
          }}
          fullWidth
          maxWidth="sm"
        >
          <DialogTitle>
            Connection settings
            <IconButton
              aria-label="Close connection settings"
              onClick={() => {
                setConnection(false);
                setVisible(false);
              }}
              sx={{ float: "right" }}
            >
              <Close />
            </IconButton>
          </DialogTitle>
          <DialogContent>
            <Stack spacing={2} sx={{ pt: 1 }}>
              <Typography>Provider: OpenAI</Typography>
              <TextField
                label="API key"
                type={visible ? "text" : "password"}
                value={key}
                onChange={(e) => connectionController.updateKey(e.target.value)}
                autoComplete="off"
                slotProps={{
                  input: {
                    endAdornment: (
                      <InputAdornment position="end">
                        <IconButton
                          aria-label={visible ? "Hide API key" : "Show API key"}
                          onClick={() => setVisible((v) => !v)}
                        >
                          {visible ? <VisibilityOff /> : <Visibility />}
                        </IconButton>
                      </InputAdornment>
                    ),
                  },
                }}
                helperText={
                  connectionState.storageWarning
                    ? "The key is available in page memory only."
                    : "The key is retained in this tab’s sessionStorage. It is not a secure vault."
                }
              />
              <Button
                variant="text"
                onClick={() => {
                  connectionController.forget();
                  setVisible(false);
                }}
              >
                Forget key
              </Button>
              <Typography variant="body2">
                Removes the key from the app and sessionStorage. Requests
                already sent are not canceled.
              </Typography>
              {connectionState.storageWarning && (
                <Alert severity="warning">
                  {connectionState.storageWarning}
                </Alert>
              )}
              <ModelField
                label="Model"
                allowCustom={false}
                value={model}
                onChange={(v) => changeConfig(() => setModel(v))}
              />
              <Typography variant="body2">
                Used for verification, expert generation, evaluation, and as the
                default for experts.
              </Typography>
              <Button
                variant="outlined"
                onClick={() => void verify()}
                disabled={verifying || !key.trim() || !model.trim()}
              >
                {verifying ? (
                  <>
                    <CircularProgress size={16} sx={{ mr: 1 }} />
                    Verifying…
                  </>
                ) : (
                  "Verify"
                )}
              </Button>
              <Alert
                severity={
                  verification === "verified"
                    ? "success"
                    : verification === "unverified" || verifying
                      ? "info"
                      : "error"
                }
              >
                {verification === "verified"
                  ? "Key verified"
                  : verifying
                    ? "Verifying connection..."
                    : connectionState.error || "Key not verified"}
              </Alert>
              {verifyAttempts.length > 0 && (
                <Typography variant="body2">
                  Verification usage: {usage(verifyAttempts)} ·{" "}
                  {seconds(verifyAttempts.reduce((n, a) => n + a.ms, 0))}
                </Typography>
              )}
              <Alert severity="info">
                Verification makes a minimal real request and may be billable.
                Model availability depends on your OpenAI project permissions.
              </Alert>
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button
              variant="contained"
              onClick={() => {
                setConnection(false);
                setVisible(false);
              }}
            >
              Done
            </Button>
          </DialogActions>
        </Dialog>
        <Dialog
          open={addOpen}
          onClose={() => {
            if (!generating) setAddOpen(false);
          }}
          fullWidth
          maxWidth="sm"
        >
          <DialogTitle>
            Add expert
            <IconButton
              aria-label="Close add expert"
              disabled={!!generating}
              onClick={() => setAddOpen(false)}
              sx={{ float: "right" }}
            >
              <Close />
            </IconButton>
          </DialogTitle>
          <DialogContent>
            <TextField
              autoFocus
              sx={{ mt: 1 }}
              label="Who would you like to add?"
              multiline
              minRows={3}
              value={addText}
              onChange={(e) => setAddText(e.target.value)}
              helperText="The Architect generates a name, role label, description, and role prompt."
            />
            {generationError && (
              <Alert severity="error" sx={{ mt: 2 }}>
                {generationError}
              </Alert>
            )}
            {!connectionValid || !known(model) ? (
              <Alert severity="info" sx={{ mt: 2 }}>
                Configure an API key and catalog default model first.
              </Alert>
            ) : null}
          </DialogContent>
          <DialogActions>
            <Button disabled={!!generating} onClick={() => setAddOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="contained"
              disabled={
                !!generating ||
                !addText.trim() ||
                !connectionValid ||
                !known(model)
              }
              onClick={() => void generate(true)}
            >
              {generating ? "Generating…" : "Create expert"}
            </Button>
          </DialogActions>
        </Dialog>
        <Dialog
          open={!!editing}
          onClose={() => setEditing(null)}
          fullWidth
          maxWidth="sm"
        >
          <DialogTitle>
            Expert settings
            <IconButton
              aria-label="Close expert settings"
              onClick={() => setEditing(null)}
              sx={{ float: "right" }}
            >
              <Close />
            </IconButton>
          </DialogTitle>
          {editing && (
            <>
              <DialogContent>
                <Stack spacing={2} sx={{ pt: 1 }}>
                  <TextField
                    autoFocus
                    label="Name"
                    value={editing.name}
                    onChange={(e) =>
                      setEditing({ ...editing, name: e.target.value })
                    }
                  />
                  <TextField
                    label="Role label"
                    value={editing.roleLabel ?? ""}
                    helperText="Short role title. You can leave this empty."
                    onChange={(e) =>
                      setEditing({ ...editing, roleLabel: e.target.value })
                    }
                  />
                  <TextField
                    label="Description"
                    multiline
                    minRows={2}
                    value={editing.description}
                    onChange={(e) =>
                      setEditing({ ...editing, description: e.target.value })
                    }
                  />
                  <TextField
                    label="Role prompt"
                    multiline
                    minRows={4}
                    value={editing.rolePrompt}
                    onChange={(e) =>
                      setEditing({ ...editing, rolePrompt: e.target.value })
                    }
                  />
                  <ModelField
                    label="Model override"
                    value={editing.model}
                    inherit
                    onChange={(v) =>
                      setEditing({
                        ...editing,
                        model: v,
                        reasoning: capabilities(v || model)?.defaultReasoning,
                        maxTokens: Math.min(
                          editing.maxTokens,
                          capabilities(v || model)?.maxOutputTokens ?? 4096,
                        ),
                      })
                    }
                  />
                  {!!capabilities(editing.model || model)?.reasoningEfforts
                    .length && (
                    <TextField
                      select
                      label="Reasoning"
                      error={
                        !!editing.reasoning &&
                        !capabilities(
                          editing.model || model,
                        )?.reasoningEfforts.includes(editing.reasoning)
                      }
                      helperText={
                        editing.reasoning &&
                        !capabilities(
                          editing.model || model,
                        )?.reasoningEfforts.includes(editing.reasoning)
                          ? "Choose a reasoning level supported by the selected model."
                          : undefined
                      }
                      value={
                        editing.reasoning ||
                        capabilities(editing.model || model)
                          ?.defaultReasoning ||
                        ""
                      }
                      onChange={(e) =>
                        setEditing({ ...editing, reasoning: e.target.value })
                      }
                    >
                      {editing.reasoning &&
                        !capabilities(
                          editing.model || model,
                        )?.reasoningEfforts.includes(editing.reasoning) && (
                          <MenuItem value={editing.reasoning} disabled>
                            {statusLabel(editing.reasoning)} (unsupported for
                            selected model)
                          </MenuItem>
                        )}
                      {capabilities(
                        editing.model || model,
                      )!.reasoningEfforts.map((v) => (
                        <MenuItem key={v} value={v}>
                          {statusLabel(v)}
                        </MenuItem>
                      ))}
                    </TextField>
                  )}
                  <TextField
                    label="Output token limit"
                    type="number"
                    value={editing.maxTokens}
                    onChange={(e) =>
                      setEditing({
                        ...editing,
                        maxTokens: Number(e.target.value),
                      })
                    }
                    helperText={`16–${(capabilities(editing.model || model)?.maxOutputTokens ?? 4096).toLocaleString("en-US")} tokens; includes reasoning tokens when applicable.`}
                  />
                </Stack>
              </DialogContent>
              <DialogActions>
                <Button onClick={() => setEditing(null)}>Cancel</Button>
                <Button
                  variant="contained"
                  disabled={
                    !editing.name.trim() ||
                    !editing.description.trim() ||
                    !editing.rolePrompt.trim() ||
                    !validSettings(resolveExpert(editing, model))
                  }
                  onClick={() => {
                    setExperts((v) =>
                      v.map((e) =>
                        e.id === editing.id ? structuredClone(editing) : e,
                      ),
                    );
                    setEditing(null);
                  }}
                >
                  Save
                </Button>
              </DialogActions>
            </>
          )}
        </Dialog>
      </Container>
    </ThemeProvider>
  );
}
