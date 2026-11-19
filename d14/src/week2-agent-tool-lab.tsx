import { usePolicyStatus, ChatInvariants, invariantRequest, InvariantRequestError } from './chat-invariants';
import { readSessionSelection, resolveWorkerSelection, writeSessionSelection, type SessionSelection } from './session-selection';
import { eventRunId, mergeHistoryPages, prependedScrollTop, retrySavedHistory } from './history-pagination';
import { sessionLimitOnClose } from "./session-limit";
import { SessionStatsPanel, SessionStatsContent, SessionStatsFrame, sessionChatColumns } from "./session-stats-panel";
import { restoreSessionModelPair, type SessionModelPair } from "./session-model-selection";
import { ChatComposer } from "./chat-composer";
import { KeyValueDetails } from "./key-value-details";
import { ChatRunLog } from "./chat-run-log";
import { contextPhaseLabel } from "./context-compaction";
import { createAndSelectSession } from "./session-creation";
import { EmptySessionChat, SessionCreateButton } from "./session-empty-state";
import { NewSessionDialog } from "./new-session-dialog";
import { WorkerSessionPreview, workerStateLabels, type WorkerTemplate } from './worker-ui';
import { createWorkerSession, deleteWorkerSession, renameWorkerSession, listWorkerSessions, type WorkerSession } from './worker-api';
import { loadProfiles, sampleUsers, type MockUser, type ContextProfile } from "./users-page";
import { profileName } from './profile-session-utils';
import { SessionListRequests } from './session-list-requests';
import type { ModelRequestMeter } from "./token-meter";
import { isWeek2Provider, unsupportedWeek2ProviderMessage, week2ProviderOptions } from "./week2-provider";
import { SessionDeletion } from "./session-deletion";
import { SessionRow } from "./session-row";
import { submitSession } from "./session-send";
import { finishProfileTurn, prepareProfileTurn } from './instruction-turn-flow';
import { HabitsConfirmationCard, createHabitsDecision, decisionNotice, proposalIsActionable, scheduleProposalExpiry, type HabitsProposal } from './habits-confirmation-card';
import { credentials } from "./saved-credentials";
import { HistoryWriter, restoreHistory } from "./conversation-history";
import * as week2Api from "./session-api";
import * as week3Api from "./week3-session-api";
import { DEFAULT_SHORT_TERM_TOKEN_BUDGET, MemoryProcessor, SessionMemory, type MemorySnapshot } from './session-memory';
import { SessionMemoryCard } from './session-memory-card';
import { estimateMemoryTokenStats, type MemoryTokenCache, type MemoryTokenStats } from './memory-token-stats';
import type {MemoryEntry} from './key-value-memory';
import { useLayoutEffect, useEffect, useMemo, useRef, useState, useSyncExternalStore, type Dispatch, type SetStateAction } from "react";
import {
  Alert,
  Box,
  Button,
  GlobalStyles,
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
  Radio,
  RadioGroup,
  FormControlLabel,
  FormControl,
  FormLabel,
  Stack,
  Chip,
  TextField,
  Typography,
} from "@mui/material";
import SettingsOutlined from "@mui/icons-material/SettingsOutlined";
import type { ProviderRegistry } from "./provider-registry";
import { ManagerAgent, createManagerConversation } from "./manager-agent";
import { createManagerLlmAdapter } from "./manager-llm-adapter";
import { createDevManagerMock } from './dev-manager-mock';
import type { ToolRegistry } from "./tool-runtime";
import { loadFunctions } from './custom-functions-api';
import { executableFunction } from './custom-function-runtime';
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
      blocked?: true;
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
  const messages: TimelineEvent[] = [...state.messages, ...(state.blockedQuestions ?? [])].map((message) => ({
    kind: "message",
    blocked: message.blocked,
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
  week3?: boolean;
  workers?: readonly WorkerTemplate[];
  mockUsers?: readonly MockUser[];
  profileRevision?: number;
  sessionsRevision?: number;
  onSessionsChanged?: () => void;
  onProfilesChanged?: () => void;
  sessionListRequests?: SessionListRequests;
  toolRegistry: ToolRegistry;
  registry: ProviderRegistry;
  openAIModel: string;
  onOpenAIModelChange: (model: string) => void;
  openAIKey: string;
  openCodeKeys: OpenCodeKeys;
};

export function SessionListErrorNotice({message,onRetry}:{message:string;onRetry:()=>void}) {
  return <Alert severity="error" action={<Button onClick={onRetry}>Retry</Button>}>{message}</Alert>;
}

export function Week2AgentToolLab(props: LabProps) {
  const { listSessions, createSession: persistSession, renameSession, emptySession, deleteSession } = props.week3 ? week3Api : week2Api;
  const [sessions, setSessions] = useState<ManagerConversationState[]>([]);
  const [sessionOwners, setSessionOwners] = useState<Record<string, string>>({});
  const [sessionProfiles, setSessionProfiles] = useState<Record<string, string | undefined>>({});
  const [profiles, setProfiles] = useState<ContextProfile[]>([]);
  const [profilesError, setProfilesError] = useState(false);
  const [profilesAttempt, setProfilesAttempt] = useState(0);
  const [localListRequests] = useState(() => new SessionListRequests());
  const listRequests = props.sessionListRequests ?? localListRequests;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [workerSessions, setWorkerSessions] = useState<WorkerSession[]>([]);
  const [workerListError,setWorkerListError] = useState('');
  const [workerListLoading,setWorkerListLoading] = useState(true);
  const [workerListAttempt,setWorkerListAttempt] = useState(0);
  const [selectedWorkerId, setSelectedWorkerId] = useState<string | null>(null);
  const [workerListResolved, setWorkerListResolved] = useState(false);
  const selectedIntent = useRef<SessionSelection | null | undefined>(undefined);
  if (selectedIntent.current === undefined) {
    try { selectedIntent.current = props.week3 ? readSessionSelection(localStorage) : null; }
    catch { selectedIntent.current = null; }
  }
  const recordSelection = (selection: SessionSelection | null) => {
    selectedIntent.current = selection;
    if (props.week3) { try { writeSessionSelection(localStorage, selection); } catch { /* storage unavailable */ } }
  };
  const workerListGeneration=useRef(0);
  useEffect(()=>{let active=true;const generation=++workerListGeneration.current;setWorkerListLoading(true);setWorkerListError('');listWorkerSessions().then(items=>{if(active && generation===workerListGeneration.current){setWorkerSessions(items);
    const resolution = props.week3 ? resolveWorkerSelection(selectedIntent.current, items.map(item=>item.id)) : {kind:'unchanged' as const};
    if (resolution.kind === 'select') setSelectedWorkerId(resolution.id);
    else if (resolution.kind === 'missing') { recordSelection(null); setSelectedWorkerId(null); }
    else setSelectedWorkerId(current=>current && items.some(item=>item.id===current)?current:null);
    setWorkerListResolved(true);}}).catch(()=>{if(active && generation===workerListGeneration.current)setWorkerListError('Could not load Worker sessions.');}).finally(()=>{if(active && generation===workerListGeneration.current)setWorkerListLoading(false);});return()=>{active=false;};},[props.week3,props.profileRevision,props.sessionsRevision,workerListAttempt]);
  const [proposalSwitchNotice,setProposalSwitchNotice]=useState('');
  const [context, setContext] = useState<{ id: string; x: number; y: number; worker?: boolean } | null>(null);
  const [renameTarget, setRenameTarget] = useState<SessionSelection | null>(null);
  const [title, setTitle] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [listError, setListError] = useState('');
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const saveLock = useRef(false);
  const [chatDeletion] = useState(() => new SessionDeletion(async id=>{
    listRequests.invalidate();
    try { await deleteSession(id); }
    finally { listRequests.invalidate(); setLoadAttempt(n=>n+1); }
  }, (id) => {
    setSessions((current) => current.filter((session) => session.conversation.id !== id));
    setSessionOwners(current=>{const next={...current};delete next[id];return next;});
    setSessionProfiles(current=>{const next={...current};delete next[id];return next;});
    if(props.week3) props.onSessionsChanged?.();
    setSelectedId(current=>current===id ? null : current);
  }));
  const [workerDeletion] = useState(() => new SessionDeletion(deleteWorkerSession, id => {
    workerListGeneration.current++;
    setWorkerListLoading(false);
    setWorkerSessions(current => current.filter(item => item.id !== id));
    setSelectedWorkerId(current => current === id ? null : current);
    if (selectedIntent.current?.type === 'worker' && selectedIntent.current.id === id) recordSelection(null);
    props.onSessionsChanged?.();
  }));
  const chatDeleteState = useSyncExternalStore(chatDeletion.subscribe, chatDeletion.getSnapshot, chatDeletion.getSnapshot);
  const workerDeleteState = useSyncExternalStore(workerDeletion.subscribe, workerDeletion.getSnapshot, workerDeletion.getSnapshot);
  const deletion = workerDeleteState.target ? workerDeletion : chatDeletion;
  const deleteState = workerDeleteState.target ? workerDeleteState : chatDeleteState;
  useEffect(() => {
    let active = true;
    if(!loaded)setLoading(true);
    setListError('');
    void listRequests.load(listSessions, (items) => {
      if (!active) return;
      setSessions(current=>items.map(item=>current.find(session=>session.conversation.id===item.id) ?? emptySession(item)));
      if(props.week3) setSessionProfiles(Object.fromEntries(items.map(item=>[item.id,(item as week3Api.SessionMetadata).profileId])));
      setLoaded(true);
      let last:string|null=null;
      try {last=localStorage.getItem((props.week3 ? 'expert-lab:d11:week3:last-session' : 'expert-lab:d8:last-session'));} catch { /* storage may be unavailable */ }
      const preferred = props.week3 && selectedIntent.current?.type === 'chat' ? selectedIntent.current.id : last;
      const selected=items.find(item=>item.id===preferred) ?? [...items].sort((a,b)=>(b.updatedAt || b.createdAt)-(a.updatedAt || a.createdAt))[0];
      setSelectedId(current=>items.some(item=>item.id===current) ? current : selected?.id ?? null);
      setLoading(false);
    }, () => {
      if (active) { setListError("Could not load sessions. Check the local backend and retry."); setLoading(false); }
    });
    return () => { active = false; listRequests.invalidate(); };
  }, [loadAttempt,props.week3 ? props.profileRevision : undefined]);
  useEffect(()=>{
    let active=true;setProfiles([]);setProfilesError(false);
    loadProfiles().then(items=>{if(active)setProfiles(items);}).catch(()=>{if(active)setProfilesError(true);});
    return ()=>{active=false;};
  },[props.week3,props.profileRevision,profilesAttempt]);
  useEffect(()=>{
    if(!loaded)return;
    try {if(selectedId)localStorage.setItem((props.week3 ? 'expert-lab:d11:week3:last-session' : 'expert-lab:d8:last-session'),selectedId);else localStorage.removeItem((props.week3 ? 'expert-lab:d11:week3:last-session' : 'expert-lab:d8:last-session'));} catch {/* storage may be unavailable */}
    if (props.week3 && workerListResolved) recordSelection(selectedWorkerId ? {type:'worker',id:selectedWorkerId} : selectedId ? {type:'chat',id:selectedId} : null);
  },[selectedId,selectedWorkerId,loaded,workerListResolved,props.week3]);
  const createDisabled = loading || !loaded || saving || deleteState.pending;
  const openNewSession = () => { setError(""); setNewSessionOpen(true); };
  const createSession = (name: string, userId: string, worker?: WorkerTemplate) => {
    if (worker) {
      if(saveLock.current)return;
      saveLock.current=true;workerListGeneration.current++;setWorkerListLoading(false);setSaving(true);setError('');
      void createWorkerSession(name,userId,worker.id).then(session=>{setWorkerListError('');setWorkerSessions(current=>[...current,session]);recordSelection({type:'worker',id:session.id});setSelectedWorkerId(session.id);setNewSessionOpen(false);props.onSessionsChanged?.();}).catch(()=>setError('Could not create Worker session. Please retry.')).finally(()=>{saveLock.current=false;setSaving(false);});
      return;
    }
    setSelectedWorkerId(null);
    void createAndSelectSession({
    lock: saveLock, ready: loaded && !loading && !deleteState.pending, create: async () => {
      const created = props.week3 ? await week3Api.createSession(userId) : await persistSession();
      try { return await renameSession(created.id, name); }
      catch { setError('Session was created, but its name could not be saved. You can rename it later.'); return created; }
    },
    onPending: value=>{listRequests.invalidate();setSaving(value);if(!value)setLoadAttempt(n=>n+1);}, onError: setError,
    onCreated: (saved) => {
      const session = emptySession(saved);
      setSessions((current) => [...current, session]);
      if(props.week3){setSessionProfiles(current=>({...current,[session.conversation.id]:(saved as week3Api.SessionMetadata).profileId}));props.onSessionsChanged?.();}
      else setSessionOwners(current=>({...current,[session.conversation.id]:(props.mockUsers ?? sampleUsers).find(user=>user.id===userId)?.name ?? 'General'}));
      recordSelection({type:'chat',id:session.conversation.id});
      setSelectedId(session.conversation.id);
      setNewSessionOpen(false);
    },
  }); };
  const rename = async () => {
    if (!title.trim() || !renameTarget || saveLock.current) return;
    saveLock.current = true;
    setSaving(true);
    setError("");
    try {
      if (renameTarget.type === 'worker') {
        const saved = await renameWorkerSession(renameTarget.id, title.trim());
        workerListGeneration.current++;
        setWorkerListLoading(false);
        setWorkerSessions(current => current.map(item => item.id === saved.id
          ? { ...item, name: saved.name, updatedAt: Math.max(item.updatedAt ?? 0, saved.updatedAt ?? 0) } : item));
        setRenameTarget(null);
        props.onSessionsChanged?.();
        return;
      }
      const saved = await renameSession(renameTarget.id, title.trim());
      setSessions((current) => current.map((session) =>
        session.conversation.id === saved.id
          ? { ...session, conversation: { ...session.conversation, title: saved.title } }
          : session,
      ));
      setRenameTarget(null);
    } catch {
      setError(renameTarget.type === "worker" ? "Could not rename the Worker session. Check the name and retry." : "Could not rename session. The saved title is unchanged. Please retry.");
    } finally { saveLock.current = false; setSaving(false); }
  };
  const sessionSidebar = (
      <Paper component="aside" variant="outlined" aria-label="Sessions" sx={{ p: 1.25, minWidth: 0, bgcolor:"white" }}>
        <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ px: 1 }}>
          <Typography variant="h6" component="h2">Sessions</Typography>
          <SessionCreateButton compact onCreate={openNewSession} pending={saving} disabled={createDisabled} />
        </Stack>
        {loading && <Typography variant="caption" role="status">Loading sessions…</Typography>}
        {workerListLoading && <Typography variant="caption" role="status">Loading Worker sessions…</Typography>}
        {listError && <SessionListErrorNotice message={listError} onRetry={() => setLoadAttempt(n=>n+1)} />}
        {workerListError && <SessionListErrorNotice message={workerListError} onRetry={() => setWorkerListAttempt(n=>n+1)} />}
        {error && <Alert severity="error">{error}</Alert>}
        <List disablePadding aria-label="Session list">
          {sessions.map((session) => (
            <SessionRow key={session.conversation.id} id={session.conversation.id} title={session.conversation.title ?? 'New session'} owner={props.week3 ? profileName(sessionProfiles[session.conversation.id],profiles) : sessionOwners[session.conversation.id] ?? 'General'}
              selected={!selectedWorkerId && selectedId === session.conversation.id} menuOpen={!context?.worker && context?.id === session.conversation.id}
              disabled={saving || deleteState.pending} onSelect={() => { recordSelection({type:'chat',id:session.conversation.id}); setSelectedWorkerId(null); setSelectedId(session.conversation.id); }}
              onActions={(position) => setContext({ id: session.conversation.id, ...position })} />
          ))}
          {workerSessions.map(session=><SessionRow key={session.id} id={`worker-${session.id}`} title={session.name} owner={`Worker · ${profileName(session.profileId,profiles)}`}
            status={workerStateLabels[session.state]} selected={selectedWorkerId===session.id} menuOpen={context?.worker===true && context.id===session.id} disabled={saving||deleteState.pending}
            onSelect={()=>{recordSelection({type:'worker',id:session.id});setSelectedWorkerId(session.id);}}
            onActions={position=>setContext({id:session.id,worker:true,...position})}/>)}
        </List>
      </Paper>
  );
  return (
    <Box sx={{ display: "grid", gridTemplateColumns: { xs: "minmax(0, 1fr)", md: selectedWorkerId ? "minmax(0,1fr)" : "220px minmax(0, 1fr)" }, gap: 1.5, alignItems: selectedWorkerId ? "stretch" : "start" }}>
      {!selectedWorkerId && sessionSidebar}
      <Box sx={{ minWidth: 0 }}>
        {proposalSwitchNotice && <Alert severity="warning" onClose={()=>setProposalSwitchNotice('')}>{proposalSwitchNotice}</Alert>}
        {!selectedWorkerId && !selectedId && (
          <Box sx={{ display: "grid", gridTemplateColumns: sessionChatColumns, gap: 2, alignItems: "start", minWidth: 0 }}>
            <EmptySessionChat showEmptyState={loaded && !loading && sessions.length === 0}
              onCreate={openNewSession} pending={saving} disabled={createDisabled} />
            <SessionStatsFrame><SessionStatsContent /></SessionStatsFrame>
          </Box>
        )}
        {/* Keep each keyed chat mounted: its draft, timeline and pending run belong to that session. */}
        {sessions.map((session) => (
          <Box key={session.conversation.id} hidden={!!selectedWorkerId || selectedId !== session.conversation.id}>
            <SessionChat {...props} onProposalDismissed={setProposalSwitchNotice} active={!selectedWorkerId && selectedId === session.conversation.id} initialConversation={session} title={session.conversation.title ?? "New session"} />
          </Box>
        ))}
        {workerSessions.map(session => <Box key={session.id} hidden={selectedWorkerId!==session.id}><WorkerSessionPreview session={session} sidebar={selectedWorkerId===session.id ? sessionSidebar : undefined} active={selectedWorkerId===session.id} onAttempt={attempt=>{
          setWorkerSessions(current=>[...current.filter(item=>item.id!==attempt.id),attempt]);
          if(selectedIntent.current?.type==='worker' && selectedIntent.current.id===session.id){recordSelection({type:'worker',id:attempt.id});setSelectedWorkerId(attempt.id);}
          props.onSessionsChanged?.();
        }} onRefresh={updated=>setWorkerSessions(current=>current.map(item=>item.id===updated.id && updated.revision>=item.revision?{...updated,name:(updated.updatedAt ?? 0)<(item.updatedAt ?? 0)?item.name:updated.name}:item))}/></Box>)}
      </Box>
      <NewSessionDialog open={newSessionOpen} workers={props.workers} users={props.week3 ? profiles : props.mockUsers ?? sampleUsers} workerUsers={profiles} pending={saving} error={error} persisted={props.week3} profilesError={profilesError} onRetryProfiles={()=>setProfilesAttempt(current=>current+1)} onClose={()=>setNewSessionOpen(false)} onCreate={createSession} />
      <Menu id="session-actions-menu" slotProps={{ list: { "aria-labelledby": context ? `session-actions-${context.worker?"worker-":""}${context.id}` : undefined } }} open={!!context} onClose={() => setContext(null)} anchorReference="anchorPosition"
        anchorPosition={context ? { top: context.y, left: context.x } : undefined}>
        <MenuItem disabled={saving || deleteState.pending} onClick={() => {
          if (!context) return;
          setError("");
          setRenameTarget({type: context.worker ? 'worker' : 'chat', id: context.id});
          setTitle(context.worker ? workerSessions.find(item => item.id === context.id)?.name ?? "" : sessions.find((session) => session.conversation.id === context.id)?.conversation.title ?? "");
          setContext(null);
        }}>Rename</MenuItem>
        <MenuItem disabled={saving || deleteState.pending} onClick={() => {
          const worker = context?.worker && workerSessions.find(item => item.id === context.id);
          if (worker) workerDeletion.request({id: worker.id, title: worker.name});
          const session = !context?.worker && sessions.find((entry) => entry.conversation.id === context?.id);
          if (session) chatDeletion.request({ id: session.conversation.id, title: session.conversation.title ?? 'New session' });
          setContext(null);
        }}>Delete</MenuItem>
      </Menu>
      <Dialog open={!!deleteState.target} onClose={() => deletion.cancel()} aria-labelledby="delete-session-title" aria-describedby="delete-session-description" fullWidth maxWidth="xs">
        <DialogTitle id="delete-session-title">Delete session “{deleteState.target?.title}”?</DialogTitle>
        <DialogContent>
          <Typography id="delete-session-description">{workerDeleteState.target ? "This Worker session and its entire history, including saved answers and evaluations, will be permanently deleted." : "This session and its entire history, including messages, tool calls, results, and Timeline entries, will be permanently deleted."}</Typography>
          {deleteState.error && <Alert severity="error" sx={{ mt: 1 }}>{deleteState.error}</Alert>}
        </DialogContent>
        <DialogActions><Button autoFocus disabled={deleteState.pending} onClick={() => deletion.cancel()}>Cancel</Button><Button color="error" disabled={deleteState.pending} onClick={() => void deletion.confirm()}>{deleteState.pending ? 'Deleting…' : 'Delete'}</Button></DialogActions>
      </Dialog>
      <Dialog open={!!renameTarget} onClose={() => { if (!saving) setRenameTarget(null); }} fullWidth maxWidth="xs">
        <Box component="form" onSubmit={(event) => { event.preventDefault(); void rename(); }}>
          <DialogTitle>Rename session</DialogTitle>
          <DialogContent>{error && <Alert severity="error">{error}</Alert>}<TextField autoFocus fullWidth margin="dense" label="Session title" inputProps={{ maxLength: 200 }} disabled={saving} value={title} onChange={(event) => setTitle(event.target.value)} /></DialogContent>
          <DialogActions><Button disabled={saving} onClick={() => setRenameTarget(null)}>Cancel</Button><Button type="submit" disabled={saving || !title.trim()}>Save</Button></DialogActions>
        </Box>
      </Dialog>
    </Box>
  );
}

type SessionChatProps = LabProps & {initialConversation: ManagerConversationState; active?: boolean; title: string;onProposalDismissed?:(message:string)=>void};

export function SessionChat(props: SessionChatProps) {
  const {openSlidingSession, openStickySession, openMemorySession, emptySession, selectSlidingSession, selectStickySession, selectMemorySession, saveFullContext} = props.week3 ? week3Api : week2Api;
  const [sliding, setSliding] = useState(!!props.initialConversation.conversation.slidingSelected);
  const [sticky, setSticky] = useState(!!props.initialConversation.conversation.stickySelected || (!!props.initialConversation.conversation.contextStrategy && !props.initialConversation.conversation.fullContext && !props.initialConversation.conversation.slidingSelected && !props.initialConversation.conversation.memorySelected));
  const [memory, setMemory] = useState(!!props.initialConversation.conversation.memorySelected);
  const [slidingState, setSlidingState] = useState<ManagerConversationState>();
  const [stickyState, setStickyState] = useState<ManagerConversationState>();
  const [memoryState, setMemoryState] = useState<ManagerConversationState>();
  const [selection,setSelection] = useState<SessionModelPair>({provider:'openai',model:props.openAIModel});
  const [modelChoices,setModelChoices] = useState<Record<string,string>>({openai:props.openAIModel});
  const restoredSelection = useRef(false);
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState('');
  const [root, setRoot] = useState(props.initialConversation);
  useEffect(() => {
    if (!sliding || slidingState) return;
    let current = true;
    void openSlidingSession(root.conversation.id).then(item => {if(current)setSlidingState(emptySession(item));}).catch(()=>{if(current)setSwitchError('Could not load Sliding Window history.');});
    return () => {current=false;};
  },[sliding,slidingState,root.conversation.id]);
  useEffect(() => {
    if (!sticky || stickyState) return;
    let current=true;
    void openStickySession(root.conversation.id).then(item=>{if(current)setStickyState(emptySession(item));}).catch(()=>{if(current)setSwitchError('Could not load Sticky Facts history.');});
    return ()=>{current=false;};
  },[sticky,stickyState,root.conversation.id]);
  useEffect(()=>{if(!memory || memoryState)return;let current=true;void openMemorySession(root.conversation.id).then(item=>{if(current)setMemoryState(emptySession(item));}).catch(()=>{if(current)setSwitchError('Could not load Key-Value Memory history.');});return()=>{current=false;};},[memory,memoryState,root.conversation.id]);
  const switchTab = async (next:'full'|'legacy'|'sliding'|'sticky'|'memory') => {
    if (switching) return;
    setSwitching(true); setSwitchError('');
    try {
      if (next === 'sliding') {
        const child = emptySession(await openSlidingSession(root.conversation.id));
        await selectSlidingSession(root.conversation.id,true);
        setSlidingState(child); setSticky(false); setMemory(false); setSliding(true);
      } else if (next === 'sticky') {
        const child = emptySession(await openStickySession(root.conversation.id));
        await selectStickySession(root.conversation.id,true);
        setStickyState(child); setSliding(false); setMemory(false); setSticky(true);
      } else if(next==='memory') {
        const child=emptySession(await openMemorySession(root.conversation.id));
        await selectMemorySession(root.conversation.id,true);
        setMemoryState(child);setSliding(false);setSticky(false);setMemory(true);
      } else {
        await saveFullContext(root.conversation.id,next === 'full');
        await selectSlidingSession(root.conversation.id,false);
        await selectStickySession(root.conversation.id,false);
        setRoot(current=>({...current,conversation:{...current.conversation,fullContext:next==='full'}}));
        await selectMemorySession(root.conversation.id,false);
        setSliding(false); setSticky(false); setMemory(false);
      }
    } catch {setSwitchError('Could not switch context mode.');}
    finally {setSwitching(false);}
  };
  const current = sliding ? slidingState : sticky ? stickyState : memory ? memoryState : root;
  if (!current) return <Alert severity={switchError ? 'error' : 'info'}>{switchError || 'Loading context history…'}</Alert>;
  return <Box sx={{minHeight:650}}><Box key={`${current.conversation.id}-${sliding ? 'sliding' : sticky ? 'sticky' : memory ? 'memory' : 'full'}`} sx={{animation:'contextFade 180ms ease-out','@keyframes contextFade':{from:{opacity:.72},to:{opacity:1}},'@media (prefers-reduced-motion: reduce)':{animation:'none'}}}><SessionChatView {...props} policyRoot={root.conversation.id} initialConversation={current} sliding={sliding} sticky={sticky} memory={memory} selection={selection} setSelection={setSelection} modelChoices={modelChoices} setModelChoices={setModelChoices} restoredSelection={restoredSelection} switchTab={switchTab} switching={switching} /></Box>{switchError && <Alert severity="error">{switchError}</Alert>}</Box>;
}

function SessionChatView({
  policyRoot,
  week3,
  onProfilesChanged,
  onProposalDismissed,
  toolRegistry,
  registry,
  openAIModel,
  onOpenAIModelChange,
  openAIKey,
  openCodeKeys,
  initialConversation,
  active = true,
  title,
  sliding,
  sticky, memory, selection, setSelection, modelChoices, setModelChoices, restoredSelection,
  switchTab,
  switching,
}: {
  policyRoot:string;
  week3?: boolean;
  onProfilesChanged?:()=>void;
  onProposalDismissed?:(message:string)=>void;
  toolRegistry: ToolRegistry;
  registry: ProviderRegistry;
  openAIModel: string;
  onOpenAIModelChange: (model: string) => void;
  openAIKey: string;
  openCodeKeys: OpenCodeKeys;
  initialConversation: ManagerConversationState;
  active?: boolean;
  title: string;
  sliding: boolean;
  sticky: boolean;
  memory: boolean;
  selection: SessionModelPair;
  setSelection: Dispatch<SetStateAction<SessionModelPair>>;
  modelChoices: Record<string,string>;
  setModelChoices: Dispatch<SetStateAction<Record<string,string>>>;
  restoredSelection: {current:boolean};
  switchTab: (next:'full'|'legacy'|'sliding'|'sticky'|'memory') => Promise<void>;
  switching: boolean;
}) {
  const {saveSessionContextSetting, loadHistory, saveSessionRequestTokenLimit, loadMemory, saveMemory, loadHistoryPage, saveHistoryEvent, loadSessionFacts, saveSessionFacts} = week3 ? week3Api : week2Api;
  const { provider, model: selectedModel } = selection;
  const [requestTokenLimit, setRequestTokenLimit] = useState(initialConversation.conversation.requestTokenLimit ?? 0);
  const [contextStrategy, setContextStrategy] = useState<'token-budget'|'key-facts'>(initialConversation.conversation.contextStrategy ?? 'token-budget');
  const [fullContext] = useState(!!initialConversation.conversation.fullContext);
  const [recentMessages, setRecentMessages] = useState(initialConversation.conversation.recentMessages ?? 10);
  const [recentDraft, setRecentDraft] = useState(String(initialConversation.conversation.recentMessages ?? 10));
  const [contextSaving, setContextSaving] = useState(false);
  const contextLock = useRef(false);
  const saveContextSetting = async (setting: {contextStrategy:'token-budget'|'key-facts'} | {recentMessages:number}) => {
    if (contextLock.current) return;
    contextLock.current = true; setContextSaving(true); setLimitError('');
    try {
      const saved = await saveSessionContextSetting(initialConversation.conversation.id, setting);
      setContextStrategy(saved.contextStrategy ?? 'token-budget');
      setRecentMessages(saved.recentMessages ?? 10); setRecentDraft(String(saved.recentMessages ?? 10));
      if (sliding && 'recentMessages' in setting) {
        const events = await loadHistory(initialConversation.conversation.id);
        pageEvents.current = events; fullHistory.current = true;
        setPageCursor({before:null,snapshot:events.at(-1)?.sequence ?? 0});
        setVisibleRuns(new Set(events.map(eventRunId))); setConversation(restoreHistory(initialConversation,events));
      }
    } catch { setLimitError('Could not save context settings.'); setRecentDraft(String(recentMessages)); }
    finally { contextLock.current = false; setContextSaving(false); }
  };
  const saveRecent = async () => {
    const value = Number(recentDraft);
    if (!Number.isSafeInteger(value) || value <= 0) { setLimitError('Recent messages must be a positive whole number.'); setRecentDraft(String(recentMessages)); return; }
    if (value !== recentMessages) await saveContextSetting({recentMessages:value});
  };
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
  const [savedDialogueCount, setSavedDialogueCount] = useState<number>();
  const [factsRevision, setFactsRevision] = useState(0);
  const [memoryEntries,setMemoryEntries] = useState<MemoryEntry[]>([]);
  const [sessionMemorySnapshot,setSessionMemorySnapshot] = useState<MemorySnapshot>();
  const [devMockModel,setDevMockModel]=useState(false);
  const [topicModeReady,setTopicModeReady]=useState(false);
  const [memoryTokens,setMemoryTokens] = useState<MemoryTokenStats>();
  const memoryTokenCache=useRef<MemoryTokenCache>({});
  useEffect(()=>{if(!week3 || !active)return;let live=true;void week3Api.loadSessionMemory(initialConversation.conversation.id).then(value=>{if(live)setSessionMemorySnapshot(value);}).catch(()=>{if(live)setHistoryError('Could not load session memory.');});return()=>{live=false;};},[week3,active,initialConversation.conversation.id,factsRevision]);
  useEffect(()=>{setDevMockModel(false);setTopicModeReady(false);if(!week3 || !active)return;let live=true;void week3Api.topicProcessingMode(initialConversation.conversation.id).then(value=>{if(live){setDevMockModel(value.mockModel);setTopicModeReady(true);}}).catch(()=>{if(live)setHistoryError('Could not load topic processing configuration.');});return()=>{live=false;};},[week3,active,initialConversation.conversation.id]);
  useEffect(()=>{if(!week3 || !sessionMemorySnapshot){setMemoryTokens(undefined);return;}let live=true;setMemoryTokens(undefined);void estimateMemoryTokenStats(sessionMemorySnapshot.data,selectedModel,memoryTokenCache.current).then(value=>{if(live)setMemoryTokens(value);});return()=>{live=false;};},[week3,selectedModel,sessionMemorySnapshot]);
  useEffect(()=>{if(!active || !memory)return;let current=true;void loadMemory(initialConversation.conversation.id).then(value=>{if(current)setMemoryEntries(value.entries);}).catch(()=>{if(current)setHistoryError('Could not load Key-Value Memory.');});return()=>{current=false;};},[active,memory,initialConversation.conversation.id,factsRevision]);

  const [historyError, setHistoryError] = useState("");
  const [instructionNotice,setInstructionNotice]=useState('');
  const [instructionSuccess,setInstructionSuccess]=useState('');
  const [habitsProposal,setHabitsProposal]=useState<{proposal:HabitsProposal;deadline:number}>();
  const [decisionPending,setDecisionPending]=useState(false);
  const decisionLock=useRef(false);
  const activeRef=useRef(active), sessionGeneration=useRef(0);
  if(activeRef.current && !active)sessionGeneration.current++;
  activeRef.current=active;
  useEffect(()=>{
    if(!active && habitsProposal){
      setHabitsProposal(undefined);
      onProposalDismissed?.(decisionLock.current ? 'Profile confirmation dismissed; a submitted decision may still complete.' : 'Pending profile confirmation dismissed after switching sessions.');
    }
  },[active,habitsProposal,onProposalDismissed]);
  useEffect(()=>{
    if(!habitsProposal)return;
    return scheduleProposalExpiry(habitsProposal.deadline,()=>{
      if(decisionLock.current)return;
      setHabitsProposal(current=>current?.proposal.proposalId===habitsProposal.proposal.proposalId ? undefined : current);
      setInstructionNotice('Profile confirmation expired; no decision was sent.');
    });
  },[habitsProposal]);
  const [decideHabits]=useState(()=>createHabitsDecision(initialConversation.conversation.id));
  const [historyAttempt, setHistoryAttempt] = useState(0);
  const [saveFailed, setSaveFailed] = useState(false);
  const [retryingSave, setRetryingSave] = useState(false);
  const sendLock = useRef(false);
  const uncertainTurn = useRef<{question:string;provider:string;model:string;id:string} | null>(null);
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
      setAccountingState(accounting); setDialogueCounts(page.dialogueTokens); setSavedDialogueCount(page.dialogueCount);
      const pair = restoreSessionModelPair(accounting, registry, openAIModel);
      if (!restoredSelection.current) {
        setSelection(pair); setModelChoices(current => ({ ...current, [pair.provider]: pair.model })); restoredSelection.current=true;
      }
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
      setFactsRevision(n=>n+1);
      setOlderError('');
      fullHistory.current = true; setAccountingState(undefined); setDialogueCounts(undefined); setSavedDialogueCount(undefined);
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
    if (!active || (week3 && (!topicModeReady || devMockModel)) || provider !== 'opencode-console' || registry.get(provider)?.limits?.(selectedModel)?.contextWindow) return;
    let current = true;
    void registry.get(provider)?.discover?.().then(() => { if (current) refreshModelMetadata(n => n + 1); }).catch(() => { /* Unknown catalog limits remain unavailable. */ });
    return () => { current = false; };
  }, [active, provider, selectedModel, registry, week3, topicModeReady, devMockModel]);
  const providerModels = registry.modelOptionsFor(provider);
  const selectionProblem = selectedModel && !providerModels.includes(selectedModel) ? 'The selected model is unavailable for this provider. Select an available model.' : '';
  const selectedKey = provider === "openai" ? openAIKey : openCodeKeys[provider];
  const providerLabel =
    provider === "openai"
      ? "OpenAI"
      : provider === "opencode-console"
        ? "OpenCode Console"
        : "OpenCode Go";
  const credentialStates = useSyncExternalStore(credentials.subscribe, credentials.getSnapshot, credentials.getSnapshot);
  const savedCredential = credentialStates[provider];
  const useSavedKey = !selectedKey.trim() && !!savedCredential?.saved && savedCredential.verification === 'verified';
  const hasCredential = devMockModel || !!selectedKey.trim() || useSavedKey;
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

  const chatBase=(week3 ? '/api/week3/sessions/' : '/api/sessions/')+encodeURIComponent(initialConversation.conversation.id);
  const [invariantNotice,setInvariantNotice]=useState('');
  const refreshProtectedHistory=()=>{
    pageGeneration.current++;setVisibleRuns(null);setConversation(null);setUiEvents([]);
    setAccountingState(undefined);setMemoryEntries([]);setSessionMemorySnapshot(undefined);
    pageEvents.current=[];fullHistory.current=false;setHistoryLoaded(false);
    setHistoryAttempt(n=>n+1);setFactsRevision(n=>n+1);
  };
  const policy=usePolicyStatus(chatBase,provider,selectedModel,active);
  const budgetWarning=policy.status?.budget;
  const modelProblem=selectionProblem || (budgetWarning && (!budgetWarning.maintenanceOnly || !/[?？]/u.test(input)) ? budgetWarning.message : "");
  const policyChannel=useRef<BroadcastChannel | null>(null);
  useEffect(()=>{
    if(typeof BroadcastChannel==='undefined')return;
    const channel=new BroadcastChannel('day14-invariants:'+policyRoot);
    policyChannel.current=channel;channel.onmessage=()=>{policy.refresh();};
    return ()=>{channel.close();policyChannel.current=null;};
  },[policyRoot]);
  const send = () => submitSession({
    lock: sendLock, draft: input, ready: !running && historyLoaded && !saveFailed && !limitSaving && !contextSaving,
    model: selectedModel, provider, hasCredential:true, modelProblem,
    onBlocked: (description) => setUiEvents((events) => [...events, {
      kind: 'manager', id: crypto.randomUUID(), createdAt: Date.now(), runId: 'ui',
      category: 'SYSTEM', status: 'failed', description,
    }]),
    onAccepted: () => {
      setRunning(true); setInput(""); setInstructionNotice(''); setInstructionSuccess(''); stickToBottomRef.current=true;
      const previous=uncertainTurn.current;
      const id=previous?.question===input.trim() && previous.provider===provider && previous.model===selectedModel ? previous.id : crypto.randomUUID();
      uncertainTurn.current=null; pendingQuestionId.current=id;
      setUiEvents(events=>[...events,{kind:'message',id,runId:'ui',role:'user',text:input.trim(),createdAt:Date.now()}]);
    },
    onSettled: () => setRunning(false),
    run: async (question) => {
      const turnGeneration=sessionGeneration.current;
      let working = conversation ? structuredClone(conversation) : createManagerConversation(title);
      working.conversation.title = title;
      let runStarted = false;
      let lease:string|undefined;
      let renewal:ReturnType<typeof setInterval>|undefined;
      try {
        setInvariantNotice('');
        const id=pendingQuestionId.current!;
        const turn=await invariantRequest(chatBase+'/invariant-turn','POST',{provider,model:selectedModel,question,turnId:id}).catch(error=>{
          if(error instanceof InvariantRequestError && error.uncertain)uncertainTurn.current={question,provider,model:selectedModel,id};
          throw error;
        });
        if(turn.status==='completed'){
          pendingQuestionId.current=null;refreshProtectedHistory();return;
        }
        if(turn.status!=='unrestricted' || typeof turn.token!=='string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(turn.token))throw new InvariantRequestError('Could not verify session invariants.');
        lease=turn.token;
        renewal=setInterval(()=>{void invariantRequest(chatBase+'/invariant-turn/'+lease,'PATCH').catch(()=>{});},60000);
        if(!hasCredential)throw new InvariantRequestError('No credentials found for this provider. Configure it in Providers.');
        const initialSnapshot=week3 ? await week3Api.loadPersonalizationSnapshot(working.conversation.id) : undefined;
        const prepared=initialSnapshot ? await prepareProfileTurn(initialSnapshot) : undefined;
        const personalizationSnapshot=prepared?.snapshot;
        if(!fullHistory.current){
          working = restoreHistory(initialConversation, await loadHistory(initialConversation.conversation.id));
          fullHistory.current = true;
        }
        setAccountingState(undefined); setDialogueCounts(undefined); setSavedDialogueCount(undefined);
        const savedFunctions = await loadFunctions();
        toolRegistry.replaceCustomTools(savedFunctions.map(executableFunction));
        const topicMode=week3 ? await week3Api.topicProcessingMode(working.conversation.id) : {enabled:false,mockModel:false};
        if(devMockModel && !topicMode.mockModel)throw new Error('The test model is unavailable; retry after restoring test mode.');
        const adapter = topicMode.mockModel ? createDevManagerMock(selectedModel,async()=>{const mode=await week3Api.topicProcessingMode(working.conversation.id);if(!mode.mockModel)throw new Error('The test model is unavailable.');return mode.failSummary;}) : createManagerLlmAdapter({
          providerId: provider,
          model: selectedModel,
          apiKey: selectedKey,
          useSavedKey,
          registry,
          requestTokenLimit: fullContext || sliding ? 0 : requestTokenLimit,
        });
        const manager = new ManagerAgent(adapter, toolRegistry, {
          maxIterations: 8,
        });
        runStarted = true;
        let memoryRevision=0;
        const sessionMemory = week3 ? new SessionMemory({load:()=>week3Api.loadSessionMemory(working.conversation.id),save:async snapshot=>{const saved=await week3Api.saveSessionMemory(working.conversation.id,snapshot);setSessionMemorySnapshot(saved);return saved;}},new MemoryProcessor(adapter),selectedModel,undefined,topicMode.enabled ? async groups=>{for(const group of groups)await week3Api.processTopicSegment(working.conversation.id,group.id);} : undefined) : undefined;
        const pendingResult = manager.run({
          state: working,
          ...(personalizationSnapshot ? {personalizationSnapshot} : {}),
          ...(prepared?.ids ? {turnIds:prepared.ids} : {}),
          ...(sessionMemory ? {sessionMemory} : memory ? {keyValue:{load:async()=>{const value=await loadMemory(working.conversation.id); memoryRevision=value.revision; return value.entries;},save:async(entries:MemoryEntry[])=>{const value=await saveMemory(working.conversation.id,{revision:memoryRevision,entries});memoryRevision=value.revision;setMemoryEntries(value.entries);}}} : sliding ? {contextMode:'sliding' as const, windowSize:recentMessages} : fullContext ? {contextMode: 'full' as const} : contextStrategy === 'key-facts' ? { keyFacts: { recentMessages, load: () => loadSessionFacts(working.conversation.id), save: async (value: Parameters<typeof saveSessionFacts>[1]) => { await saveSessionFacts(working.conversation.id, value); setFactsRevision(n=>n+1); } } } : {}),
          onEvent: async (event) => {
            if(event.type==='message' && event.payload.role==='user' && pendingQuestionId.current){
              const id=pendingQuestionId.current; pendingQuestionId.current=null;
              setUiEvents(events=>events.filter(event=>event.id!==id));
            }
            setVisibleRuns(current=>new Set([...(current??[]),eventRunId(event)]));
            setConversation(structuredClone(working));
            try { await writer.append(event); if (event.type === 'message' || event.type === 'tool-result') setFactsRevision(n=>n+1); }
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
        let memoryCompleted=true;
        if (sessionMemory) {
          const messages = result.state.messages.filter(message=>message.runId===result.run.id);
          if (messages[0]) try {await sessionMemory.finishCurrent(messages[0].id,messages.map(message=>({role:message.role,content:message.text})));} catch {memoryCompleted=false;setHistoryError('Could not update short-term memory. The original dialogue remains saved.');}
          else memoryCompleted=false;
        }
        if (sliding) {
          const events = await loadHistory(initialConversation.conversation.id);
          pageEvents.current = events; fullHistory.current = true;
          setVisibleRuns(new Set(events.map(eventRunId))); setPageCursor({before:null,snapshot:events.at(-1)?.sequence ?? 0});
          setConversation(restoreHistory(initialConversation,events));
        } else setConversation(structuredClone(result.state));
        if(prepared && result.run.status==='completed' && !result.error){
          if(memoryCompleted){const outcome=await finishProfileTurn(prepared);if(outcome.notice)setInstructionNotice(outcome.notice);if(outcome.proposal){if(activeRef.current && turnGeneration===sessionGeneration.current)setHabitsProposal({proposal:outcome.proposal,deadline:performance.now()+outcome.proposal.expiresInMs});else onProposalDismissed?.('Pending profile confirmation dismissed after switching sessions.');}if(outcome.applied)onProfilesChanged?.();}
          else if(prepared.ids)setInstructionNotice('Profile instruction processing was skipped because memory processing did not complete.');
        }
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
      } catch (error) {
        if (error instanceof InvariantRequestError && error.blocked) {
          pendingQuestionId.current = null;
          setInvariantNotice(error.message);
          refreshProtectedHistory();
          return;
        }
        if(!runStarted){
          setInput(current=>current || question);
          const id=pendingQuestionId.current; pendingQuestionId.current=null;
          setUiEvents(events=>events.filter(event=>event.id!==id));
        }
        if(error instanceof InvariantRequestError){setInvariantNotice(error.message);return;}
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
            description: error instanceof week3Api.PersonalizationError ? error.message :
              "Manager execution failed. Check provider, model, key, and tool compatibility.",
          },
        ]);
      } finally {
        policy.refresh();
        if(renewal)clearInterval(renewal);
        if(lease)await invariantRequest(chatBase+'/invariant-turn/'+lease,'DELETE').catch(()=>{});
      }
    },
  });

  return (
    <Box sx={{ display: "grid", gridTemplateColumns: sessionChatColumns, gap: 2, alignItems: "start", minWidth: 0 }}>
    <GlobalStyles styles={{ html: { overscrollBehaviorY: 'none' } }} />
    <Stack spacing={2} sx={{ minWidth: 0 }}>
      {historyError && <Alert severity="error" action={<Button disabled={retryingSave || running} onClick={() => { if (saveFailed) void retrySave(); else setHistoryAttempt((n) => n + 1); }}>Retry</Button>}>{historyError}</Alert>}
      {invariantNotice && <Alert severity="warning">{invariantNotice}</Alert>}
      {instructionNotice && <Alert severity="warning">{instructionNotice}</Alert>}
      {instructionSuccess && <Alert severity="success">{instructionSuccess}</Alert>}
      <Paper variant="outlined" sx={{ p: 2, pb: 3 }}>
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
          {!week3 && <Box role="group" aria-label="Context strategy" sx={{display:'flex',flexWrap:'wrap',gap:1,minHeight:40,alignItems:'center'}}>
            {([['full','Full Context'],['sliding','Sliding Window'],['sticky','Sticky Facts'],['memory','Key-Value Memory']] as const).map(([value,label]) => {
              const selected = (sliding ? 'sliding' : sticky ? 'sticky' : memory ? 'memory' : 'full') === value;
              return <Chip key={value} label={label} clickable disabled={running || contextSaving || switching} onClick={()=>void switchTab(value)} aria-pressed={selected} color={selected?'primary':'default'} variant={selected?'filled':'outlined'} sx={{transition:'background-color 180ms ease, border-color 180ms ease', ...(selected ? {border:'1px solid',borderColor:'primary.main',bgcolor:'action.selected',color:'primary.dark','&&:hover':{bgcolor:'primary.light'}} : {}), '&.Mui-focusVisible':{outline:'2px solid',outlineColor:'primary.dark',outlineOffset:2},'@media (prefers-reduced-motion: reduce)':{transition:'none'}}} />;
            })}
          </Box>
          }
          {(sliding || sticky) && <TextField label="Recent messages" type="number" size="small" sx={{ width: 180, maxWidth: '100%' }} value={recentDraft} disabled={contextSaving || running} onChange={event=>setRecentDraft(event.target.value)} onBlur={()=>void saveRecent()} slotProps={{htmlInput:{min:1,step:1}}} helperText={sliding ? `${Math.min(savedDialogueCount ?? conversation?.messages.filter(message => message.role !== 'system').length ?? 0, recentMessages)} / ${recentMessages} messages` : undefined} />}
          {limitError && <Alert severity="error">{limitError}</Alert>}
          {!timeline.length && (
            <Typography color="text.secondary">
              Start a conversation with {providerLabel} · {selectedModel || "Select a model"}
            </Typography>
          )}
          {historyLoaded && <Typography variant="caption" color="text.secondary">{providerLabel} · {selectedModel || 'Select a model'}</Typography>}
          {selection.notice && <Alert severity="warning">{selection.notice}</Alert>}
          {modelProblem && <Alert severity="warning">{modelProblem}</Alert>}
          {!isWeek2Provider(provider) && <Alert severity="warning">{unsupportedWeek2ProviderMessage}</Alert>}
          {!hasCredential && (
            <Typography variant="caption" color="text.secondary">
              Credentials for {providerLabel} are managed in Providers.
            </Typography>
          )}
          <Popover
            open={!!settingsAnchor}
            anchorEl={settingsAnchor}
            onClose={() => { setSettingsAnchor(null); void saveLimit(); if (contextStrategy === 'key-facts') saveRecent(); }}
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
                  <MenuItem key={entry} value={entry} disabled={entry===selectedModel && !!budgetWarning && !budgetWarning.maintenanceOnly}>
                    {entry}
                  </MenuItem>
                ))}
              </TextField>
              <ChatInvariants key={chatBase} revision={policy.status?.revision} base={chatBase} disabled={running} onChange={()=>{setInvariantNotice('');policy.refresh();policyChannel.current?.postMessage('changed');}}/>
              {!fullContext && !sliding && !sticky && !memory && <><FormControl disabled={contextSaving || running}>
                <FormLabel>Context strategy</FormLabel>
                <RadioGroup value={contextStrategy} onChange={e => { const next=e.target.value as 'token-budget'|'key-facts'; void (async () => { if (contextStrategy === 'key-facts') await saveRecent(); await saveContextSetting({contextStrategy:next}); })(); }}>
                  <FormControlLabel value="token-budget" control={<Radio />} label="Token budget" />
                  <FormControlLabel value="key-facts" control={<Radio />} label="Sticky Facts" />
                </RadioGroup>
              </FormControl>
              {contextStrategy === 'token-budget' ? <TextField label="History token target" type="number" size="small" value={limitDraft}
                disabled={limitSaving || running} onChange={e => setLimitDraft(e.target.value)}
                helperText="Target estimated input tokens per request. Set to 0 to use the model’s available input budget."
                slotProps={{ htmlInput: { min: 0, step: 1 } }} /> : <TextField label="Recent messages" type="number" size="small" value={recentDraft}
                disabled={contextSaving || running} onChange={e => setRecentDraft(e.target.value)}
                slotProps={{ htmlInput: { min: 1, step: 1 } }} />}</>}
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
              pb: 9,
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
            aria-label={week3 ? "Week 3 conversation history" : "Week 2 conversation history"}
          >
            {!historyLoaded && !historyError && <Typography role="status">Loading history…</Typography>}
            {pageCursor?.before != null && <Button size="small" disabled={olderLoading || running || saveFailed || retryingSave} onClick={()=>void loadOlder()}>{olderLoading?'Loading older messages…':'Load older messages'}</Button>}
            {olderError && <Alert severity="error">{olderError}</Alert>}
            <ChatRunLog events={timeline} security={policy.status?.events.filter(event => event.sessionId === initialConversation.conversation.id)} />
            {running && (
              <Typography variant="caption" color="text.secondary">
                Manager is processing…
              </Typography>
            )}
          </Box>
          <Box sx={{ position: 'sticky', bottom: 24, zIndex: 1, bgcolor: 'background.paper' }}>
          {habitsProposal && <HabitsConfirmationCard proposal={habitsProposal.proposal} pending={decisionPending || running} onDecision={decision=>{
            if(decisionLock.current)return;
            if(!proposalIsActionable(activeRef.current,habitsProposal.deadline)){setHabitsProposal(undefined);setInstructionNotice('Profile confirmation is no longer available; no decision was sent.');return;}
            decisionLock.current=true;
            setDecisionPending(true);setInstructionNotice('');setInstructionSuccess('');
            void decideHabits(habitsProposal.proposal.proposalId,decision).then(result=>{
              if(!result)return;
              setHabitsProposal(current=>current?.proposal.proposalId===habitsProposal.proposal.proposalId ? undefined : current);
              const message=decisionNotice(result.status);
              if(result.status==='applied'){setInstructionSuccess(message);onProfilesChanged?.();}
              else if(message)setInstructionNotice(message);
            }).finally(()=>{decisionLock.current=false;setDecisionPending(false);});
          }} />}
          <ChatComposer
            draft={input}
            onDraftChange={setInput}
            onSend={() => void send()}
            disabled={running || !historyLoaded || saveFailed}
            sendDisabled={!!modelProblem}
            running={running}
          />
          </Box>
        </Stack>
      </Paper>
    </Stack>
    <Box><SessionStatsPanel state={conversation ?? initialConversation} draft={input}
      request={{ providerId: provider, model: selectedModel, registry, requestTokenLimit }} tools={toolRegistry}
      active={active} loaded={historyLoaded} running={running} accountingState={accountingState} dialogueCounts={dialogueCounts}
      contextStrategy={fullContext || sliding || memory ? undefined : contextStrategy} recentMessages={recentMessages} factsRevision={factsRevision} fullContext={fullContext || sliding || memory} >
      {policy.status && <Box component="dl" sx={{display:"grid",gridTemplateColumns:"1fr auto",gap:.5,m:0,mt:1}}>
        {(["blocked","redacted","withheld"] as const).map(action=><Box key={action} sx={{display:"contents"}}><Typography component="dt" variant="body2">Security {action[0].toUpperCase()+action.slice(1)}</Typography><Typography component="dd" variant="body2" sx={{m:0}}>{policy.status!.counts[action]}</Typography></Box>)}
      </Box>}
      {memory && <KeyValueDetails entries={memoryEntries} />}
      </SessionStatsPanel>
      {week3 && <SessionMemoryCard snapshot={sessionMemorySnapshot} shortTokens={memoryTokens?.shortTermTokens ?? undefined} summaryTokens={memoryTokens?.mediumTermTokens ?? undefined} factTokens={memoryTokens?.longTermTokens ?? undefined} storedFactTokens={memoryTokens?.storedLongTermTokens ?? undefined} shortLimit={DEFAULT_SHORT_TERM_TOKEN_BUDGET} />}
    </Box>
    </Box>
  );
}
