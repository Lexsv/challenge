import type { HistoryEvent } from "./conversation-history";
import type { ManagerConversationState } from './manager-agent';

export type SessionMetadata = { id: string; title: string; createdAt: number };

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
  return { conversation: { id: item.id, title: item.title, startedAt: item.createdAt, messageIds: [], runIds: [] }, messages: [], runs: [], toolExecutions: [] };
}

export async function loadHistory(id: string): Promise<HistoryEvent[]> {
  const events = await request(`/${encodeURIComponent(id)}/events`);
  if (!Array.isArray(events) || events.some((event) => event.sessionId !== id || !Number.isInteger(event.sequence) || !['message', 'run', 'tool-call', 'tool-result', 'metering'].includes(event.type))) {
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
