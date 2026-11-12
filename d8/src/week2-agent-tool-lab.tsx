import { eventRunId, mergeHistoryPages, prependedScrollTop, retrySavedHistory } from './history-pagination';
import { sessionLimitOnClose } from "./session-limit";
import { SessionStatsPanel, SessionStatsContent, SessionStatsFrame, sessionChatColumns } from "./session-stats-panel";
import { restoreSessionModelPair, type SessionModelPair } from "./session-model-selection";
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
import { saveSessionRequestTokenLimit, listSessions, createSession as persistSession, renameSession, emptySession, loadHistory, loadHistoryPage, saveHistoryEvent, deleteSession } from "./session-api";
import { useLayoutEffect, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
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
        ? ` · ${event.beforeTokens} → ${event.afterTokens} estimated input tokens` : '') + (event.budget?.requestTokenLimit && event.afterTokens !== undefined && event.afterTokens > event.budget.requestTokenLimit ? ` · Compaction target ${event.budget.requestTokenLimit.toLocaleString('en-US')} not reached` : '') + (event.budget?.limit !== undefined ? ` · Limit ${event.budget.limit.toLocaleString('en-US')}` : '') + (event.budget?.requiredTokens !== undefined ? ` · Required ${event.budget.requiredTokens.toLocaleString('en-US')}` : ''),
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
    setSelectedId((current) => {
      if(current!==id)return current;
      void listSessions().then(items=>setSelectedId(selected=>selected ?? items.slice().sort((a,b)=>(b.updatedAt||b.createdAt)-(a.updatedAt||a.createdAt))[0]?.id??null)).catch(()=>setError('Could not load sessions. Please retry.'));
      return null;
    });
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
      let last:string|null=null;
      try {last=localStorage.getItem('expert-lab:d8:last-session');} catch { /* storage may be unavailable */ }
      const selected=items.find(item=>item.id===last) ?? [...items].sort((a,b)=>(b.updatedAt || b.createdAt)-(a.updatedAt || a.createdAt))[0];
      setSelectedId(selected?.id ?? null);
    }).catch(() => {
      if (active) setError("Could not load sessions. Check the local backend and retry.");
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [loadAttempt]);
  useEffect(()=>{if(!loaded)return;try {if(selectedId)localStorage.setItem('expert-lab:d8:last-session',selectedId);else localStorage.removeItem('expert-lab:d8:last-session');} catch {/* storage may be unavailable */}},[selectedId,loaded]);
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
    <Box sx={{ display: "grid", gridTemplateColumns: { xs: "minmax(0, 1fr)", md: "220px minmax(0, 1fr)" }, gap: 2, alignItems: "start" }}>
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
          <Box sx={{ display: "grid", gridTemplateColumns: sessionChatColumns, gap: 2, alignItems: "start", minWidth: 0 }}>
            <EmptySessionChat showEmptyState={loaded && !loading && sessions.length === 0}
              onCreate={createSession} pending={saving} disabled={createDisabled} />
            <SessionStatsFrame><SessionStatsContent /></SessionStatsFrame>
          </Box>
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
  const [selection, setSelection] = useState<SessionModelPair>({ provider: 'openai', model: openAIModel });
  const { provider, model: selectedModel } = selection;
  const [modelChoices, setModelChoices] = useState<Record<string, string>>({ openai: openAIModel });
  const [requestTokenLimit, setRequestTokenLimit] = useState(initialConversation.conversation.requestTokenLimit ?? 0);
  const [limitDraft, setLimitDraft] = useState(String(initialConversation.conversation.requestTokenLimit ?? 0));
  const [limitSaving, setLimitSaving] = useState(false);
  const [limitError, setLimitError] = useState("");
  const limitLock = useRef(false);
  const saveLimit = async () => {
    const value = sessionLimitOnClose(limitDraft, requestTokenLimit);
    if (limitLock.current) return;
    setLimitDraft(String(value));
    if (value === requestTokenLimit) return;
    limitLock.current = true; setLimitSaving(true); setLimitError("");
    try {
      const saved = await saveSessionRequestTokenLimit(initialConversation.conversation.id, value);
      setRequestTokenLimit(saved.requestTokenLimit ?? 0);
    } catch { setLimitError("Could not save the compaction target. The saved value is unchanged."); }
    finally { limitLock.current = false; setLimitSaving(false); }
  };
  const [settingsAnchor, setSettingsAnchor] = useState<HTMLElement | null>(null);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [uiEvents, setUiEvents] = useState<TimelineEvent[]>([]);
  const [conversation, setConversation] = useState<ManagerConversationState | null>(() => structuredClone(initialConversation));
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const pageEvents = useRef<import('./conversation-history').HistoryEvent[]>([]);
  const fullHistory = useRef(false);
  const [visibleRuns, setVisibleRuns] = useState<Set<string> | null>(null);
  const [pageCursor, setPageCursor] = useState<{before:number|null; snapshot:number}>();
  const [olderLoading, setOlderLoading] = useState(false);
  const [olderError, setOlderError] = useState('');
  const olderLock = useRef(false);
  const pageGeneration = useRef(0);
  const prependAnchor = useRef<{height:number;top:number} | null>(null);
  const [accountingState, setAccountingState] = useState<ManagerConversationState>();
  const [dialogueCounts, setDialogueCounts] = useState<import('./session-api').HistoryPage['dialogueTokens']>();

  const [historyError, setHistoryError] = useState("");
  const [historyAttempt, setHistoryAttempt] = useState(0);
  const [saveFailed, setSaveFailed] = useState(false);
  const [retryingSave, setRetryingSave] = useState(false);
  const sendLock = useRef(false);
  const pendingQuestionId = useRef<string | null>(null);
  const [writer] = useState(() => new HistoryWriter(saveHistoryEvent));
  useEffect(() => {
    if (!active || historyLoaded) return;
    let current = true;
    setHistoryError("");
    loadHistoryPage(initialConversation.conversation.id).then((page) => {
      if (!current) return;
      pageEvents.current = page.events;
      fullHistory.current = page.nextBefore === null;
      setPageCursor({before:page.nextBefore,snapshot:page.snapshot});
      setVisibleRuns(new Set(page.events.map(eventRunId)));
      const restored = restoreHistory(initialConversation, page.events);
      const accounting = restoreHistory(initialConversation, page.accountingEvents ?? page.events);
      setAccountingState(accounting); setDialogueCounts(page.dialogueTokens);
      const pair = restoreSessionModelPair(accounting, registry, openAIModel);
      setSelection(pair);
      setModelChoices(current => ({ ...current, [pair.provider]: pair.model }));
      setConversation(restored);
      setHistoryLoaded(true);
    }).catch(() => { if (current) setHistoryError("Could not load conversation history. Retry before sending."); });
    return () => { current = false; };
  }, [active, historyLoaded, historyAttempt, initialConversation]);
  const retrySave = async () => {
    setRetryingSave(true);
    pageGeneration.current++;
    try {
      const restored = await retrySavedHistory(initialConversation, writer, () => loadHistory(initialConversation.conversation.id));
      pageEvents.current = restored.pageEvents;
      setVisibleRuns(restored.visibleRuns);
      setPageCursor(restored.pageCursor);
      setConversation(restored.conversation);
      setOlderError('');
      fullHistory.current = true; setAccountingState(undefined); setDialogueCounts(undefined);
      setSaveFailed(false); setHistoryError("");
    }
    catch { setHistoryError("History save failed. Retry to save pending events; tools will not be replayed."); }
    finally { setRetryingSave(false); }
  };
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const positioningRef = useRef(false);
  const loadOlder = async () => {
    if (!active || !historyLoaded || running || saveFailed || retryingSave || olderLock.current || pageCursor?.before == null) return;
    const generation = pageGeneration.current;
    olderLock.current = true; setOlderLoading(true); setOlderError('');
    try {
      const page = await loadHistoryPage(initialConversation.conversation.id, pageCursor.before, pageCursor.snapshot);
      if (generation !== pageGeneration.current) return;
      const container = scrollRef.current;
      if(container)prependAnchor.current = {height:container.scrollHeight,top:container.scrollTop};
      stickToBottomRef.current = false;
      pageEvents.current = mergeHistoryPages(pageEvents.current,page.events);
      setVisibleRuns(current=>new Set([...(current??[]),...page.events.map(eventRunId)]));
      if(!fullHistory.current)setConversation(restoreHistory(initialConversation,pageEvents.current));
      setPageCursor({before:page.nextBefore,snapshot:page.snapshot});
    } catch {if (generation === pageGeneration.current) setOlderError('Could not load older messages. Please retry.');}
    finally {olderLock.current = false; setOlderLoading(false);}
  };


  const [, refreshModelMetadata] = useState(0);
  useEffect(() => {
    if (!active || provider !== 'opencode-console' || registry.get(provider)?.limits?.(selectedModel)?.contextWindow) return;
    let current = true;
    void registry.get(provider)?.discover?.().then(() => { if (current) refreshModelMetadata(n => n + 1); }).catch(() => { /* Unknown catalog limits remain unavailable. */ });
    return () => { current = false; };
  }, [active, provider, selectedModel, registry]);
  const providerModels = registry.modelOptionsFor(provider);
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
      [...buildWeek2Timeline(conversation, toolRegistry).filter(event=>!visibleRuns || visibleRuns.has(event.runId)), ...uiEvents].sort(
        // Stable sorting retains causal conversation order and UI insertion order on ties.
        (a, b) => a.createdAt - b.createdAt,
      ),
    [conversation, uiEvents, toolRegistry, visibleRuns],
  );

  useLayoutEffect(() => {
    if (!active || !historyLoaded) return;
    positioningRef.current = true;
    stickToBottomRef.current = true;
    const container = scrollRef.current;
    if(container)container.scrollTop = container.scrollHeight;
    // Ignore programmatic scroll events while the newest page settles. A second
    // frame catches layout changes from rendering the restored conversation.
    let second = 0;
    const first = requestAnimationFrame(() => {
      if (container) container.scrollTop = container.scrollHeight;
      second = requestAnimationFrame(() => {positioningRef.current = false;});
    });
    return () => {cancelAnimationFrame(first);cancelAnimationFrame(second);positioningRef.current = false;};
  }, [active,historyLoaded]);
  useLayoutEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    if(!active){prependAnchor.current=null;return;}
    if(prependAnchor.current){
      container.scrollTop = prependedScrollTop(prependAnchor.current,container.scrollHeight);
      prependAnchor.current = null;
    } else if (active && stickToBottomRef.current)container.scrollTop = container.scrollHeight;
  }, [timeline, running, active]);

  const send = () => submitSession({
    lock: sendLock, draft: input, ready: !running && historyLoaded && !saveFailed && !limitSaving,
    model: selectedModel, provider, hasCredential,
    onBlocked: (description) => setUiEvents((events) => [...events, {
      kind: 'manager', id: crypto.randomUUID(), createdAt: Date.now(), runId: 'ui',
      category: 'SYSTEM', status: 'failed', description,
    }]),
    onAccepted: () => {
      setRunning(true); setInput(""); stickToBottomRef.current=true;
      const id=crypto.randomUUID(); pendingQuestionId.current=id;
      setUiEvents(events=>[...events,{kind:'message',id,runId:'ui',role:'user',text:input.trim(),createdAt:Date.now()}]);
    },
    onSettled: () => setRunning(false),
    run: async (question) => {
      let working = conversation ? structuredClone(conversation) : createManagerConversation(title);
      working.conversation.title = title;
      let runStarted = false;
      try {
        if(!fullHistory.current){
          working = restoreHistory(initialConversation, await loadHistory(initialConversation.conversation.id));
          fullHistory.current = true;
        }
        setAccountingState(undefined); setDialogueCounts(undefined);
        const adapter = createManagerLlmAdapter({
          providerId: provider,
          model: selectedModel,
          apiKey: selectedKey,
          useSavedKey,
          registry,
          requestTokenLimit,
        });
        const manager = new ManagerAgent(adapter, toolRegistry, {
          maxIterations: 8,
        });
        runStarted = true;
        const pendingResult = manager.run({
          state: working,
          onEvent: async (event) => {
            if(event.type==='message' && event.payload.role==='user' && pendingQuestionId.current){
              const id=pendingQuestionId.current; pendingQuestionId.current=null;
              setUiEvents(events=>events.filter(event=>event.id!==id));
            }
            setVisibleRuns(current=>new Set([...(current??[]),eventRunId(event)]));
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
        if(!runStarted){
          setInput(current=>current || question);
          const id=pendingQuestionId.current; pendingQuestionId.current=null;
          setUiEvents(events=>events.filter(event=>event.id!==id));
        }
        const activeRun = runStarted ? working.runs.at(-1) : undefined;
        if (activeRun?.status === "running") {
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
    <Box sx={{ display: "grid", gridTemplateColumns: sessionChatColumns, gap: 2, alignItems: "start", minWidth: 0 }}>
    <Stack spacing={2} sx={{ minWidth: 0 }}>
      {!historyLoaded && !historyError && <Typography role="status">Loading history…</Typography>}
      {historyError && <Alert severity="error" action={<Button disabled={retryingSave || running} onClick={() => { if (saveFailed) void retrySave(); else setHistoryAttempt((n) => n + 1); }}>Retry</Button>}>{historyError}</Alert>}
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Stack spacing={1.5}>
          <Stack direction="row" alignItems="flex-start" justifyContent="space-between" gap={1} sx={{ minWidth: 0 }}>
            <Typography variant="h6" component="h3" sx={{ minWidth: 0, flex: 1, overflowWrap: "anywhere" }}>
              {title}
            </Typography>
            <Stack direction="row" spacing={0.5} alignItems="center" sx={{ flexShrink: 0 }}>
            <IconButton
              size="small"
              aria-label="Open chat settings"
              onClick={(event) => { setLimitDraft(String(requestTokenLimit)); setSettingsAnchor(event.currentTarget); }}
            >
              <SettingsOutlined fontSize="small" />
            </IconButton>
            </Stack>
          </Stack>
          {limitError && <Alert severity="error">{limitError}</Alert>}
          {!timeline.length && (
            <Typography color="text.secondary">
              Start a conversation with {providerLabel} · {selectedModel || "Select a model"}
            </Typography>
          )}
          {historyLoaded && <Typography variant="caption" color="text.secondary">{providerLabel} · {selectedModel || 'Select a model'}</Typography>}
          {selection.notice && <Alert severity="warning">{selection.notice}</Alert>}
          {!isWeek2Provider(provider) && <Alert severity="warning">{unsupportedWeek2ProviderMessage}</Alert>}
          {!hasCredential && (
            <Typography variant="caption" color="text.secondary">
              Credentials for {providerLabel} are managed in Providers.
            </Typography>
          )}
          <Popover
            open={!!settingsAnchor}
            anchorEl={settingsAnchor}
            onClose={() => { setSettingsAnchor(null); void saveLimit(); }}
            anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
            transformOrigin={{ vertical: "top", horizontal: "right" }}
          >
            <Stack spacing={1.25} sx={{ p: 1.5, minWidth: 260 }}>
              <TextField
                select
                label="Provider"
                size="small"
                value={isWeek2Provider(provider) ? provider : ""}
                onChange={(event) => {
                  const next = event.target.value as SessionModelPair['provider'];
                  const options = registry.modelOptionsFor(next);
                  setSelection({ provider: next, model: options.includes(modelChoices[next]) ? modelChoices[next] : options[0] ?? '' });
                }}
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
                  setSelection({ provider, model: value });
                  setModelChoices(current => ({ ...current, [provider]: value }));
                }}
              >
                {!providerModels.length && <MenuItem value="">No models available</MenuItem>}
                {providerModels.map((entry) => (
                  <MenuItem key={entry} value={entry}>
                    {entry}
                  </MenuItem>
                ))}
              </TextField>
              <TextField label="Compaction target" type="number" size="small" value={limitDraft}
                disabled={limitSaving || running} onChange={e => setLimitDraft(e.target.value)}
                helperText="Target estimated input tokens per request. Set to 0 to use the model’s available input budget."
                slotProps={{ htmlInput: { min: 0, step: 1 } }} />
              {limitError && <Alert severity="error">{limitError}</Alert>}

            </Stack>
          </Popover>
          <Box
            ref={scrollRef}
            sx={{
              minHeight: 380,
              maxHeight: 500,
              overflowY: "auto",
              overflowAnchor: "none",
              pr: 0.5,
              display: "flex",
              flexDirection: "column",
              gap: 1,
            }}
            onScroll={(event) => {
              const element = event.currentTarget;
              if (positioningRef.current) return;
              const nearBottom =
                element.scrollHeight - (element.scrollTop + element.clientHeight) < 80;
              stickToBottomRef.current = nearBottom;
              if(element.scrollTop < 80)void loadOlder();
            }}
            aria-label="Week 2 conversation history"
          >
            {pageCursor?.before != null && <Button size="small" disabled={olderLoading || running || saveFailed || retryingSave} onClick={()=>void loadOlder()}>{olderLoading?'Loading older messages…':'Load older messages'}</Button>}
            {olderError && <Alert severity="error">{olderError}</Alert>}
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
    <SessionStatsPanel state={conversation ?? initialConversation} draft={input}
      request={{ providerId: provider, model: selectedModel, registry, requestTokenLimit }} tools={toolRegistry}
      active={active} loaded={historyLoaded} running={running} accountingState={accountingState} dialogueCounts={dialogueCounts} />
    </Box>
  );
}
