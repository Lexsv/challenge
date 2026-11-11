import { ChatComposer } from "./chat-composer";
import { ChatRunLog } from "./chat-run-log";
import { contextPhaseLabel } from "./context-compaction";
import { createAndSelectSession } from "./session-creation";
import { EmptySessionChat, SessionCreateButton } from "./session-empty-state";
import type { ModelRequestMeter } from "./token-meter";
import { isWeek2Provider, unsupportedWeek2ProviderMessage, week2ProviderOptions } from "./week2-provider";
import { SessionDeletion } from "./session-deletion";
import { SessionRow } from "./session-row";
import { submitSession } from "./session-send";
import { credentials } from "./saved-credentials";
import { HistoryWriter, restoreHistory } from "./conversation-history";
import { listSessions, createSession as persistSession, renameSession, emptySession, loadHistory, saveHistoryEvent, deleteSession } from "./session-api";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  Alert,
  Box,
  Button,
  IconButton,
  Menu,
  MenuItem,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  List,
  Paper,
  Popover,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import SettingsOutlined from "@mui/icons-material/SettingsOutlined";
import type { ProviderRegistry } from "./provider-registry";
import { ManagerAgent, createManagerConversation } from "./manager-agent";
import { createManagerLlmAdapter } from "./manager-llm-adapter";
import type { ToolRegistry } from "./tool-runtime";
import type { ManagerConversationState } from "./manager-agent";
import type { OpenCodeConnection, OpenCodeKeys } from "./builtin-connection-settings";
import type { ToolExecutionType } from "./tool-execution-type";
import { toolExecutionTypeMeta } from "./tool-execution-type";

type Week2Provider = "openai" | OpenCodeConnection;

export type TimelineEvent =
  | { kind: "metering"; id: string; createdAt: number; runId: string; meter: ModelRequestMeter }
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
      status: "pending" | "running" | "completed" | "failed" | "incomplete";
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
      status: "pending" | "running" | "completed" | "failed" | "incomplete";
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
    if (run.status === 'incomplete') {
      started.status = 'incomplete';
      started.category = 'SYSTEM';
      started.description = 'Run incomplete after interruption';
    }
    return ended ? [started, ended] : [started];
  });
  const runOrder = new Map(state.runs.map((run, index) => [run.id, index]));
  const messageOrder = new Map(state.messages.map((message, index) => [message.id, index]));
  const toolOrder = new Map(state.toolExecutions.map((execution, index) => [execution.id, index]));
  const phase = (event: TimelineEvent): number => {
    if (event.kind === "metering") return 2;
    if (event.kind === "message") return event.role === "user" ? 0 : 3;
    if (event.kind === "tool") return 2;
    return event.id.endsWith(":start") ? 1 : 4;
  };
  const insertionOrder = (event: TimelineEvent): number => {
    if (event.kind === "message") return messageOrder.get(event.id) ?? 0;
    if (event.kind === "tool") return (toolOrder.get(event.id) ?? 0) * 2 + 1;
    if (event.kind === "metering") return (event.meter.toolExecutionOffset ?? 0) * 2;
    return 0;
  };
  const meters: TimelineEvent[] = (state.requestMeters ?? []).map((meter) => ({ kind: 'metering', id: meter.id, createdAt: meter.startedAt, runId: meter.runId, meter }));
  const contexts: TimelineEvent[] = (state.contextEvents ?? []).map((event) => {
    const run = state.runs.find((item) => item.id === event.runId);
    const pending = ['compacting', 'retrying'].includes(event.phase);
    const latest = state.contextEvents?.filter((item) => item.runId === event.runId).at(-1);
    const status = event.phase === 'failed' ? 'failed'
      : pending && run?.status === 'incomplete' ? 'incomplete'
      : pending && run?.status === 'running' && latest?.id === event.id ? 'running' : 'completed';
    return {
      kind: 'manager', id: event.id, createdAt: event.createdAt, runId: event.runId, category: 'SYSTEM', status,
      description: contextPhaseLabel[event.phase] + (event.afterTokens !== undefined
        ? ` · ${event.beforeTokens} → ${event.afterTokens} estimated input tokens` : ''),
    };
  });
  return [...messages, ...tools, ...runs, ...meters, ...contexts].sort(
    (a, b) =>
      a.createdAt - b.createdAt ||
      (runOrder.get(a.runId) ?? 0) - (runOrder.get(b.runId) ?? 0) ||
      phase(a) - phase(b) ||
      insertionOrder(a) - insertionOrder(b),
  );
}

type LabProps = {
  toolRegistry: ToolRegistry;
  registry: ProviderRegistry;
  openAIModel: string;
  onOpenAIModelChange: (model: string) => void;
  openAIKey: string;
  openCodeKeys: OpenCodeKeys;
};

export function Week2AgentToolLab(props: LabProps) {
  const [sessions, setSessions] = useState<ManagerConversationState[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [context, setContext] = useState<{ id: string; x: number; y: number } | null>(null);
  const [renameId, setRenameId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const saveLock = useRef(false);
  const [deletion] = useState(() => new SessionDeletion(deleteSession, (id) => {
    setSessions((current) => current.filter((session) => session.conversation.id !== id));
    setSelectedId((current) => current === id ? null : current);
  }));
  const deleteState = useSyncExternalStore(deletion.subscribe, deletion.getSnapshot, deletion.getSnapshot);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    listSessions().then((items) => {
      if (!active) return;
      setSessions(items.map(emptySession));
      setLoaded(true);
      setSelectedId(items[0]?.id ?? null);
    }).catch(() => {
      if (active) setError("Could not load sessions. Check the local backend and retry.");
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [loadAttempt]);
  const createDisabled = loading || !loaded || saving || deleteState.pending;
  const createSession = () => { void createAndSelectSession({
    lock: saveLock, ready: loaded && !loading && !deleteState.pending, create: persistSession,
    onPending: setSaving, onError: setError,
    onCreated: (saved) => {
      const session = emptySession(saved);
      setSessions((current) => [...current, session]);
      setSelectedId(session.conversation.id);
    },
  }); };
  const rename = async () => {
    if (!title.trim() || !renameId || saveLock.current) return;
    saveLock.current = true;
    setSaving(true);
    setError("");
    try {
      const saved = await renameSession(renameId, title.trim());
      setSessions((current) => current.map((session) =>
        session.conversation.id === saved.id
          ? { ...session, conversation: { ...session.conversation, title: saved.title } }
          : session,
      ));
      setRenameId(null);
    } catch {
      setError("Could not rename session. The saved title is unchanged. Please retry.");
    } finally { saveLock.current = false; setSaving(false); }
  };
  return (
    <Box sx={{ display: "grid", gridTemplateColumns: { xs: "minmax(0, 1fr)", md: "240px minmax(0, 1fr)" }, gap: 2, alignItems: "start" }}>
      <Paper component="aside" variant="outlined" aria-label="Sessions" sx={{ p: 1, minWidth: 0 }}>
        <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ px: 1 }}>
          <Typography variant="subtitle2" color="text.secondary">Sessions</Typography>
          <SessionCreateButton compact onCreate={createSession} pending={saving} disabled={createDisabled} />
        </Stack>
        {loading && <Typography variant="caption" role="status">Loading sessions…</Typography>}
        {error && <Alert severity="error" action={!loaded ? <Button onClick={() => setLoadAttempt((n) => n + 1)}>Retry</Button> : undefined}>{error}</Alert>}
        <List disablePadding aria-label="Session list">
          {sessions.map((session) => (
            <SessionRow key={session.conversation.id} id={session.conversation.id} title={session.conversation.title ?? 'New session'}
              selected={selectedId === session.conversation.id} menuOpen={context?.id === session.conversation.id}
              disabled={saving || deleteState.pending} onSelect={() => setSelectedId(session.conversation.id)}
              onActions={(position) => setContext({ id: session.conversation.id, ...position })} />
          ))}
        </List>
      </Paper>
      <Box sx={{ minWidth: 0 }}>
        {!selectedId && (
          <EmptySessionChat showEmptyState={loaded && !loading && sessions.length === 0}
            onCreate={createSession} pending={saving} disabled={createDisabled} />
        )}
        {/* Keep each keyed chat mounted: its draft, timeline and pending run belong to that session. */}
        {sessions.map((session) => (
          <Box key={session.conversation.id} hidden={selectedId !== session.conversation.id}>
            <SessionChat {...props} active={selectedId === session.conversation.id} initialConversation={session} title={session.conversation.title ?? "New session"} />
          </Box>
        ))}
      </Box>
      <Menu id="session-actions-menu" slotProps={{ list: { "aria-labelledby": context ? `session-actions-${context.id}` : undefined } }} open={!!context} onClose={() => setContext(null)} anchorReference="anchorPosition"
        anchorPosition={context ? { top: context.y, left: context.x } : undefined}>
        <MenuItem disabled={saving || deleteState.pending} onClick={() => {
          if (!context) return;
          setRenameId(context.id);
          setTitle(sessions.find((session) => session.conversation.id === context.id)?.conversation.title ?? "");
          setContext(null);
        }}>Rename</MenuItem>
        <MenuItem disabled={saving || deleteState.pending} onClick={() => {
          const session = sessions.find((entry) => entry.conversation.id === context?.id);
          if (session) deletion.request({ id: session.conversation.id, title: session.conversation.title ?? 'New session' });
          setContext(null);
        }}>Delete</MenuItem>
      </Menu>
      <Dialog open={!!deleteState.target} onClose={() => deletion.cancel()} aria-labelledby="delete-session-title" aria-describedby="delete-session-description" fullWidth maxWidth="xs">
        <DialogTitle id="delete-session-title">Delete session “{deleteState.target?.title}”?</DialogTitle>
        <DialogContent>
          <Typography id="delete-session-description">This session and its entire history, including messages, tool calls, results, and Timeline entries, will be permanently deleted.</Typography>
          {deleteState.error && <Alert severity="error" sx={{ mt: 1 }}>{deleteState.error}</Alert>}
        </DialogContent>
        <DialogActions><Button autoFocus disabled={deleteState.pending} onClick={() => deletion.cancel()}>Cancel</Button><Button color="error" disabled={deleteState.pending} onClick={() => void deletion.confirm()}>{deleteState.pending ? 'Deleting…' : 'Delete'}</Button></DialogActions>
      </Dialog>
      <Dialog open={!!renameId} onClose={() => { if (!saving) setRenameId(null); }} fullWidth maxWidth="xs">
        <Box component="form" onSubmit={(event) => { event.preventDefault(); void rename(); }}>
          <DialogTitle>Rename session</DialogTitle>
          <DialogContent>{error && <Alert severity="error">{error}</Alert>}<TextField autoFocus fullWidth margin="dense" label="Session title" inputProps={{ maxLength: 200 }} disabled={saving} value={title} onChange={(event) => setTitle(event.target.value)} /></DialogContent>
          <DialogActions><Button disabled={saving} onClick={() => setRenameId(null)}>Cancel</Button><Button type="submit" disabled={saving || !title.trim()}>Save</Button></DialogActions>
        </Box>
      </Dialog>
    </Box>
  );
}

export function SessionChat({
  toolRegistry,
  registry,
  openAIModel,
  onOpenAIModelChange,
  openAIKey,
  openCodeKeys,
  initialConversation,
  active = true,
  title,
}: {
  toolRegistry: ToolRegistry;
  registry: ProviderRegistry;
  openAIModel: string;
  onOpenAIModelChange: (model: string) => void;
  openAIKey: string;
  openCodeKeys: OpenCodeKeys;
  initialConversation: ManagerConversationState;
  active?: boolean;
  title: string;
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
  const [conversation, setConversation] = useState<ManagerConversationState | null>(() => structuredClone(initialConversation));
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [historyAttempt, setHistoryAttempt] = useState(0);
  const [saveFailed, setSaveFailed] = useState(false);
  const [retryingSave, setRetryingSave] = useState(false);
  const sendLock = useRef(false);
  const [writer] = useState(() => new HistoryWriter(saveHistoryEvent));
  useEffect(() => {
    if (!active || historyLoaded) return;
    let current = true;
    setHistoryError("");
    loadHistory(initialConversation.conversation.id).then((events) => {
      if (!current) return;
      setConversation(restoreHistory(initialConversation, events));
      setHistoryLoaded(true);
    }).catch(() => { if (current) setHistoryError("Could not load conversation history. Retry before sending."); });
    return () => { current = false; };
  }, [active, historyLoaded, historyAttempt, initialConversation]);
  const retrySave = async () => {
    setRetryingSave(true);
    try {
      await writer.flush();
      setConversation(restoreHistory(initialConversation, await loadHistory(initialConversation.conversation.id)));
      setSaveFailed(false); setHistoryError("");
    }
    catch { setHistoryError("History save failed. Retry to save pending events; tools will not be replayed."); }
    finally { setRetryingSave(false); }
  };
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
  const credentialStates = useSyncExternalStore(credentials.subscribe, credentials.getSnapshot, credentials.getSnapshot);
  const savedCredential = credentialStates[provider];
  const useSavedKey = !selectedKey.trim() && !!savedCredential?.saved;
  const hasCredential = !!selectedKey.trim() || useSavedKey;
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
  }, [timeline, running]);

  const send = () => submitSession({
    lock: sendLock, draft: input, ready: !running && historyLoaded && !saveFailed,
    model: selectedModel, provider, hasCredential,
    onBlocked: (description) => setUiEvents((events) => [...events, {
      kind: 'manager', id: crypto.randomUUID(), createdAt: Date.now(), runId: 'ui',
      category: 'SYSTEM', status: 'failed', description,
    }]),
    onAccepted: () => { setRunning(true); setInput(""); },
    onSettled: () => setRunning(false),
    run: async (question) => {
      const working = conversation ? structuredClone(conversation) : createManagerConversation(title);
      working.conversation.title = title;
      try {
        const adapter = createManagerLlmAdapter({
          providerId: provider,
          model: selectedModel,
          apiKey: selectedKey,
          useSavedKey,
          registry,
        });
        const manager = new ManagerAgent(adapter, toolRegistry, {
          maxIterations: 8,
        });
        const pendingResult = manager.run({
          state: working,
          onEvent: async (event) => {
            setConversation(structuredClone(working));
            try { await writer.append(event); }
            catch {
              setSaveFailed(true);
              setHistoryError("History save failed. Retry to save pending events; tools will not be replayed.");
              throw new Error("History save failed.");
            }
          },
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
      } catch {
        const activeRun = working.runs.at(-1);
        if (activeRun) {
          activeRun.status = "incomplete";
          delete activeRun.endedAt;
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
      }
    },
  });

  return (
    <Stack spacing={2}>
      {!historyLoaded && !historyError && <Typography role="status">Loading history…</Typography>}
      {historyError && <Alert severity="error" action={<Button disabled={retryingSave || running} onClick={() => { if (saveFailed) void retrySave(); else setHistoryAttempt((n) => n + 1); }}>Retry</Button>}>{historyError}</Alert>}
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Stack spacing={1.5}>
          <Stack direction="row" alignItems="center" justifyContent="space-between">
            <Typography variant="h6" component="h3">
              {title}
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
          {!isWeek2Provider(provider) && <Alert severity="warning">{unsupportedWeek2ProviderMessage}</Alert>}
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
                value={isWeek2Provider(provider) ? provider : ""}
                onChange={(event) => setProvider(event.target.value as Week2Provider)}
              >
                {!isWeek2Provider(provider) && <MenuItem value="" disabled>Select a supported provider</MenuItem>}
                {week2ProviderOptions.map((option) => <MenuItem key={option.id} value={option.id}>{option.label}</MenuItem>)}
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
            <ChatRunLog events={timeline} />
            {running && (
              <Typography variant="caption" color="text.secondary">
                Manager is processing…
              </Typography>
            )}
          </Box>
          <ChatComposer
            draft={input}
            onDraftChange={setInput}
            onSend={() => void send()}
            disabled={running || !historyLoaded || saveFailed}
            running={running}
          />
        </Stack>
      </Paper>
    </Stack>
  );
}
