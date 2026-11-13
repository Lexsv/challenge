import type { HistoryEvent } from "./conversation-history";
import type { ManagerConversationState } from './manager-agent';
import type { KeyFact } from './fact-extractor';

export type SessionMetadata = { id: string; title: string; createdAt: number; updatedAt?: number; requestTokenLimit?: number; contextStrategy?: 'token-budget' | 'key-facts'; recentMessages?: number };

async function request(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`/api/sessions${path}`, init);
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
export async function createSession(): Promise<SessionMetadata> {
  return metadata(await request('', { method: 'POST' }));
}
export async function renameSession(id: string, title: string): Promise<SessionMetadata> {
  return metadata(await request(`/${encodeURIComponent(id)}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }),
  }));
}
export function emptySession(item: SessionMetadata): ManagerConversationState {
  return { conversation: { id: item.id, title: item.title, startedAt: item.createdAt, requestTokenLimit: item.requestTokenLimit ?? 0, contextStrategy: item.contextStrategy ?? 'token-budget', recentMessages: item.recentMessages ?? 10, messageIds: [], runIds: [] }, messages: [], runs: [], toolExecutions: [] };
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
};
export async function loadHistoryPage(id: string, before?: number, snapshot?: number): Promise<HistoryPage> {
  const query = new URLSearchParams({limit:'20'});
  if(before !== undefined)query.set('before',String(before));
  if(snapshot !== undefined)query.set('snapshot',String(snapshot));
  const page = await request(`/${encodeURIComponent(id)}/events?${query}`) as HistoryPage;
  if (!page || !Array.isArray(page.events) || page.events.some(e=>e.sessionId!==id || !Number.isInteger(e.sequence)) || !Number.isInteger(page.snapshot) || (page.nextBefore!==null && !Number.isInteger(page.nextBefore)) || page.accountingEvents?.some(e=>e.sessionId!==id)) throw new Error('Invalid history page response.');
  return page;
}
