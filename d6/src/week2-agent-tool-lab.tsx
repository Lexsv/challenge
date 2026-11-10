import { useEffect, useMemo, useRef, useState } from "react";
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Box,
  Button,
  Chip,
  IconButton,
  MenuItem,
  Paper,
  Popover,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import ExpandMore from "@mui/icons-material/ExpandMore";
import SettingsOutlined from "@mui/icons-material/SettingsOutlined";
import SendRounded from "@mui/icons-material/SendRounded";
import type { ProviderRegistry } from "./provider-registry";
import { ManagerAgent, createManagerConversation } from "./manager-agent";
import { createManagerLlmAdapter } from "./manager-llm-adapter";
import type { ToolRegistry } from "./tool-runtime";
import type { ManagerConversationState } from "./manager-agent";
import type { OpenCodeConnection, OpenCodeKeys } from "./builtin-connection-settings";
import { AnswerMarkdown } from "./answer-markdown";
import type { ToolExecutionType } from "./tool-execution-type";
import { toolExecutionTypeMeta } from "./tool-execution-type";

type Week2Provider = "openai" | OpenCodeConnection;

const timeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

function formatTimelineTime(timestamp: number): string {
  return timeFormatter.format(timestamp);
}

type TimelineEvent =
  | {
      kind: "message";
      id: string;
      createdAt: number;
      role: "user" | "assistant" | "system";
      text: string;
      runId: string;
    }
  | {
      kind: "tool";
      id: string;
      createdAt: number;
      runId: string;
      toolId: string;
      toolName: string;
      toolCallId?: string;
      executionType?: ToolExecutionType;
      status: "pending" | "running" | "completed" | "failed";
      arguments: unknown;
      output?: unknown;
      error?: string;
      durationMs: number;
      category: "TOOL";
    }
  | {
      kind: "manager";
      id: string;
      createdAt: number;
      runId: string;
      category: "MANAGER" | "SYSTEM";
      status: "pending" | "running" | "completed" | "failed";
      description: string;
    };

export const technicalEventMaxWidth = { xs: "100%", md: "70%" } as const;

export function timelineToolCategoryLabel(executionType?: ToolExecutionType): string {
  if (!executionType) return "TOOL";
  return toolExecutionTypeMeta[executionType].label.toUpperCase();
}

export function buildWeek2Timeline(
  state: ManagerConversationState | null,
  toolRegistry: ToolRegistry,
): TimelineEvent[] {
  if (!state) return [];
  const messages: TimelineEvent[] = state.messages.map((message) => ({
    kind: "message",
    id: message.id,
    createdAt: message.createdAt,
    role: message.role,
    text: message.text,
    runId: message.runId,
  }));
  const tools: TimelineEvent[] = state.toolExecutions.map((execution) => {
    const registered = toolRegistry.get(execution.toolId);
    return {
      kind: "tool",
      id: execution.id,
      createdAt: execution.startedAt,
      runId: execution.runId,
      toolId: execution.toolId,
      toolName: registered?.name ?? execution.toolId,
      toolCallId: execution.toolCallId,
      executionType: registered?.executionType,
      status: execution.status,
      arguments: execution.arguments,
      output: execution.output,
      error: execution.error,
      durationMs: Math.max(0, (execution.endedAt ?? execution.startedAt) - execution.startedAt),
      category: "TOOL",
    };
  });
  const runs: TimelineEvent[] = state.runs.flatMap((run) => {
    const started: TimelineEvent = {
      kind: "manager",
      id: `${run.id}:start`,
      createdAt: run.startedAt,
      runId: run.id,
      category: "MANAGER",
      status: "running",
      description: "Run started",
    };
    const ended = run.endedAt
      ? {
          kind: "manager" as const,
          id: `${run.id}:end`,
          createdAt: run.endedAt,
          runId: run.id,
          category: (run.status === "failed" ? "SYSTEM" : "MANAGER") as
            | "SYSTEM"
            | "MANAGER",
          status: run.status,
          description: run.status === "failed" ? "Run failed" : "Run completed",
        }
      : undefined;
    return ended ? [started, ended] : [started];
  });
  const runOrder = new Map(state.runs.map((run, index) => [run.id, index]));
  const messageOrder = new Map(state.messages.map((message, index) => [message.id, index]));
  const toolOrder = new Map(state.toolExecutions.map((execution, index) => [execution.id, index]));
  const phase = (event: TimelineEvent): number => {
    if (event.kind === "message") return event.role === "user" ? 0 : 3;
    if (event.kind === "tool") return 2;
    return event.id.endsWith(":start") ? 1 : 4;
  };
  const insertionOrder = (event: TimelineEvent): number => {
    if (event.kind === "message") return messageOrder.get(event.id) ?? 0;
    if (event.kind === "tool") return toolOrder.get(event.id) ?? 0;
    return 0;
  };
  return [...messages, ...tools, ...runs].sort(
    (a, b) =>
      a.createdAt - b.createdAt ||
      (runOrder.get(a.runId) ?? 0) - (runOrder.get(b.runId) ?? 0) ||
      phase(a) - phase(b) ||
      insertionOrder(a) - insertionOrder(b),
  );
}

export function Week2AgentToolLab({
  toolRegistry,
  registry,
  openAIModel,
  onOpenAIModelChange,
  openAIKey,
  openCodeKeys,
}: {
  toolRegistry: ToolRegistry;
  registry: ProviderRegistry;
  openAIModel: string;
  onOpenAIModelChange: (model: string) => void;
  openAIKey: string;
  openCodeKeys: OpenCodeKeys;
}) {
  const [provider, setProvider] = useState<Week2Provider>("openai");
  const [openCodeModels, setOpenCodeModels] = useState<Record<OpenCodeConnection, string>>({
    "opencode-console": "",
    "opencode-go": "",
  });
  const [settingsAnchor, setSettingsAnchor] = useState<HTMLElement | null>(null);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [uiEvents, setUiEvents] = useState<TimelineEvent[]>([]);
  const [conversation, setConversation] = useState<ManagerConversationState | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);

  const providerModels = registry.modelOptionsFor(provider);
  const selectedModel =
    provider === "openai" ? openAIModel : openCodeModels[provider] || providerModels[0] || "";
  const selectedKey = provider === "openai" ? openAIKey : openCodeKeys[provider];
  const providerLabel =
    provider === "openai"
      ? "OpenAI"
      : provider === "opencode-console"
        ? "OpenCode Console"
        : "OpenCode Go";
  const hasCredential = !!selectedKey.trim();
  const timeline = useMemo(
    () =>
      [...buildWeek2Timeline(conversation, toolRegistry), ...uiEvents].sort(
        // Stable sorting retains causal conversation order and UI insertion order on ties.
        (a, b) => a.createdAt - b.createdAt,
      ),
    [conversation, uiEvents, toolRegistry],
  );

  useEffect(() => {
    if (!stickToBottomRef.current) return;
    const container = scrollRef.current;
    if (!container) return;
    container.scrollTop = container.scrollHeight;
  }, [timeline.length, running]);

  const send = async () => {
    if (running) return;
    const question = input.trim();
    if (!question) return;
    if (!selectedModel) {
      setUiEvents((events) => [
        ...events,
        {
          kind: "manager",
          id: crypto.randomUUID(),
          createdAt: Date.now(),
          runId: "ui",
          category: "SYSTEM",
          status: "failed",
          description: "Select a model for the Manager Agent.",
        },
      ]);
      return;
    }
    if (!selectedKey.trim()) {
      setUiEvents((events) => [
        ...events,
        {
          kind: "manager",
          id: crypto.randomUUID(),
          createdAt: Date.now(),
          runId: "ui",
          category: "SYSTEM",
          status: "failed",
          description: "No credentials found for this provider. Configure it in Providers.",
        },
      ]);
      return;
    }
    const working = conversation ? structuredClone(conversation) : createManagerConversation();
    setRunning(true);
    try {
      const adapter = createManagerLlmAdapter({
        providerId: provider,
        model: selectedModel,
        apiKey: selectedKey,
        registry,
      });
      const manager = new ManagerAgent(adapter, toolRegistry, {
        maxIterations: 8,
      });
      const pendingResult = manager.run({
        state: working,
        userText: question,
        maxIterations: 8,
      });
      // run() records the user message before its first provider await.
      setConversation(structuredClone(working));
      const result = await pendingResult;
      setConversation(structuredClone(result.state));
      if (result.error) {
        setUiEvents((events) => [
          ...events,
          {
            kind: "manager",
            id: crypto.randomUUID(),
            createdAt: Date.now(),
            runId: result.run.id,
            category: "SYSTEM",
            status: "failed",
            description: result.error ?? "Run failed.",
          },
        ]);
      }
      setInput("");
    } catch {
      const activeRun = working.runs.at(-1);
      if (activeRun) {
        activeRun.status = "failed";
        activeRun.endedAt = Date.now();
        setConversation(structuredClone(working));
      }
      setUiEvents((events) => [
        ...events,
        {
          kind: "manager",
          id: crypto.randomUUID(),
          createdAt: Date.now(),
          runId: activeRun?.id ?? "ui",
          category: "SYSTEM",
          status: "failed",
          description:
            "Manager execution failed. Check provider, model, key, and tool compatibility.",
        },
      ]);
    } finally {
      setRunning(false);
    }
  };

  return (
    <Stack spacing={2}>
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Stack spacing={1.5}>
          <Stack direction="row" alignItems="center" justifyContent="space-between">
            <Typography variant="h6" component="h3">
              Agent Tool Lab
            </Typography>
            <IconButton
              size="small"
              aria-label="Open chat settings"
              onClick={(event) => setSettingsAnchor(event.currentTarget)}
            >
              <SettingsOutlined fontSize="small" />
            </IconButton>
          </Stack>
          {!timeline.length && (
            <Typography color="text.secondary">
              Start a conversation with {providerLabel} · {selectedModel || "Select a model"}
            </Typography>
          )}
          {!hasCredential && (
            <Typography variant="caption" color="text.secondary">
              Credentials for {providerLabel} are managed in Providers.
            </Typography>
          )}
          <Popover
            open={!!settingsAnchor}
            anchorEl={settingsAnchor}
            onClose={() => setSettingsAnchor(null)}
            anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
            transformOrigin={{ vertical: "top", horizontal: "right" }}
          >
            <Stack spacing={1.25} sx={{ p: 1.5, minWidth: 260 }}>
              <TextField
                select
                label="Provider"
                size="small"
                value={provider}
                onChange={(event) => setProvider(event.target.value as Week2Provider)}
              >
                <MenuItem value="openai">OpenAI</MenuItem>
                <MenuItem value="opencode-console">OpenCode Console</MenuItem>
                <MenuItem value="opencode-go">OpenCode Go</MenuItem>
              </TextField>
              <TextField
                select
                label="Model"
                size="small"
                value={selectedModel}
                onChange={(event) => {
                  const value = event.target.value;
                  if (provider === "openai") onOpenAIModelChange(value);
                  else
                    setOpenCodeModels((current) => ({
                      ...current,
                      [provider]: value,
                    }));
                }}
              >
                {!providerModels.length && <MenuItem value="">No models available</MenuItem>}
                {providerModels.map((entry) => (
                  <MenuItem key={entry} value={entry}>
                    {entry}
                  </MenuItem>
                ))}
              </TextField>
            </Stack>
          </Popover>
          <Box
            ref={scrollRef}
            sx={{
              minHeight: 380,
              maxHeight: 500,
              overflowY: "auto",
              pr: 0.5,
              display: "flex",
              flexDirection: "column",
              gap: 1,
            }}
            onScroll={(event) => {
              const element = event.currentTarget;
              const nearBottom =
                element.scrollHeight - (element.scrollTop + element.clientHeight) < 80;
              stickToBottomRef.current = nearBottom;
            }}
            aria-label="Week 2 conversation history"
          >
            {timeline.map((event) => (
              <Box
                key={event.id}
                sx={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 1,
                  width: "100%",
                  minWidth: 0,
                }}
              >
              {event.kind === "message" ? (
                <Box
                  key={event.id}
                  sx={{
                    alignSelf: "flex-start",
                    width: "fit-content",
                    maxWidth: { xs: "100%", sm: "70%" },
                    minWidth: 0,
                    flex: "0 1 auto",
                    px: 1,
                    py: 0.6,
                    borderRadius: "8px",
                    bgcolor: "background.default",
                    color: "text.primary",
                    border: "1px solid",
                    borderColor: "divider",
                  }}
                >
                  <Box sx={{ mb: 0.35 }}>
                    <Chip
                      size="small"
                      color={event.role === "user" ? "primary" : event.role === "assistant" ? "secondary" : "warning"}
                      label={event.role === "user" ? "USER" : event.role === "assistant" ? "AGENT" : "SYSTEM"}
                    />
                  </Box>
                  {event.role === "assistant" ? (
                    <Box sx={{ "& p": { m: 0 }, "& pre": { overflowX: "auto" } }}>
                      <AnswerMarkdown text={event.text} />
                    </Box>
                  ) : (
                    <Typography variant="body2" sx={{ whiteSpace: "pre-wrap" }}>
                      {event.text}
                    </Typography>
                  )}
                </Box>
              ) : event.kind === "tool" ? (
                <Accordion
                  key={event.id}
                  disableGutters
                  sx={{
                    alignSelf: "flex-start",
                    width: "fit-content",
                    maxWidth: technicalEventMaxWidth,
                    minWidth: 0,
                    flex: "0 1 auto",
                    border: "1px solid",
                    borderColor: "divider",
                    borderRadius: "8px",
                    overflow: "hidden",
                    bgcolor: "background.default",
                    boxShadow: "none",
                    "&.MuiAccordion-root": { borderRadius: "8px" },
                    "&:before": { display: "none" },
                  }}
                >
                  <AccordionSummary expandIcon={<ExpandMore />} sx={{ minHeight: 34, py: 0 }}>
                    <Stack direction="row" spacing={0.75} alignItems="center" sx={{ minWidth: 0, width: "100%" }}>
                      <Chip
                        size="small"
                        label={timelineToolCategoryLabel(event.executionType)}
                        sx={
                          event.executionType
                            ? {
                                bgcolor: toolExecutionTypeMeta[event.executionType].background,
                                color: toolExecutionTypeMeta[event.executionType].color,
                              }
                            : undefined
                        }
                      />
                      <Typography variant="body2" sx={{ overflowWrap: "anywhere" }}>
                        {event.toolName}
                      </Typography>
                      <Chip
                        size="small"
                        color={event.status === "completed" ? "success" : event.status === "failed" ? "error" : "default"}
                        label={event.status}
                      />
                    </Stack>
                  </AccordionSummary>
                  <AccordionDetails sx={{ pt: 0.5, minWidth: 0 }}>
                    <Stack spacing={0.75} sx={{ minWidth: 0, maxWidth: "100%" }}>
                      <Typography
                        variant="caption"
                        color="text.secondary"
                        sx={{ overflowWrap: "anywhere" }}
                      >
                        Tool ID: {event.toolId}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        Duration: {event.durationMs} ms
                      </Typography>
                      <Typography variant="subtitle2">Arguments</Typography>
                      <Box component="pre" sx={{ m: 0, p: 1, maxWidth: "100%", borderRadius: "8px", bgcolor: "background.paper", whiteSpace: "pre-wrap", overflowWrap: "anywhere", overflowX: "auto", fontSize: "0.76rem" }}>
                        {JSON.stringify(event.arguments, null, 2)}
                      </Box>
                      <Typography variant="subtitle2">Result</Typography>
                      <Box component="pre" sx={{ m: 0, p: 1, maxWidth: "100%", borderRadius: "8px", bgcolor: "background.paper", whiteSpace: "pre-wrap", overflowWrap: "anywhere", overflowX: "auto", fontSize: "0.76rem" }}>
                        {event.error
                          ? JSON.stringify({ error: event.error }, null, 2)
                          : JSON.stringify(event.output, null, 2)}
                      </Box>
                    </Stack>
                  </AccordionDetails>
                </Accordion>
              ) : (
                <Paper
                  variant="outlined"
                  sx={{
                    alignSelf: "flex-start",
                    width: "fit-content",
                    maxWidth: technicalEventMaxWidth,
                    minWidth: 0,
                    flex: "0 1 auto",
                    px: 1,
                    py: 0.6,
                    borderRadius: "8px",
                    bgcolor: "background.default",
                    borderColor: "divider",
                  }}
                >
                  <Stack direction="row" spacing={0.75} alignItems="center" sx={{ minWidth: 0 }}>
                    <Chip
                      size="small"
                      color={event.category === "SYSTEM" ? "warning" : "secondary"}
                      label={event.category}
                    />
                    <Typography variant="body2" sx={{ overflowWrap: "anywhere" }}>
                      {event.description}
                    </Typography>
                    <Chip
                      size="small"
                      color={event.status === "completed" ? "success" : event.status === "failed" ? "error" : "default"}
                      label={event.status}
                    />
                  </Stack>
                </Paper>
              )}
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{
                  ml: "auto",
                  pt: 0.5,
                  flexShrink: 0,
                  whiteSpace: "nowrap",
                  textAlign: "right",
                }}
              >
                {formatTimelineTime(event.createdAt)}
              </Typography>
              </Box>
            ))}
            {running && (
              <Typography variant="caption" color="text.secondary">
                Manager is processing…
              </Typography>
            )}
          </Box>
          <Stack
            direction="row"
            spacing={1}
            alignItems="flex-end"
            sx={{
              position: "sticky",
              bottom: 0,
              bgcolor: "background.paper",
              pt: 0.5,
            }}
          >
            <TextField
              fullWidth
              placeholder="Message"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void send();
                }
              }}
              multiline
              minRows={1}
              maxRows={6}
              disabled={running}
              sx={{
                "& .MuiOutlinedInput-root": {
                  borderRadius: "8px",
                },
                "& textarea": {
                  overflowY: "auto",
                },
              }}
            />
            <Button
              variant="contained"
              onClick={() => void send()}
              disabled={running || !input.trim()}
              aria-label="Send message"
              sx={{
                width: 48,
                height: 48,
                minWidth: 48,
                minHeight: 48,
                p: 0,
                flexShrink: 0,
                alignSelf: "flex-end",
                borderRadius: "8px",
              }}
            >
              <SendRounded fontSize="small" />
            </Button>
          </Stack>
        </Stack>
      </Paper>
    </Stack>
  );
}
