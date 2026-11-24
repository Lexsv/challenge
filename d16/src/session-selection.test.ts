import { describe, expect, it } from 'vitest';
import { readSessionSelection, resolveWorkerSelection, writeSessionSelection, WEEK3_SELECTION_KEY } from './session-selection';

describe('Week 3 session selection persistence', () => {
  function storage() {
    const values = new Map<string, string>();
    return { getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); } };
  }
  it('restores a selected Worker with its type after reload', () => {
    const data = storage();
    writeSessionSelection(data, { type: 'worker', id: 'worker-a' });
    expect(readSessionSelection(data)).toEqual({ type: 'worker', id: 'worker-a' });
  });
  it('preserves Chat selection and distinguishes identical IDs across types', () => {
    const data = storage();
    writeSessionSelection(data, { type: 'chat', id: 'same-id' });
    expect(readSessionSelection(data)).toEqual({ type: 'chat', id: 'same-id' });
    writeSessionSelection(data, { type: 'worker', id: 'same-id' });
    expect(readSessionSelection(data)).toEqual({ type: 'worker', id: 'same-id' });
  });
  it('retains the latest explicit selection through chat and Worker switches', () => {
    const data = storage();
    for (const selection of [{ type: 'chat', id: 'chat' }, { type: 'worker', id: 'a' }, { type: 'worker', id: 'b' }, { type: 'chat', id: 'chat' }] as const) {
      writeSessionSelection(data, selection);
      expect(readSessionSelection(data)).toEqual(selection);
    }
  });
  it('clears stale selections and safely ignores malformed or unavailable storage', () => {
    const data = storage();
    writeSessionSelection(data, { type: 'worker', id: 'deleted' });
    writeSessionSelection(data, null);
    expect(readSessionSelection(data)).toBeNull();
    data.setItem(WEEK3_SELECTION_KEY, '{');
    expect(readSessionSelection(data)).toBeNull();
    data.setItem(WEEK3_SELECTION_KEY, JSON.stringify({ type: 'unknown', id: 'x' }));
    expect(readSessionSelection(data)).toBeNull();
    expect(readSessionSelection({ getItem: () => { throw Error('unavailable'); } })).toBeNull();
  });
});

it('resolves existing Workers, clears missing Workers, and leaves Chat selections alone', () => {
  expect(resolveWorkerSelection({ type: 'worker', id: 'a' }, ['a', 'b'])).toEqual({ kind: 'select', id: 'a' });
  expect(resolveWorkerSelection({ type: 'worker', id: 'deleted' }, ['a'])).toEqual({ kind: 'missing' });
  expect(resolveWorkerSelection({ type: 'chat', id: 'a' }, ['a'])).toEqual({ kind: 'unchanged' });
});
it('uses the latest selection when a pending session list returns', () => {
  const ids = ['a', 'b'];
  expect(resolveWorkerSelection({ type: 'worker', id: 'b' }, ids)).toEqual({ kind: 'select', id: 'b' });
  expect(resolveWorkerSelection({ type: 'chat', id: 'chat' }, ids)).toEqual({ kind: 'unchanged' });
});
