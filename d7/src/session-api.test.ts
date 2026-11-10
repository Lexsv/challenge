import { afterEach, expect, it, vi } from 'vitest';
import { emptySession, listSessions, createSession, renameSession } from './session-api';
afterEach(() => vi.unstubAllGlobals());
it('restores metadata with empty chat history', () => {
  const state = emptySession({ id: 'saved', title: 'Planning', createdAt: 123 });
  expect(state.conversation).toEqual({ id: 'saved', title: 'Planning', startedAt: 123, messageIds: [], runIds: [] });
  expect(state.messages).toEqual([]);
  expect(state.runs).toEqual([]);
  expect(state.toolExecutions).toEqual([]);
});
it('rejects unsuccessful operations instead of producing local metadata', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }));
  await expect(listSessions()).rejects.toThrow('503');
  await expect(createSession()).rejects.toThrow('503');
  await expect(renameSession('saved', 'Planning')).rejects.toThrow('503');
});
it('rejects malformed list responses', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => [{ title: 'Incomplete' }] }));
  await expect(listSessions()).rejects.toThrow('Invalid session response');
});
