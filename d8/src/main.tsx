import { credentials } from "./saved-credentials";
import { ConsoleParameterEditor } from "./console-expert-parameters";
import {
  adjacentExpert,
  expertEditDraft,
  generationModelFor,
  selectExpertProvider,
} from "./interaction-safety";
import { initialLabTab } from "./navigation";
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
  Checkbox,
  FormControlLabel,
  Radio,
  RadioGroup,
  Switch,
  List,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  TextField,
  MenuItem,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Alert,
  Tooltip,
  CircularProgress,
  Tabs,
  Tab,
} from "@mui/material";
import { alpha } from "@mui/material/styles";
import InfoOutlined from "@mui/icons-material/InfoOutlined";
import SmartToyOutlined from "@mui/icons-material/SmartToyOutlined";
import StorageOutlined from "@mui/icons-material/StorageOutlined";
import BuildOutlined from "@mui/icons-material/BuildOutlined";
import ViewInArOutlined from "@mui/icons-material/ViewInArOutlined";
import PlayArrow from "@mui/icons-material/PlayArrow";
import Add from "@mui/icons-material/Add";
import ContentCopyOutlined from "@mui/icons-material/ContentCopyOutlined";
import { duplicateExpert } from "./duplicate-expert";
import DeleteOutline from "@mui/icons-material/DeleteOutline";
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
import type { VerificationKind } from "./verification-chip";
import {
  createProviderRegistry,
  type ProviderRegistry,
} from "./provider-registry";
import { ParameterEditor } from "./parameter-editor";
import { Providers } from "./providers";
import type { OpenCodeKeys } from "./builtin-connection-settings";
import { statusLabel } from "./labels";
import { RunView } from "./results";
import { ComparisonReport } from "./comparison-report";
import { usage, seconds } from "./result-format";
import { BatchTaskList } from "./batch-task-list";
import { executeBatch, type BatchTask } from "./batch-tasks";
import { ToolsPage } from "./tools-page";
import { Week2AgentToolLab } from "./week2-agent-tool-lab";
import { createBuiltInToolRegistry } from "./tool-runtime";

const navigation = [
  { id: "lab", label: "Labs", icon: ScienceOutlined },
  { id: "agents", label: "Agents", icon: SmartToyOutlined },
  { id: "tools", label: "Tools", icon: BuildOutlined },
  { id: "settings", label: "Providers", icon: StorageOutlined },
] as const;

type Page = (typeof navigation)[number]["id"];

function toggleId(ids: readonly string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id];
}

export function hasUnsavedAgentChanges(
  saved: Expert | null | undefined,
  draft: Expert | null | undefined,
  draftActive: boolean,
  inactiveIds: readonly string[],
): boolean {
  if (!saved || !draft) return false;
  return (
    JSON.stringify(draft) !== JSON.stringify(saved) ||
    draftActive === inactiveIds.includes(saved.id)
  );
}

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
  const unavailableConsoleModel =
    providerId === "opencode-console" &&
    !!value &&
    !options.includes(value) &&
    !customEditing;
  const custom =
    customEditing ||
    (!!value && !options.includes(value) && !unavailableConsoleModel);
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
        {unavailableConsoleModel && (
          <MenuItem value={value} disabled>
            {value} (previously selected; unavailable)
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
        bgcolor: tinted
          ? (theme) => alpha(theme.palette.primary.main, 0.1)
          : undefined,
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
  const credentialStates = useSyncExternalStore(credentials.subscribe, credentials.getSnapshot, credentials.getSnapshot);
  const [connectionController] = useState(
    () => controller || new ConnectionController(undefined, true),
  );
  const connectionState = useSyncExternalStore(
    connectionController.subscribe,
    connectionController.getSnapshot,
    connectionController.getSnapshot,
  );
  const { key, verification } = connectionState;
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
  const [toolRegistry] = useState(() => createBuiltInToolRegistry());
  const [openCodeKeys, setOpenCodeKeys] = useState<OpenCodeKeys>(() => ({
    "opencode-console": getProviderKey?.("opencode-console") ?? "",
    "opencode-go": getProviderKey?.("opencode-go") ?? "",
  }));
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
  const [tab, navigate] = useState<Page>(() =>
    initialLabTab(credential(providerId), generationSettings, registry),
  );
  const [consoleHeaderStatus, setConsoleHeaderStatus] = useState<{
    kind: VerificationKind;
    unsaved: boolean;
  }>({ kind: "unchecked", unsaved: false });
  const [experts, setExperts] = useState<Expert[]>([]);
  const [inactiveIds, setInactiveIds] = useState<string[]>([]);
  const [excludedExpertIds, setExcludedExpertIds] = useState<string[]>([]);
  const [excludedTaskIds, setExcludedTaskIds] = useState<string[]>([]);
  const [runMode, setRunMode] = useState<"selected" | "all">("selected");
  const [labsTab, setLabsTab] = useState<"week1" | "week2">("week1");
  const [resultTab, setResultTab] = useState<"results" | "history">("results");
  const [clearOpen, setClearOpen] = useState(false);
  const [addText, setAddText] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [creationHelpOpen, setCreationHelpOpen] = useState(false);
  const [pendingAgentAction, setPendingAgentAction] = useState<{
    id: string;
    kind: "select" | "duplicate";
  } | null>(null);
  const [agentToDeleteId, setAgentToDeleteId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Expert | null>(null);
  const [draftActive, setDraftActive] = useState(true);
  const [agentTab, setAgentTab] = useState<"general" | "params">("general");
  const [requireExpertModel, setRequireExpertModel] = useState(false);
  const [editorRevision, setEditorRevision] = useState(0);
  const editAgent = (expert: Expert | null) => {
    setEditorRevision((current) => current + 1);
    setRequireExpertModel(false);
    setAgentTab("general");
    setEditing(expert && expertEditDraft(expert));
    setDraftActive(!expert || !inactiveIds.includes(expert.id));
  };
  const openArchitect = () => {
    setCreationHelpOpen(false);
    setGenerationError("");
    setAddOpen(true);
  };
  const [generating, setGenerating] = useState(false);
  const generationLock = useRef(false);
  const [generationAttempts, setGenerationAttempts] = useState<Attempt[]>([]);
  const [generationError, setGenerationError] = useState("");
  const [tasks, setTasks] = useState<BatchTask[]>([]);
  const [batchRunning, setBatchRunning] = useState(false);
  const batchLock = useRef(false);
  const [runs, setRuns] = useState<Run[]>([]);
  const [latestRunIds, setLatestRunIds] = useState<string[]>([]);
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
  const active = !!engine.current.active || batchRunning;
  const connectionValid =
    !!credential(providerId).trim() &&
    !registry.get(providerId)?.validate(generationSettings) &&
    registry.get(providerId)?.capabilities(model)?.structuredOutput === true;
  const activeExperts = experts.filter(
    (expert) => !inactiveIds.includes(expert.id),
  );
  const selectedExperts = activeExperts.filter(
    (expert) => !excludedExpertIds.includes(expert.id),
  );
  const selectedTasks = tasks.filter(
    (task) => !excludedTaskIds.includes(task.id),
  );
  const latestBatch = runs.filter((run) => latestRunIds.includes(run.id));
  const expertProblem = selectedExperts
    .map((expert) =>
      configurationProblem(
        registry,
        resolveExpert(expert, model, providerId),
        "Expert",
        false,
      ),
    )
    .find(Boolean);
  const sharedDisabledReason = active
    ? "An experiment or retry is active."
    : !selectedExperts.length
      ? "Select at least one active agent to run an experiment."
      : !connectionValid
        ? "Configure an API key and supported model."
        : expertProblem || "";
  const savedEditing = experts.find((agent) => agent.id === editing?.id);
  const editingDirty = hasUnsavedAgentChanges(
    savedEditing,
    editing,
    draftActive,
    inactiveIds,
  );
  function applyAgentAction({
    id,
    kind,
  }: NonNullable<typeof pendingAgentAction>) {
    if (kind === "duplicate") {
      const next = duplicateExpert(experts, id);
      const copy = next.find(
        (agent) => !experts.some((original) => original.id === agent.id),
      );
      if (!copy) return;
      setExperts(next);
      editAgent(copy);
    } else {
      const expert = experts.find((agent) => agent.id === id);
      if (expert) editAgent(expert);
    }
  }
  function requestAgentAction(action: NonNullable<typeof pendingAgentAction>) {
    if (action.kind === "select" && editing?.id === action.id) return;
    if (editingDirty) {
      setPendingAgentAction(action);
      return;
    }
    applyAgentAction(action);
  }
  const agentToDelete = experts.find((agent) => agent.id === agentToDeleteId);
  function deleteAgent(id: string) {
    setExperts((current) => current.filter((agent) => agent.id !== id));
    setInactiveIds((current) =>
      current.filter((inactiveId) => inactiveId !== id),
    );
    setExcludedExpertIds((current) =>
      current.filter((excludedId) => excludedId !== id),
    );
    if (editing?.id === id) editAgent(adjacentExpert(experts, id));
    setAgentToDeleteId(null);
  }
  async function generate() {
    if (generationLock.current || !connectionValid) return;
    generationLock.current = true;
    setGenerating(true);
    setGenerationError("");
    let result: Awaited<ReturnType<typeof generateWithProvider>>;
    try {
      result = await generateWithProvider(
        registry,
        generationSettings,
        credential,
        addText,
        false,
      );
    } catch {
      setGenerationError(
        "The selected provider, model, or credentials could not be used for generation.",
      );
      setGenerating(false);
      generationLock.current = false;
      return;
    }
    const a = { id: crypto.randomUUID(), ...result };
    if (a.status === "succeeded") {
      try {
        const generated = validateExperts(a.text, false, {
          ...generationSettings,
          provider: providerId,
        });
        setExperts((current) => [...current, ...generated]);
        editAgent(generated[0]);
        setAddOpen(false);
        setAddText("");
      } catch {
        a.status = "failed";
        a.error =
          "The Architect returned malformed expert data. Existing experts are unchanged; retry generation.";
      }
    }
    setGenerationAttempts((v) => [...v, a]);
    if (a.status !== "succeeded")
      setGenerationError(a.error || "Generation failed");
    setGenerating(false);
    generationLock.current = false;
  }
  async function launchBatch(selectedTasks: readonly BatchTask[]) {
    if (
      sharedDisabledReason ||
      !selectedTasks.length ||
      batchLock.current ||
      engine.current!.active
    )
      return;
    batchLock.current = true;
    setBatchRunning(true);
    setRunError("");
    setLatestRunIds([]);
    setResultTab("results");
    const capturedExperts = structuredClone(selectedExperts);
    const capturedEvaluator = evaluatorBase
      ? structuredClone(evaluatorBase)
      : undefined;
    try {
      await executeBatch(
        selectedTasks,
        (task) =>
          createRun(
            task.question,
            task.reference,
            capturedExperts,
            model,
            providerId,
            registry,
            capturedEvaluator,
            { id: task.id, version: task.version },
          ),
        (run) => engine.current!.execute(run, credential),
        (run) => {
          setLatestRunIds((current) => [...current, run.id]);
          setRuns((current) => [run, ...current]);
        },
      );
    } catch (error) {
      setRunError(
        error instanceof ConfigurationError
          ? error.message
          : "The batch could not be completed. Check the task and expert settings.",
      );
    } finally {
      batchLock.current = false;
      setBatchRunning(false);
    }
  }
  const displayedRuns = [...latestBatch].reverse();
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Container
        maxWidth={false}
        sx={{ maxWidth: 1560, py: { xs: 1.5, sm: 2.5 } }}
      >
        <Paper
          component="header"
          variant="outlined"
          sx={{ mb: 3, p: 1, px: { sm: 2 } }}
        >
          <Box
            sx={{
              display: "grid",
              gridTemplateColumns: { xs: "minmax(0, 1fr)", lg: "1fr auto 1fr" },
              gap: 1.5,
              alignItems: "center",
            }}
          >
            <Stack direction="row" alignItems="center" gap={1.2}>
              <ViewInArOutlined color="primary" sx={{ fontSize: 36 }} />
              <Box>
                <Typography variant="h6" component="h1">
                  Day 8 AI Lab
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  Week 2 / Day 8
                </Typography>
              </Box>
            </Stack>
            <Tabs
              value={tab}
              onChange={(_, next: Page) => navigate(next)}
              aria-label="Primary navigation"
              variant="scrollable"
              scrollButtons={false}
              sx={{
                minWidth: 0,
                p: 0.5,
                bgcolor: "background.default",
                border: 1,
                borderColor: "divider",
                borderRadius: 2,
                "& .MuiTabs-indicator": { display: "none" },
              }}
            >
              {navigation.map(({ id, label, icon: Icon }) => (
                <Tab
                  key={id}
                  value={id}
                  label={label}
                  icon={<Icon fontSize="small" />}
                  iconPosition="start"
                  id={`tab-${id}`}
                  aria-controls={`panel-${id}`}
                  sx={{
                    minWidth: { xs: 62, sm: 104 },
                    minHeight: 44,
                    px: { xs: 0.75, sm: 2 },
                    borderRadius: 1.5,
                    "& .MuiTab-icon": {
                      display: { xs: "none", sm: "inline-flex" },
                    },
                    "&.Mui-selected": {
                      bgcolor: "primary.main",
                      color: "primary.contrastText",
                    },
                  }}
                />
              ))}
            </Tabs>
            <Stack
              direction="row"
              gap={1}
              flexWrap="wrap"
              justifyContent={{ lg: "flex-end" }}
            >
              <ProviderStatus verification={verification} savedStatus={credentialStates.openai} />
              <ProviderStatus
                provider="OpenCode Console"
                savedStatus={credentialStates["opencode-console"]}
                verification={consoleHeaderStatus.kind}
                unsaved={consoleHeaderStatus.unsaved}
              />
            </Stack>
          </Box>
        </Paper>

        <Box
          role="tabpanel"
          id="panel-lab"
          aria-labelledby="tab-lab"
          hidden={tab !== "lab"}
        >
          <Stack spacing={2}>
            <Box>
              <Typography variant="h4" component="h2">
                Labs
              </Typography>
              <Tabs
                value={labsTab}
                onChange={(_, next: "week1" | "week2") => setLabsTab(next)}
                aria-label="Labs weeks"
                sx={{ mt: 1 }}
              >
                <Tab label="Week 1" value="week1" id="labs-week1-tab" />
                <Tab label="Week 2" value="week2" id="labs-week2-tab" />
              </Tabs>
            </Box>
            <Box
              role="tabpanel"
              aria-labelledby="labs-week1-tab"
              hidden={labsTab !== "week1"}
            >
              <Stack spacing={2}>
                <Stack
                  direction={{ xs: "column", sm: "row" }}
                  gap={2}
                  justifyContent="space-between"
                  alignItems={{ sm: "center" }}
                >
                  <Box>
                    <Typography variant="h4" component="h3">
                      Experiment Studio
                    </Typography>
                    <Typography color="text.secondary">
                      Run tasks with selected agents, view results, and compare
                      performance.
                    </Typography>
                  </Box>
                  <Stack direction="row" flexWrap="wrap" gap={1}>
                    <ComparisonReport runs={runs} buttonLabel="Open Full Report" />
                    <Button
                      variant="outlined"
                      color="error"
                      startIcon={<DeleteOutline />}
                      disabled={active || !runs.length}
                      onClick={() => setClearOpen(true)}
                    >
                      Clear Results
                    </Button>
                  </Stack>
                </Stack>
                <Box
                  sx={{
                    display: "grid",
                    gridTemplateColumns: {
                      xs: "minmax(0, 1fr)",
                      md: "minmax(250px, 1fr) minmax(0, 3fr)",
                    },
                    gap: 2,
                    alignItems: "start",
                  }}
                >
                  <Stack spacing={2}>
                    <Section title={`Tasks (${tasks.length})`}>
                      <BatchTaskList
                        tasks={tasks}
                        onChange={setTasks}
                        active={active}
                        onRunTask={(task) => void launchBatch([task])}
                        disabledReason={sharedDisabledReason}
                        selection={{
                          excludedIds: excludedTaskIds,
                          onToggle: (id) =>
                            setExcludedTaskIds((current) => toggleId(current, id)),
                        }}
                      />
                    </Section>
                    <Section title="Run Mode">
                      <RadioGroup
                        aria-label="Run Mode"
                        value={runMode}
                        onChange={(_, value) =>
                          setRunMode(value === "all" ? "all" : "selected")
                        }
                      >
                        <FormControlLabel
                          value="selected"
                          control={<Radio />}
                          label={`Run selected tasks (${selectedTasks.length})`}
                          disabled={active}
                        />
                        <FormControlLabel
                          value="all"
                          control={<Radio />}
                          label={`Run all tasks (${tasks.length})`}
                          disabled={active}
                        />
                      </RadioGroup>
                      <Button
                        fullWidth
                        variant="contained"
                        startIcon={<PlayArrow />}
                        sx={{ mt: 1.5, py: 1.15 }}
                        disabled={
                          !!sharedDisabledReason ||
                          !(runMode === "all" ? tasks : selectedTasks).length
                        }
                        onClick={() =>
                          void launchBatch(
                            runMode === "all" ? tasks : selectedTasks,
                          )
                        }
                      >
                        Run Experiment
                      </Button>
                      {batchRunning && (
                        <Typography variant="body2" role="status" mt={1}>
                          Running tasks in order…
                        </Typography>
                      )}
                      {sharedDisabledReason && !active && (
                        <Typography variant="body2" color="text.secondary" mt={1}>
                          {sharedDisabledReason}
                        </Typography>
                      )}
                      {runError && (
                        <Alert severity="error" sx={{ mt: 1 }}>
                          {runError}
                        </Alert>
                      )}
                    </Section>
                  </Stack>
                  <Stack spacing={2} sx={{ minWidth: 0 }}>
                    <Section title="Experiment Setup">
                      <Typography color="text.secondary" sx={{ mb: 1 }}>
                        Select the agents to run the chosen tasks.
                      </Typography>
                      <Stack
                        direction="row"
                        gap={1}
                        flexWrap="wrap"
                        alignItems="center"
                      >
                        {activeExperts.map((expert) => (
                          <Paper
                            key={expert.id}
                            variant="outlined"
                            sx={{
                              px: 1,
                              bgcolor: excludedExpertIds.includes(expert.id)
                                ? "background.paper"
                                : "secondary.main",
                            }}
                          >
                            <FormControlLabel
                              sx={{ m: 0, pr: 0.5, overflowWrap: "anywhere" }}
                              control={
                                <Checkbox
                                  size="small"
                                  checked={!excludedExpertIds.includes(expert.id)}
                                  disabled={active}
                                  onChange={() =>
                                    setExcludedExpertIds((current) =>
                                      toggleId(current, expert.id),
                                    )
                                  }
                                />
                              }
                              label={expert.name}
                            />
                          </Paper>
                        ))}
                        {!activeExperts.length && (
                          <Typography variant="body2" color="text.secondary">
                            No active agents.
                          </Typography>
                        )}
                        <Button
                          variant="outlined"
                          startIcon={<Add />}
                          onClick={() => navigate("agents")}
                        >
                          Manage Agents
                        </Button>
                      </Stack>
                    </Section>
                    <Section
                      title={
                        latestBatch.length
                          ? `Results — ${latestBatch.length} ${latestBatch.length === 1 ? "Task" : "Tasks"}`
                          : "Results"
                      }
                    >
                      <Tabs
                        value={resultTab}
                        onChange={(_, next: "results" | "history") =>
                          setResultTab(next)
                        }
                        aria-label="Experiment results"
                        sx={{ mb: 2 }}
                      >
                        <Tab
                          label="Results"
                          value="results"
                          id="results-tab"
                          aria-controls="run-results"
                        />
                      </Tabs>
                      <Stack
                        id="run-results"
                        role="tabpanel"
                        aria-labelledby="results-tab"
                        spacing={2}
                      >
                        {!displayedRuns.length && (
                          <Box
                            sx={{
                              py: 5,
                              textAlign: "center",
                              bgcolor: "background.default",
                              borderRadius: 2,
                            }}
                          >
                            <ScienceOutlined color="primary" />
                            <Typography>No runs yet.</Typography>
                          </Box>
                        )}
                        {displayedRuns.map((run) => (
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
                    </Section>
                  </Stack>
                </Box>
              </Stack>
            </Box>
            <Box
              role="tabpanel"
              aria-labelledby="labs-week2-tab"
              hidden={labsTab !== "week2"}
            >
              <Week2AgentToolLab
                toolRegistry={toolRegistry}
                registry={registry}
                openAIModel={openAIModel}
                onOpenAIModelChange={setOpenAIModel}
                openAIKey={key}
                openCodeKeys={openCodeKeys}
              />
            </Box>
            <Typography variant="caption" color="text.secondary">
              Week 2 conversation history is saved locally. Agents, Week 1 history, and built-in credentials reset on reload.
              Verification and retries may consume tokens.
            </Typography>
          </Stack>
        </Box>

        <Box
          role="tabpanel"
          id="panel-agents"
          aria-labelledby="tab-agents"
          hidden={tab !== "agents"}
        >
          <Stack spacing={2}>
            {experts.length === 0 ? (
              <Paper variant="outlined" sx={{ px: 2, py: { xs: 6, md: 10 } }}>
                <Stack alignItems="center" spacing={1.5} textAlign="center">
                  <SmartToyOutlined color="primary" />
                  <Typography variant="h5" component="h2">
                    No agents yet
                  </Typography>
                  <Typography color="text.secondary">
                    Create your first agent to start building your team.
                  </Typography>
                  <Button
                    variant="contained"
                    startIcon={<Add />}
                    disabled={generating}
                    onClick={openArchitect}
                  >
                    Add Agent
                  </Button>
                </Stack>
              </Paper>
            ) : (
              <Box
                sx={{
                  display: "grid",
                  gridTemplateColumns: {
                    xs: "minmax(0, 1fr)",
                    md: "minmax(240px, 27%) minmax(0, 1fr)",
                  },
                  gap: 2,
                  alignItems: "start",
                }}
              >
                <Section title={`Agents (${experts.length})`}>
                  <List disablePadding aria-label="Agents">
                    {experts.map((expert) => (
                      <ListItem
                        key={expert.id}
                        disablePadding
                        sx={{
                          alignItems: "flex-start",
                          border: 1,
                          borderColor:
                            editing?.id === expert.id
                              ? "primary.main"
                              : "divider",
                          borderRadius: 1.5,
                          mb: 0.75,
                          bgcolor: "background.paper",
                        }}
                      >
                        <ListItemButton
                          selected={editing?.id === expert.id}
                          aria-current={
                            editing?.id === expert.id ? "true" : undefined
                          }
                          onClick={() =>
                            requestAgentAction({
                              id: expert.id,
                              kind: "select",
                            })
                          }
                          sx={{
                            minWidth: 0,
                            px: 1,
                            borderRadius: 1.5,
                            bgcolor:
                              editing?.id === expert.id
                                ? "secondary.main"
                                : "transparent",
                            "&:hover": {
                              bgcolor:
                                editing?.id === expert.id
                                  ? "secondary.main"
                                  : undefined,
                            },
                            "&.Mui-selected, &.Mui-selected:hover, &.Mui-selected.Mui-focusVisible":
                              {
                                bgcolor: "secondary.main",
                              },
                            "&.Mui-focusVisible": {
                              outline: "2px solid",
                              outlineColor: "primary.dark",
                              outlineOffset: -2,
                              borderRadius: 1.5,
                            },
                          }}
                        >
                          <ListItemIcon sx={{ minWidth: 30 }}>
                            <SmartToyOutlined
                              color="primary"
                              fontSize="small"
                            />
                          </ListItemIcon>
                          <ListItemText
                            primary={expert.name}
                            secondary={
                              inactiveIds.includes(expert.id)
                                ? [expert.roleLabel, "Inactive"]
                                    .filter(Boolean)
                                    .join(" · ")
                                : expert.roleLabel
                            }
                            sx={{ overflowWrap: "anywhere" }}
                          />
                        </ListItemButton>
                        <Stack
                          direction="row"
                          sx={{ flexShrink: 0, pt: 1, pr: 0.5 }}
                        >
                          <Tooltip title="Duplicate agent">
                            <IconButton
                              size="small"
                              aria-label="Duplicate agent"
                              onClick={() =>
                                requestAgentAction({
                                  id: expert.id,
                                  kind: "duplicate",
                                })
                              }
                            >
                              <ContentCopyOutlined fontSize="small" />
                            </IconButton>
                          </Tooltip>
                          <Tooltip title="Delete agent">
                            <IconButton
                              size="small"
                              color="error"
                              aria-label="Delete agent"
                              onClick={() => setAgentToDeleteId(expert.id)}
                            >
                              <DeleteOutline fontSize="small" />
                            </IconButton>
                          </Tooltip>
                        </Stack>
                      </ListItem>
                    ))}
                  </List>
                  <Button
                    variant="outlined"
                    startIcon={<Add />}
                    sx={{ mt: 2 }}
                    disabled={generating}
                    onClick={openArchitect}
                  >
                    Add New Agent
                  </Button>
                </Section>
                <Stack spacing={1.5} sx={{ minWidth: 0 }}>
                  <Stack
                    direction="row"
                    flexWrap="wrap"
                    gap={1}
                    justifyContent="space-between"
                    alignItems="center"
                  >
                    <Typography
                      variant="h4"
                      component="h2"
                      sx={{ display: "flex", alignItems: "center", gap: 1 }}
                    >
                      <SmartToyOutlined color="primary" />{" "}
                      {editing?.name ?? "Agent"}
                    </Typography>
                  </Stack>
                  {editing && (
                    <Paper variant="outlined" sx={{ minWidth: 0 }}>
                      <Tabs
                        value={agentTab}
                        onChange={(_, next: "general" | "params") =>
                          setAgentTab(next)
                        }
                        aria-label="Agent details"
                        sx={{ px: 1, borderBottom: 1, borderColor: "divider" }}
                      >
                        <Tab
                          id="agent-general-tab"
                          aria-controls="agent-general-panel"
                          value="general"
                          label="General"
                        />
                        <Tab
                          id="agent-params-tab"
                          aria-controls="agent-params-panel"
                          value="params"
                          label="Params"
                        />
                      </Tabs>
                      <Box sx={{ p: { xs: 2, md: 3 } }} key={editorRevision}>
                        <Box
                          role="tabpanel"
                          id="agent-general-panel"
                          aria-labelledby="agent-general-tab"
                          hidden={agentTab !== "general"}
                        >
                          <Stack spacing={2}>
                            <TextField
                              label="Name"
                              required
                              value={editing.name}
                              onChange={(e) =>
                                setEditing({ ...editing, name: e.target.value })
                              }
                            />
                            <TextField
                              label="Role"
                              value={editing.roleLabel ?? ""}
                              onChange={(event) =>
                                setEditing({
                                  ...editing,
                                  roleLabel: event.target.value,
                                })
                              }
                            />
                            <TextField
                              label="Description"
                              required
                              multiline
                              rows={5}
                              sx={{
                                "& textarea:not([aria-hidden='true'])": {
                                  overflowY: "auto",
                                },
                              }}
                              value={editing.rolePrompt}
                              onChange={(event) =>
                                setEditing({
                                  ...editing,
                                  rolePrompt: event.target.value,
                                })
                              }
                              helperText="These instructions define the agent’s role in an experiment."
                            />
                            <Stack
                              direction={{ xs: "column", sm: "row" }}
                              gap={2}
                              sx={{ "& > *": { flex: 1 } }}
                            >
                              <TextField
                                select
                                label="Provider"
                                value={
                                  editing.provider?.startsWith("opencode-")
                                    ? "opencode"
                                    : (editing.provider ?? "")
                                }
                                helperText={
                                  editing.provider === "opencode-go"
                                    ? "Using existing OpenCode Go configuration. OpenCode currently uses Console mode in the UI."
                                    : undefined
                                }
                                onChange={(event) => {
                                  const next =
                                    event.target.value === "opencode"
                                      ? "opencode-console"
                                      : event.target.value;
                                  if (next !== editing.provider)
                                    setRequireExpertModel(true);
                                  setEditing(
                                    selectExpertProvider(editing, next),
                                  );
                                }}
                              >
                                {!editing.provider && (
                                  <MenuItem value="" disabled>
                                    Select a provider
                                  </MenuItem>
                                )}
                                {editing.provider &&
                                  !editing.provider.startsWith("opencode-") &&
                                  !["openai", "gemini"].includes(
                                    editing.provider,
                                  ) && (
                                    <MenuItem value={editing.provider}>
                                      {editing.provider}
                                    </MenuItem>
                                  )}
                                <MenuItem value="openai">OpenAI</MenuItem>
                                <MenuItem value="opencode">OpenCode</MenuItem>
                                {editing.provider === "opencode-go" && (
                                  <MenuItem value="opencode-go" disabled>
                                    OpenCode Go — existing configuration
                                  </MenuItem>
                                )}
                                {editing.provider === "gemini" && (
                                  <MenuItem value="gemini" disabled>
                                    Previously selected provider unavailable
                                  </MenuItem>
                                )}
                              </TextField>

                              <ModelField
                                registry={registry}
                                providerId={editing.provider}
                                label="Model"
                                value={editing.model}
                                inherit={
                                  !requireExpertModel &&
                                  !!editing.provider &&
                                  editing.provider === providerId
                                }
                                onChange={(v) => {
                                  setRequireExpertModel(false);
                                  setEditing({
                                    ...editing,
                                    model: v,
                                  });
                                }}
                              />
                            </Stack>
                            {(editing.provider === "opencode-console" ||
                              editing.provider === "opencode-go") &&
                              !registry.capabilitiesFor(
                                editing.provider,
                                editing.model,
                              ) && (
                                <Alert severity="info">
                                  Model capabilities must be discovered before
                                  execution.
                                </Alert>
                              )}
                            <FormControlLabel
                              control={
                                <Switch
                                  checked={draftActive}
                                  onChange={(_, checked) =>
                                    setDraftActive(checked)
                                  }
                                />
                              }
                              label="Active (available in experiments)"
                            />
                          </Stack>
                        </Box>
                        <Box
                          role="tabpanel"
                          id="agent-params-panel"
                          aria-labelledby="agent-params-tab"
                          hidden={agentTab !== "params"}
                        >
                          <Stack spacing={2}>
                            <Box>
                              <Typography variant="subtitle1" fontWeight={700}>
                                API Parameters
                              </Typography>
                              {editing.provider === "opencode-console" ? (
                                <ConsoleParameterEditor
                                  key={editing.id}
                                  parameters={editing.parameters ?? []}
                                  onChange={(parameters) =>
                                    setEditing({ ...editing, parameters })
                                  }
                                />
                              ) : (
                                <ParameterEditor
                                  parameters={editing.parameters ?? []}
                                  onChange={(parameters) =>
                                    setEditing({ ...editing, parameters })
                                  }
                                />
                              )}
                            </Box>
                            <Box component="details">
                              <Typography
                                component="summary"
                                variant="body2"
                                sx={{ cursor: "pointer", mb: 1 }}
                              >
                                Model reasoning setting
                              </Typography>
                              {(!!editing.reasoning ||
                                !!registry.capabilitiesFor(
                                  editing.provider,
                                  resolveExpert(editing, model, providerId)
                                    .model,
                                )?.reasoningEfforts?.length) && (
                                <TextField
                                  select
                                  label="Reasoning"
                                  error={
                                    !!editing.reasoning &&
                                    !registry
                                      .capabilitiesFor(
                                        editing.provider,
                                        resolveExpert(
                                          editing,
                                          model,
                                          providerId,
                                        ).model,
                                      )
                                      ?.reasoningEfforts?.includes(
                                        editing.reasoning,
                                      )
                                  }
                                  helperText={
                                    editing.reasoning &&
                                    !registry
                                      .capabilitiesFor(
                                        editing.provider,
                                        resolveExpert(
                                          editing,
                                          model,
                                          providerId,
                                        ).model,
                                      )
                                      ?.reasoningEfforts?.includes(
                                        editing.reasoning,
                                      )
                                      ? "Choose a reasoning level supported by the selected model."
                                      : undefined
                                  }
                                  value={editing.reasoning || ""}
                                  onChange={(e) =>
                                    setEditing({
                                      ...editing,
                                      reasoning: e.target.value,
                                    })
                                  }
                                >
                                  <MenuItem value="">Unspecified</MenuItem>
                                  {editing.reasoning &&
                                    !registry
                                      .capabilitiesFor(
                                        editing.provider,
                                        resolveExpert(
                                          editing,
                                          model,
                                          providerId,
                                        ).model,
                                      )
                                      ?.reasoningEfforts?.includes(
                                        editing.reasoning,
                                      ) && (
                                      <MenuItem
                                        value={editing.reasoning}
                                        disabled
                                      >
                                        {statusLabel(editing.reasoning)}{" "}
                                        (unsupported for selected model)
                                      </MenuItem>
                                    )}
                                  {registry
                                    .capabilitiesFor(
                                      editing.provider,
                                      resolveExpert(editing, model, providerId)
                                        .model,
                                    )
                                    ?.reasoningEfforts?.map((v) => (
                                      <MenuItem key={v} value={v}>
                                        {statusLabel(v)}
                                      </MenuItem>
                                    ))}
                                </TextField>
                              )}
                            </Box>
                          </Stack>
                        </Box>
                        <Stack
                          direction="row"
                          flexWrap="wrap"
                          justifyContent="flex-end"
                          gap={1}
                          sx={{ mt: 2 }}
                        >
                          {((requireExpertModel && !editing.model) ||
                            expertSettingsError(
                              editing,
                              model,
                              registry,
                              providerId,
                            )) && (
                            <Typography
                              role="status"
                              color="error"
                              variant="body2"
                              sx={{ flexBasis: "100%" }}
                            >
                              {requireExpertModel && !editing.model
                                ? "Select a model for the selected provider."
                                : expertSettingsError(
                                    editing,
                                    model,
                                    registry,
                                    providerId,
                                  )}
                            </Typography>
                          )}
                          <Button
                            onClick={() =>
                              editAgent(
                                experts.find(
                                  (agent) => agent.id === editing.id,
                                ) ?? null,
                              )
                            }
                          >
                            Cancel Changes
                          </Button>
                          <Button
                            variant="contained"
                            disabled={
                              !editingDirty ||
                              (requireExpertModel && !editing.model) ||
                              !!expertSettingsError(
                                editing,
                                model,
                                registry,
                                providerId,
                              )
                            }
                            onClick={() => {
                              setExperts((current) =>
                                current.map((agent) =>
                                  agent.id === editing.id
                                    ? structuredClone(editing)
                                    : agent,
                                ),
                              );
                              setInactiveIds((current) => {
                                const wasActive = !current.includes(editing.id);
                                return wasActive === draftActive
                                  ? current
                                  : toggleId(current, editing.id);
                              });
                            }}
                          >
                            Save
                          </Button>
                        </Stack>
                      </Box>
                    </Paper>
                  )}
                </Stack>
              </Box>
            )}
            {generationAttempts.length > 0 && (
              <Typography variant="caption" color="text.secondary">
                Architect usage: {usage(generationAttempts)} ·{" "}
                {seconds(
                  generationAttempts.reduce(
                    (total, attempt) => total + attempt.ms,
                    0,
                  ),
                )}
              </Typography>
            )}
          </Stack>
        </Box>
        <Box
          role="tabpanel"
          id="panel-tools"
          aria-labelledby="tab-tools"
          hidden={tab !== "tools"}
        >
          <ToolsPage agents={experts} toolRegistry={toolRegistry} />
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
            onConsoleStatusChange={setConsoleHeaderStatus}
            openAIKeyPresent={!!key.trim()}
            registry={registry}
            adapter={adapter}
            keys={{ openai: key, ...openCodeKeys, gemini: geminiKey }}
            referencedProviders={experts.flatMap((expert) =>
              expert.provider ? [expert.provider] : [],
            )}
            onDiscovery={() => redraw((n) => n + 1)}
            onSaveBuiltin={(id, value, selectedModel, verified) => {
              if (id === "openai") {
                if (value !== connectionController.getKey())
                  connectionController.updateKey(value);
                if (selectedModel && selectedModel !== openAIModel) {
                  connectionController.invalidate();
                  setOpenAIModel(selectedModel);
                }
                if (verified) connectionController.adoptVerified(value);
                else if (verification !== "unverified")
                  connectionController.invalidate();
              } else if (id === "gemini") setGeminiKey(value);
              else setOpenCodeKeys((current) => ({ ...current, [id]: value }));
            }}
          />
        </Box>

        <Dialog
          open={clearOpen}
          onClose={() => setClearOpen(false)}
          aria-labelledby="clear-results-title"
        >
          <DialogTitle id="clear-results-title">Clear Results?</DialogTitle>
          <DialogContent>
            <Typography>
              Remove all experiment results and history from this session?
            </Typography>
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setClearOpen(false)}>Cancel</Button>
            <Button
              color="error"
              variant="contained"
              disabled={active}
              onClick={() => {
                setRuns([]);
                setLatestRunIds([]);
                setResultTab("results");
                setRunError("");
                setClearOpen(false);
              }}
            >
              Clear Results
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
            Add Agent
            <IconButton
              aria-label="Close Add Agent"
              disabled={!!generating}
              onClick={() => setAddOpen(false)}
              sx={{ float: "right" }}
            >
              <Close />
            </IconButton>
          </DialogTitle>
          <DialogContent>
            <Stack
              direction="row"
              spacing={0.5}
              alignItems="center"
              sx={{ mb: 1 }}
            >
              <Typography
                component="label"
                htmlFor="agent-instructions"
                variant="subtitle2"
              >
                Describe one or more agents...
              </Typography>
              <Tooltip
                open={creationHelpOpen}
                onOpen={() => setCreationHelpOpen(true)}
                onClose={() => setCreationHelpOpen(false)}
                describeChild
                title={
                  <Box>
                    <Typography variant="subtitle2">
                      How to create agents
                    </Typography>
                    <Typography variant="caption" component="p">
                      Describe one or more agents in natural language. The
                      Architect will determine how many agents to create.
                    </Typography>
                    <Box component="ul" sx={{ my: 0.5, pl: 2 }}>
                      <li>Create a philosopher agent.</li>
                      <li>
                        Create two agents: a mathematician and a philosopher.
                        Give each a distinct role and expertise.
                      </li>
                    </Box>
                  </Box>
                }
              >
                <IconButton
                  size="small"
                  aria-label="How to create agents"
                  onClick={() => setCreationHelpOpen(true)}
                >
                  <InfoOutlined fontSize="small" />
                </IconButton>
              </Tooltip>
            </Stack>
            <TextField
              id="agent-instructions"
              autoFocus
              multiline
              minRows={4}
              disabled={generating}
              value={addText}
              onChange={(event) => setAddText(event.target.value)}
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
              onClick={() => void generate()}
            >
              {generating ? "Generating…" : "Create Agents"}
            </Button>
          </DialogActions>
        </Dialog>
        <Dialog
          open={pendingAgentAction !== null}
          onClose={() => setPendingAgentAction(null)}
          aria-labelledby="switch-agent-title"
        >
          <DialogTitle id="switch-agent-title">
            Discard unsaved agent changes?
          </DialogTitle>
          <DialogContent>
            <Typography>
              Opening another agent will discard changes to the current draft.
            </Typography>
          </DialogContent>
          <DialogActions>
            <Button autoFocus onClick={() => setPendingAgentAction(null)}>
              Keep Editing
            </Button>
            <Button
              onClick={() => {
                if (pendingAgentAction) applyAgentAction(pendingAgentAction);
                setPendingAgentAction(null);
              }}
            >
              Discard and Switch
            </Button>
          </DialogActions>
        </Dialog>
        <Dialog
          open={!!agentToDelete}
          onClose={() => setAgentToDeleteId(null)}
          aria-labelledby="delete-agent-title"
        >
          <DialogTitle id="delete-agent-title">Delete agent?</DialogTitle>
          <DialogContent>
            <Typography>Remove {agentToDelete?.name} from the team?</Typography>
          </DialogContent>
          <DialogActions>
            <Button autoFocus onClick={() => setAgentToDeleteId(null)}>
              Cancel
            </Button>
            <Button
              color="error"
              onClick={() => {
                if (agentToDelete) deleteAgent(agentToDelete.id);
              }}
            >
              Delete agent
            </Button>
          </DialogActions>
        </Dialog>
      </Container>
    </ThemeProvider>
  );
}
