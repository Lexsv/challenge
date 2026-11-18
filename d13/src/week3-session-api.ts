import type { HistoryEvent } from "./conversation-history";
import type { ManagerConversationState } from './manager-agent';
import type { KeyFact } from './fact-extractor';
import type { MemoryEntry } from './key-value-memory';
import type { MemorySnapshot } from './session-memory';

export type PersonalizationSnapshot = Readonly<{sessionId:string;profileId:string;profileRevision:number;habits:string}>;
export type TurnIdentifiers = Readonly<{runId:string;messageId:string}>;
export type PreparedInstructionTurn = Readonly<{token:string;snapshot:PersonalizationSnapshot}>;
export type InstructionChange = {action:'ADD';after:string}|{action:'UPDATE';before:string;after:string}|{action:'REMOVE';before:string};
export type InstructionTurnOutcome = {status:'confirmation_required';proposalId:string;expiresInMs:number;changes:InstructionChange[]}|{status:'applied'|'unchanged';revision:number}|{status:'general_skipped'|'invalid_token'|'mismatch'|'missing_message'|'ambiguous_message'|'incomplete_run'|'detector_failure'|'conflict'|'clarification_required'|'persistence_failure'|'unknown_commit'|'archive_failure'};
export type InstructionDecisionOutcome = {status:'applied'|'unchanged';revision:number}|{status:'rejected'|'invalid_proposal'|'expired_proposal'|'conflict'|'clarification_required'|'persistence_failure'|'unknown_commit'|'mismatch'};
export type PersonalizationErrorCode = 'session_not_found' | 'profile_not_found' | 'invalid_association' | 'database_error' | 'unavailable';
export class PersonalizationError extends Error {
  constructor(readonly code:PersonalizationErrorCode) {
    super(code==='session_not_found' ? 'This session is unavailable.' : code==='profile_not_found' ? 'The session profile is missing.' : code==='invalid_association' ? 'The session profile association is invalid.' : 'Could not resolve the session profile. Please retry.');
  }
}
/** Read a new snapshot for each turn; no profile ID is supplied by the client. */
export async function loadPersonalizationSnapshot(sessionId:string):Promise<PersonalizationSnapshot> {
  let response:Response;
  try {response=await fetch(`/api/week3/sessions/${encodeURIComponent(sessionId)}/profile`,{cache:'no-store'});}
  catch {throw new PersonalizationError('unavailable');}
  let result:unknown;
  try {result=await response.json();} catch {throw new PersonalizationError('unavailable');}
  const value=result as {ok?:unknown;data?:Partial<PersonalizationSnapshot>;error?:unknown} | null;
  if (!response.ok || value?.ok!==true) {
    const codes:PersonalizationErrorCode[]=['session_not_found','profile_not_found','invalid_association','database_error'];
    throw new PersonalizationError(codes.includes(value?.error as PersonalizationErrorCode) ? value!.error as PersonalizationErrorCode : 'unavailable');
  }
  const data=value.data;
  if (!data || data.sessionId!==sessionId || typeof data.profileId!=='string' || !data.profileId.trim() || data.profileId!==data.profileId.trim() || !Number.isSafeInteger(data.profileRevision) || data.profileRevision!<1 || typeof data.habits!=='string' || (data.profileId==='general' && data.habits!=='')) throw new PersonalizationError('invalid_association');
  return Object.freeze({sessionId:data.sessionId,profileId:data.profileId,profileRevision:data.profileRevision!,habits:data.habits});
}

export async function prepareInstructionTurn(sessionId:string,ids:TurnIdentifiers):Promise<PreparedInstructionTurn> {
  const value=await request(`/${encodeURIComponent(sessionId)}/turn-context`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(ids)}) as {token?:unknown;snapshot?:Partial<PersonalizationSnapshot>};
  const data=value?.snapshot;
  if(typeof value?.token!=='string' || !/^[A-Za-z0-9_-]{43}$/.test(value.token) || !data || data.sessionId!==sessionId || typeof data.profileId!=='string' || !data.profileId.trim() || data.profileId!==data.profileId.trim() || !Number.isSafeInteger(data.profileRevision) || data.profileRevision!<1 || typeof data.habits!=='string' || (data.profileId==='general' && data.habits!==''))throw new Error('Invalid turn context.');
  return Object.freeze({token:value.token,snapshot:Object.freeze({sessionId:data.sessionId,profileId:data.profileId,profileRevision:data.profileRevision!,habits:data.habits})});
}

export async function completeInstructionTurn(sessionId:string,ids:TurnIdentifiers,token:string):Promise<InstructionTurnOutcome> {
  const value=await request(`/${encodeURIComponent(sessionId)}/turn-completion`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...ids,turnToken:token})}) as {status?:unknown;revision?:unknown;proposalId?:unknown;expiresInMs?:unknown;changes?:unknown};
  if(value?.status==='confirmation_required'){
    const changes=value.changes;
    if(typeof value.proposalId!=='string' || !/^[A-Za-z0-9_-]{43}$/.test(value.proposalId) || !Number.isSafeInteger(value.expiresInMs) || (value.expiresInMs as number)<1 || !Array.isArray(changes) || !changes.length || changes.length>16 || !changes.every(change=>change && typeof change==='object' && (change.action==='ADD' ? Object.keys(change).length===2 && typeof change.after==='string' : change.action==='UPDATE' ? Object.keys(change).length===3 && typeof change.before==='string' && typeof change.after==='string' : change.action==='REMOVE' && Object.keys(change).length===2 && typeof change.before==='string')))throw new Error('Invalid confirmation response.');
    return value as InstructionTurnOutcome;
  }
  const statuses=['applied','unchanged','general_skipped','invalid_token','mismatch','missing_message','ambiguous_message','incomplete_run','detector_failure','conflict','clarification_required','persistence_failure','unknown_commit','archive_failure'];
  if(!value || typeof value.status!=='string' || !statuses.includes(value.status) || (['applied','unchanged'].includes(value.status) && (!Number.isSafeInteger(value.revision) || (value.revision as number)<1)))throw new Error('Invalid turn completion response.');
  return value as InstructionTurnOutcome;
}

/** Explicit, proposal-specific decision; the server owns the actual change and revision. */
export async function decideInstructionProposal(sessionId:string,proposalId:string,decision:'accept'|'reject'):Promise<InstructionDecisionOutcome> {
  const value=await request(`/${encodeURIComponent(sessionId)}/instruction-decision`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({proposalId,decision})}) as {status?:unknown;revision?:unknown};
  const statuses=['applied','unchanged','rejected','invalid_proposal','expired_proposal','conflict','clarification_required','persistence_failure','unknown_commit','mismatch'];
  if(!value || typeof value.status!=='string' || !statuses.includes(value.status) || (['applied','unchanged'].includes(value.status) && (!Number.isSafeInteger(value.revision) || (value.revision as number)<1)))throw new Error('Invalid proposal decision response.');
  return value as InstructionDecisionOutcome;
}

export async function loadSessionMemory(id: string): Promise<MemorySnapshot> {
  return await request(`/${encodeURIComponent(id)}/memory`) as MemorySnapshot;
}
export async function saveSessionMemory(id: string, snapshot: MemorySnapshot): Promise<MemorySnapshot> {
  return await request(`/${encodeURIComponent(id)}/memory`, {method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(snapshot)}) as MemorySnapshot;
}
export async function topicProcessingMode(id:string):Promise<{enabled:boolean;mockModel:boolean;failSummary:boolean}> {
  const value=await request(`/${encodeURIComponent(id)}/topic-mode`) as {enabled?:unknown;mockModel?:unknown;failSummary?:unknown};
  if(typeof value.enabled!=='boolean' || (value.mockModel!==undefined && typeof value.mockModel!=='boolean') || (value.failSummary!==undefined && typeof value.failSummary!=='boolean') || (value.mockModel && !value.enabled))throw new Error('Topic processing configuration is unavailable.');
  return {enabled:value.enabled,mockModel:value.mockModel===true,failSummary:value.failSummary===true};
}
export async function processTopicSegment(id:string,runId:string):Promise<void> {
  const value=await request(`/${encodeURIComponent(id)}/segments`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({runId})}) as {status?:unknown};
  if(value.status!=='completed' && value.status!=='already_completed')throw new Error('Topic processing did not complete.');
}

export type SessionMetadata = { id: string; title: string; createdAt: number; profileId?: string; updatedAt?: number; requestTokenLimit?: number; contextStrategy?: 'token-budget' | 'key-facts'; recentMessages?: number; fullContext?: 0 | 1; slidingSelected?: 0 | 1; stickySelected?: 0 | 1; memorySelected?: 0 | 1 };

async function request(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`/api/week3/sessions${path}`, init);
  if (!response.ok) throw new Error(`Session request failed (${response.status}).`);
  return response.json();
}
function metadata(value: unknown): SessionMetadata {
  const item = value as SessionMetadata | null;
  if (!item || typeof item.id !== 'string' || typeof item.title !== 'string' || !Number.isFinite(item.createdAt)) {
    throw new Error('Invalid session response.');
  }
  return item;
}
export async function listSessions(): Promise<SessionMetadata[]> {
  const values = await request('');
  if (!Array.isArray(values)) throw new Error('Invalid session list.');
  return values.map(metadata);
}
export async function createSession(profileId?:string): Promise<SessionMetadata> {
  return metadata(await request('', { method: 'POST', ...(profileId===undefined ? {} : {headers:{'Content-Type':'application/json'},body:JSON.stringify({profileId})}) }));
}
export type Checkpoint = { id: string; name: string };
export async function listCheckpoints(id: string): Promise<Checkpoint[]> {
  const value = await request(`/${encodeURIComponent(id)}/checkpoints`);
  if (!Array.isArray(value)) throw new Error('Invalid checkpoint list.');
  return value as Checkpoint[];
}
export async function createCheckpoint(id: string, name: string): Promise<void> {
  await request(`/${encodeURIComponent(id)}/checkpoints`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name})});
}
export async function createBranch(id: string, checkpointId: string, name: string): Promise<SessionMetadata> {
  return metadata(await request(`/${encodeURIComponent(id)}/branches`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({checkpointId,name})}));
}
export async function renameSession(id: string, title: string): Promise<SessionMetadata> {
  return metadata(await request(`/${encodeURIComponent(id)}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }),
  }));
}
export function emptySession(item: SessionMetadata): ManagerConversationState {
  return { conversation: { id: item.id, title: item.title, startedAt: item.createdAt, requestTokenLimit: item.requestTokenLimit ?? 0, contextStrategy: item.contextStrategy ?? 'token-budget', recentMessages: item.recentMessages ?? 10, ...(item.fullContext ? {fullContext: true} : {}), ...(item.slidingSelected ? {slidingSelected: true} : {}), ...(item.stickySelected ? {stickySelected: true} : {}), ...(item.memorySelected ? {memorySelected:true} : {}), messageIds: [], runIds: [] }, messages: [], runs: [], toolExecutions: [] };
}
export async function openMemorySession(id:string):Promise<SessionMetadata>{return metadata(await request(`/${encodeURIComponent(id)}/memory-session`,{method:'POST'}));}
export async function selectMemorySession(id:string,selected:boolean):Promise<SessionMetadata>{return metadata(await request(`/${encodeURIComponent(id)}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({memorySelected:selected?1:0})}));}
export type SavedMemory={revision:number;entries:MemoryEntry[]};
export async function loadMemory(id:string):Promise<SavedMemory>{const value=await request(`/${encodeURIComponent(id)}/memory`) as SavedMemory;if(!value || !Number.isSafeInteger(value.revision) || !Array.isArray(value.entries))throw new Error('Invalid memory response.');return value;}
export async function saveMemory(id:string,value:SavedMemory):Promise<SavedMemory>{return await request(`/${encodeURIComponent(id)}/memory`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)}) as SavedMemory;}

export async function openStickySession(id: string): Promise<SessionMetadata> {
  return metadata(await request(`/${encodeURIComponent(id)}/sticky`, {method:'POST'}));
}
export async function selectStickySession(id: string, selected: boolean): Promise<SessionMetadata> {
  return metadata(await request(`/${encodeURIComponent(id)}`, {method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({stickySelected:selected ? 1 : 0})}));
}

export async function openSlidingSession(id: string): Promise<SessionMetadata> {
  return metadata(await request(`/${encodeURIComponent(id)}/sliding`, {method:'POST'}));
}
export async function selectSlidingSession(id: string, selected: boolean): Promise<SessionMetadata> {
  return metadata(await request(`/${encodeURIComponent(id)}`, {method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({slidingSelected:selected ? 1 : 0})}));
}

export async function saveFullContext(id: string, fullContext: boolean): Promise<SessionMetadata> {
  return metadata(await request(`/${encodeURIComponent(id)}`, {method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({fullContext:fullContext ? 1 : 0})}));
}

export async function saveSessionContextSetting(id: string, setting: { contextStrategy: 'token-budget' | 'key-facts' } | { recentMessages: number }): Promise<SessionMetadata> {
  return metadata(await request(`/${encodeURIComponent(id)}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(setting),
  }));
}

export type SavedFacts = { facts: KeyFact[]; coveredMessageId: string | null };
export async function loadSessionFacts(id: string): Promise<SavedFacts> {
  const value = await request(`/${encodeURIComponent(id)}/facts`) as SavedFacts;
  if (!value || !Array.isArray(value.facts) || !(value.coveredMessageId === null || typeof value.coveredMessageId === 'string')) throw new Error('Invalid saved facts.');
  return value;
}
export async function saveSessionFacts(id: string, value: {facts: KeyFact[]; coveredMessageId: string; expectedCoveredMessageId: string | null}): Promise<void> {
  await request(`/${encodeURIComponent(id)}/facts`, {method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});
}

export async function loadHistory(id: string): Promise<HistoryEvent[]> {
  const events = await request(`/${encodeURIComponent(id)}/events`);
  if (!Array.isArray(events) || events.some((event) => event.sessionId !== id || !Number.isInteger(event.sequence) || !['message', 'run', 'tool-call', 'tool-result', 'metering', 'context'].includes(event.type))) {
    throw new Error('Invalid history response.');
  }
  return events;
}
export async function saveHistoryEvent(event: HistoryEvent): Promise<unknown> {
  return request(`/${encodeURIComponent(event.sessionId)}/events`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(event),
  });
}

export async function deleteSession(id: string): Promise<void> {
  await request(`/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function saveSessionRequestTokenLimit(id: string, requestTokenLimit: number): Promise<SessionMetadata> {
  return metadata(await request(`/${encodeURIComponent(id)}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestTokenLimit }),
  }));
}

export type HistoryPage = {
  events: HistoryEvent[]; nextBefore: number | null; snapshot: number;
  accountingEvents?: HistoryEvent[];
  dialogueTokens?: Partial<Record<'o200k_base' | 'cl100k_base', number>>;
  dialogueCount?: number;
};
export async function loadHistoryPage(id: string, before?: number, snapshot?: number): Promise<HistoryPage> {
  const query = new URLSearchParams({limit:'20'});
  if(before !== undefined)query.set('before',String(before));
  if(snapshot !== undefined)query.set('snapshot',String(snapshot));
  const page = await request(`/${encodeURIComponent(id)}/events?${query}`) as HistoryPage;
  if (!page || !Array.isArray(page.events) || page.events.some(e=>e.sessionId!==id || !Number.isInteger(e.sequence)) || !Number.isInteger(page.snapshot) || (page.nextBefore!==null && !Number.isInteger(page.nextBefore)) || page.accountingEvents?.some(e=>e.sessionId!==id)) throw new Error('Invalid history page response.');
  return page;
}
