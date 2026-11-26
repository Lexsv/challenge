export type SessionSelection = { type: 'chat' | 'worker'; id: string };
export const WEEK3_SELECTION_KEY = 'expert-lab:d18:week3:selected-session';

export function readSessionSelection(storage: Pick<Storage, 'getItem'>): SessionSelection | null {
  try {
    const value: unknown = JSON.parse(storage.getItem(WEEK3_SELECTION_KEY) ?? 'null');
    if (value && typeof value === 'object' && 'type' in value && 'id' in value &&
        (value.type === 'chat' || value.type === 'worker') && typeof value.id === 'string' && value.id.length > 0) {
      return { type: value.type, id: value.id };
    }
  } catch { /* Storage may be unavailable or contain malformed data. */ }
  return null;
}

export function writeSessionSelection(storage: Pick<Storage, 'setItem' | 'removeItem'>, selection: SessionSelection | null): void {
  try {
    if (selection) storage.setItem(WEEK3_SELECTION_KEY, JSON.stringify(selection));
    else storage.removeItem(WEEK3_SELECTION_KEY);
  } catch { /* Selection persistence is optional when storage is unavailable. */ }
}

// A list response may arrive after the user has selected another session.
// Consult the latest intent rather than the intent when the request began.
export function resolveWorkerSelection(intent: SessionSelection | null | undefined, ids: readonly string[]):
  { kind: 'select'; id: string } | { kind: 'missing' } | { kind: 'unchanged' } {
  if (intent?.type !== 'worker') return { kind: 'unchanged' };
  return ids.includes(intent.id) ? { kind: 'select', id: intent.id } : { kind: 'missing' };
}
