import { expertEditDraft, generationModelFor, selectExpertProvider } from "./interaction-safety";
import { initialLabTab, type LabTab } from "./navigation";
import { expertSettingsError } from "./expert-settings-validation";
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
  Tabs,
  Tab,
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
import { theme } from "./theme";
import {
  resolveExpert,
  type Expert,
  type Run,
  type Attempt,
  type Settings,
} from "./models";
import { settings } from "./openai-model-compat";
import { respond, type Adapter } from "./openai";
import { generateWithProvider, validateExperts } from "./generation";
import { createRun, Engine } from "./legacy-engine";
import { ConfigurationError, configurationProblem } from "./engine";
import { ConnectionController } from "./connection";
import { ProviderStatus } from "./provider-status";
import {
  createProviderRegistry,
  type ProviderRegistry,
} from "./provider-registry";
import { ParameterEditor } from "./parameter-editor";
import { Providers } from "./providers";
import { BuiltinConnectionSettings, type OpenCodeConnection, type OpenCodeKeys } from "./builtin-connection-settings";
import { statusLabel } from "./labels";
import { ExpertConfigurationChips } from "./expert-configuration-chips";
import { ExpertRoleLabel } from "./expert-role-label";
import { RunView } from "./results";
import { usage, seconds } from "./result-format";
export function ModelField({
  label,
  value,
  onChange,
  providerId,
  registry,
  inherit = false,
  allowCustom = true,
}: {
  label: string;
  value: string;
  onChange: (s: string) => void;
  providerId?: string;
  registry: ProviderRegistry;
  inherit?: boolean;
  allowCustom?: boolean;
}) {
  const provider = providerId ? registry.get(providerId) : undefined;
  const options = registry.modelOptionsFor(providerId);
  const [customEditing, setCustomEditing] = useState(false);
  const custom = customEditing || (!!value && !options.includes(value));
  return (
    <Stack spacing={1}>
      <TextField
        select
        label={label}
        value={
          custom
            ? "__custom"
            : inherit && !value
              ? "__default"
              : value || "__none"
        }
        onChange={(event) => {
          if (event.target.value === "__custom") {
            setCustomEditing(true);
            return;
          }
          setCustomEditing(false);
          if (event.target.value !== "__none")
            onChange(
              event.target.value === "__default" ? "" : event.target.value,
            );
        }}
        helperText={
          !provider
            ? "Select a provider first."
            : !options.length
              ? "No discovered models available for this provider."
              : undefined
        }
      >
        {inherit && <MenuItem value="__default">Use default</MenuItem>}
        {!value && !inherit && (
          <MenuItem value="__none" disabled>
            Select a model
          </MenuItem>
        )}
        {options.map((id) => (
          <MenuItem key={id} value={id}>
            {id}
          </MenuItem>
        ))}
        {(allowCustom || custom) && (
          <MenuItem value="__custom" disabled={!allowCustom}>
            Custom model ID
          </MenuItem>
        )}
      </TextField>
      {custom && allowCustom && (
        <TextField
          label="Custom model ID"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          helperText="Model capabilities must be confirmed for this provider."
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
        bgcolor: tinted ? "secondary.main" : undefined,
        borderColor: "divider",
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
  registry: suppliedRegistry,
  initialGenerationSettings,
  initialEvaluatorSettings,
  getProviderKey,
}: {
  adapter?: Adapter;
  controller?: ConnectionController;
  registry?: ProviderRegistry;
  initialGenerationSettings?: Settings;
  initialEvaluatorSettings?: Settings;
  getProviderKey?: (provider: string) => string;
}) {
  const [connectionController] = useState(
    () => controller || new ConnectionController(undefined, true),
  );
  const connectionState = useSyncExternalStore(
    connectionController.subscribe,
    connectionController.getSnapshot,
  );
  const { key, verification, attempts: verifyAttempts } = connectionState;
  const verifying = verification === "verifying";
  const [openAIModel, setOpenAIModel] = useState<string>(
    initialGenerationSettings?.provider === "openai"
      ? initialGenerationSettings.model
      : "gpt-5.6-terra",
  );
  const [generationBase] = useState(() => initialGenerationSettings);
  const [evaluatorBase] = useState(() => initialEvaluatorSettings);
  const [registry] = useState(
    () => suppliedRegistry ?? createProviderRegistry(adapter),
  );
  const [openCodeKeys, setOpenCodeKeys] = useState<OpenCodeKeys>(() => ({ "opencode-console": getProviderKey?.("opencode-console") ?? "", "opencode-go": getProviderKey?.("opencode-go") ?? "" }));
  const [geminiKey, setGeminiKey] = useState("");
  const providerId = generationBase
    ? (generationBase.provider ?? "")
    : "openai";
  const model = generationModelFor(providerId, openAIModel, generationBase);
  const credential = (id: string) =>
    id === "openai"
      ? connectionController.getKey()
      : id === "opencode-console" || id === "opencode-go"
        ? openCodeKeys[id]
        : (getProviderKey?.(id) ?? "");
  const generationSettings: Settings = generationBase
    ? { ...generationBase, model }
    : { ...settings(model), provider: providerId };
  const [tab, setTab] = useState<LabTab>(() =>
    initialLabTab(credential(providerId), generationSettings, registry),
  );
  const navigate = (next: LabTab) => {
    setVisible(false);
    setTab(next);
  };
  const [visible, setVisible] = useState(false);
  const [experts, setExperts] = useState<Expert[]>([]);
  const [teamText, setTeamText] = useState("");
  const [addText, setAddText] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<Expert | null>(null);
  const [requireExpertModel, setRequireExpertModel] = useState(false);
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
    engine.current = new Engine(
      () => redraw((n) => n + 1),
      adapter,
      {},
      registry,
    );
  const active = !!engine.current.active;
  const connectionValid =
    !!credential(providerId).trim() &&
    !registry.get(providerId)?.validate(generationSettings) &&
    registry.get(providerId)?.capabilities(model)?.structuredOutput === true;
  const expertProblem = experts
    .map((expert) =>
      configurationProblem(
        registry,
        resolveExpert(expert, model, providerId),
        "Expert",
        false,
      ),
    )
    .find(Boolean);
  const disabledReason = active
    ? "An experiment or retry is active."
    : !experts.length
      ? "Add at least one expert to enable running an experiment."
      : !question.trim()
        ? "Enter a question."
        : !connectionValid
          ? "Configure an API key and supported model."
          : expertProblem || "";
  const changeConfig = (fn: () => void) => {
    connectionController.invalidate();
    fn();
  };
  const verify = () => connectionController.verify(openAIModel, adapter);
  async function generate(single: boolean) {
    if (generationLock.current || !connectionValid) return;
    generationLock.current = true;
    setGenerating(single ? "single" : "team");
    setGenerationError("");
    let result: Awaited<ReturnType<typeof generateWithProvider>>;
    try {
      result = await generateWithProvider(
        registry,
        generationSettings,
        credential,
        single ? addText : teamText,
        single,
      );
    } catch {
      setGenerationError(
        "The selected provider, model, or credentials could not be used for generation.",
      );
      setGenerating(null);
      generationLock.current = false;
      return;
    }
    const a = { id: crypto.randomUUID(), ...result };
    if (a.status === "succeeded") {
      try {
        const generated = validateExperts(a.text, single, {
          ...generationSettings,
          provider: providerId,
        });
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
      const run = createRun(
        question,
        reference,
        experts,
        model,
        providerId,
        registry,
        evaluatorBase,
      );
      setRuns((v) => [run, ...v]);
      setRunError("");
      void engine.current!.execute(run, credential);
    } catch (error) {
      setRunError(
        error instanceof ConfigurationError
          ? error.message
          : "Check required inputs, expert settings, and the shared model.",
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
          sx={{
            p: 2.5,
            mb: 3,
            bgcolor: "secondary.main",
            borderColor: "divider",
          }}
        >
          <Stack direction="row" alignItems="center" gap={2} flexWrap="wrap">
            <Typography variant="h4" component="h1">
              Expert Lab
            </Typography>
            <Typography color="text.secondary">Day 5</Typography>
            <Box
              sx={{
                ml: { xs: 0, sm: "auto" },
                display: "flex",
                flexWrap: "wrap",
                gap: 1,
              }}
            >
              <ProviderStatus verification={verification} />
            </Box>
          </Stack>
        </Paper>
        <Tabs
          value={tab}
          onChange={(_, next: LabTab) => navigate(next)}
          aria-label="Expert Lab navigation"
          sx={{ mb: 2 }}
        >
          <Tab value="lab" label="Lab" id="tab-lab" aria-controls="panel-lab" />
          <Tab
            value="settings"
            label="Settings"
            id="tab-settings"
            aria-controls="panel-settings"
          />
        </Tabs>
        <Box
          role="tabpanel"
          id="panel-lab"
          aria-labelledby="tab-lab"
          hidden={tab !== "lab"}
        >
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
                    !!generating || !teamText.trim() || !connectionValid
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
              {registry.get(providerId)?.capabilities(model)
                ?.structuredOutput !== true && (
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
                            onClick={() => { setRequireExpertModel(false); setEditing(expertEditDraft(e)); }}
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
                      <Box sx={{ mt: 2 }} />
                      <ExpertConfigurationChips
                        registry={registry}
                        defaultProvider={providerId}
                        expert={e}
                        defaultModel={model}
                      />
                    </CardContent>
                  </Card>
                ))}
                <Card
                  variant="outlined"
                  sx={{
                    border: "1px dashed #A68B38",
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
                        bgcolor: "secondary.main",
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
                  label="Expected answer (optional)"
                  multiline
                  minRows={3}
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                  helperText="Optional. When provided, it is used for evaluation and never sent to participants."
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
                      disabled={active}
                      credential={credential}
                      refresh={() => redraw((n) => n + 1)}
                      retry={(index) =>
                        void engine.current!.execute(run, credential, index)
                      }
                      retryEvaluation={() =>
                        void engine.current!.execute(
                          run,
                          credential,
                          undefined,
                          true,
                        )
                      }
                    />
                  ))}
                </Stack>
              )}
            </Section>
            <Typography
              variant="body2"
              color="text.secondary"
              textAlign="center"
            >
              Experts, history, and built-in credentials reset on reload.
              Verification resets. Requests go to the selected provider.
              Verification and retries may consume
              tokens.
            </Typography>
          </Stack>
        </Box>
        <Box
          role="tabpanel"
          id="panel-settings"
          aria-labelledby="tab-settings"
          hidden={tab !== "settings"}
        >
          <Providers
            model={openAIModel}
            verification={verification}
            openAIKeyPresent={!!key.trim()}
            registry={registry}
            adapter={adapter}
            keys={{ openai: key, ...openCodeKeys, gemini: geminiKey }}
            referencedProviders={experts.flatMap((expert) => expert.provider ? [expert.provider] : [])}
            onDiscovery={() => redraw((n) => n + 1)}
            onSaveBuiltin={(id, value, selectedModel, verified) => {
              if (id === "openai") {
                if (value !== connectionController.getKey()) connectionController.updateKey(value);
                if (selectedModel && selectedModel !== openAIModel) { connectionController.invalidate(); setOpenAIModel(selectedModel); }
                if (verified) connectionController.adoptVerified(value);
                else if (verification !== "unverified") connectionController.invalidate();
              } else if (id === "gemini") setGeminiKey(value);
              else setOpenCodeKeys((current) => ({ ...current, [id]: value }));
            }}
            openCodeSettings={<BuiltinConnectionSettings registry={registry} keys={openCodeKeys} onDiscovery={() => redraw((n) => n + 1)} setKey={(id: OpenCodeConnection, value: string) => setOpenCodeKeys((current) => ({ ...current, [id]: value }))} />}
            openAISettings={
              <Section title="Connection settings">
                <Stack spacing={2} sx={{ pt: 1 }}>
                  <Typography>Provider: OpenAI</Typography>
                  <TextField
                    label="API key"
                    type={visible ? "text" : "password"}
                    value={key}
                    onChange={(e) =>
                      connectionController.updateKey(e.target.value)
                    }
                    autoComplete="off"
                    slotProps={{
                      input: {
                        endAdornment: (
                          <InputAdornment position="end">
                            <IconButton
                              aria-label={
                                visible ? "Hide API key" : "Show API key"
                              }
                              onClick={() => setVisible((v) => !v)}
                            >
                              {visible ? <VisibilityOff /> : <Visibility />}
                            </IconButton>
                          </InputAdornment>
                        ),
                      },
                    }}
                    helperText="The key is available in page memory only."
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
                    Removes the key from the app. Requests already sent are not canceled.
                  </Typography>
                  {connectionState.storageWarning && (
                    <Alert severity="warning">
                      {connectionState.storageWarning}
                    </Alert>
                  )}
                  <ModelField
                    registry={registry}
                    providerId="openai"
                    label="Model"
                    allowCustom={false}
                    value={openAIModel}
                    onChange={(v) => changeConfig(() => setOpenAIModel(v))}
                  />
                  <Typography variant="body2">
                    Used for verification, expert generation, evaluation, and as
                    the default for experts.
                  </Typography>
                  <Button
                    variant="outlined"
                    onClick={() => void verify()}
                    disabled={verifying || !key.trim() || !openAIModel.trim()}
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
                    Verification makes a minimal real request and may be
                    billable. Model availability depends on your OpenAI project
                    permissions.
                  </Alert>
                </Stack>
              </Section>
            }
          />
        </Box>
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
            {!connectionValid ? (
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
              disabled={!!generating || !addText.trim() || !connectionValid}
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
                    rows={5}
                    slotProps={{ input: { inputComponent: "textarea" } }}
                    sx={{
                      "& textarea": {
                        boxSizing: "content-box",
                        lineHeight: "1.4375em",
                        height: "calc(5 * 1.4375em)",
                        overflowY: "auto",
                        resize: "none",
                      },
                    }}
                    value={editing.rolePrompt}
                    onChange={(e) =>
                      setEditing({ ...editing, rolePrompt: e.target.value })
                    }
                  />
                  <TextField
                    select
                    label="Provider"
                    value={editing.provider?.startsWith("opencode-") ? "opencode" : (editing.provider ?? "")}
                    onChange={(event) => {
                      const next = event.target.value === "opencode" ? "opencode-pending" : event.target.value;
                      if (next !== editing.provider) setRequireExpertModel(true);
                      setEditing(selectExpertProvider(editing, next));
                    }}
                  >
                    {!editing.provider && <MenuItem value="" disabled>Select a provider</MenuItem>}
                    {editing.provider && !editing.provider.startsWith("opencode-") && !["openai", "gemini"].includes(editing.provider) && (
                      <MenuItem value={editing.provider}>{editing.provider}</MenuItem>
                    )}
                    <MenuItem value="openai">OpenAI</MenuItem>
                    <MenuItem value="opencode">OpenCode</MenuItem>
                    <MenuItem value="gemini">Gemini (execution unavailable)</MenuItem>
                  </TextField>
                  {editing.provider?.startsWith("opencode-") && <TextField select label="OpenCode connection" value={editing.provider === "opencode-pending" ? "" : editing.provider} onChange={(event) => { setRequireExpertModel(true); setEditing(selectExpertProvider(editing, event.target.value)); }}>
                    <MenuItem value="" disabled>Select a connection</MenuItem>
                    <MenuItem value="opencode-console">Console — Pay as you go</MenuItem>
                    <MenuItem value="opencode-go">Go — Subscription</MenuItem>
                  </TextField>}
                  {editing.provider === "gemini" && <Alert severity="info">Gemini can be configured, but execution is not available yet.</Alert>}
                  {(editing.provider === "opencode-console" || editing.provider === "opencode-go") && !registry.capabilitiesFor(editing.provider, editing.model) && (
                    <Alert severity="info">Model capabilities must be discovered before execution.</Alert>
                  )}
                  <ModelField
                    registry={registry}
                    providerId={editing.provider}
                    label="Model override"
                    value={editing.model}
                    inherit={
                      !requireExpertModel && !!editing.provider && editing.provider === providerId
                    }
                    onChange={(v) => {
                      setRequireExpertModel(false);
                      setEditing({
                        ...editing,
                        model: v,
                      });
                    }}
                  />
                  {(!!editing.reasoning ||
                    !!registry.capabilitiesFor(
                      editing.provider,
                      resolveExpert(editing, model, providerId).model,
                    )?.reasoningEfforts?.length) && (
                    <TextField
                      select
                      label="Reasoning"
                      error={
                        !!editing.reasoning &&
                        !registry
                          .capabilitiesFor(
                            editing.provider,
                            resolveExpert(editing, model, providerId).model,
                          )
                          ?.reasoningEfforts?.includes(editing.reasoning)
                      }
                      helperText={
                        editing.reasoning &&
                        !registry
                          .capabilitiesFor(
                            editing.provider,
                            resolveExpert(editing, model, providerId).model,
                          )
                          ?.reasoningEfforts?.includes(editing.reasoning)
                          ? "Choose a reasoning level supported by the selected model."
                          : undefined
                      }
                      value={editing.reasoning || ""}
                      onChange={(e) =>
                        setEditing({ ...editing, reasoning: e.target.value })
                      }
                    >
                      <MenuItem value="">Unspecified</MenuItem>
                      {editing.reasoning &&
                        !registry
                          .capabilitiesFor(
                            editing.provider,
                            resolveExpert(editing, model, providerId).model,
                          )
                          ?.reasoningEfforts?.includes(editing.reasoning) && (
                          <MenuItem value={editing.reasoning} disabled>
                            {statusLabel(editing.reasoning)} (unsupported for
                            selected model)
                          </MenuItem>
                        )}
                      {registry
                        .capabilitiesFor(
                          editing.provider,
                          resolveExpert(editing, model, providerId).model,
                        )
                        ?.reasoningEfforts?.map((v) => (
                          <MenuItem key={v} value={v}>
                            {statusLabel(v)}
                          </MenuItem>
                        ))}
                    </TextField>
                  )}
                  <Box>
                    <Typography variant="subtitle1" fontWeight={700}>
                      API Parameters
                    </Typography>
                    <ParameterEditor
                      parameters={editing.parameters ?? []}
                      onChange={(parameters) =>
                        setEditing({ ...editing, parameters })
                      }
                    />
                  </Box>
                </Stack>
              </DialogContent>
              <DialogActions sx={{ flexWrap: "wrap" }}>
                {(requireExpertModel && !editing.model || expertSettingsError(editing, model, registry, providerId)) && (
                  <Typography
                    role="status"
                    color="error"
                    variant="body2"
                    sx={{ flexBasis: "100%", px: 1 }}
                  >
                    {requireExpertModel && !editing.model ? "Select a model for the selected provider." : expertSettingsError(editing, model, registry, providerId)}
                  </Typography>
                )}
                <Button onClick={() => setEditing(null)}>Cancel</Button>
                <Button
                  variant="contained"
                  disabled={
                    (requireExpertModel && !editing.model) || !!expertSettingsError(editing, model, registry, providerId)
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
