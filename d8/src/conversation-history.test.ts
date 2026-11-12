import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionServer } from '../server/sessions.mjs';
import { ManagerAgent, createManagerConversation, type ManagerLlmMessage } from './manager-agent';
import { HistoryWriter, restoreHistory } from './conversation-history';
import type { HistoryEvent } from './conversation-history';
import { createBuiltInToolRegistry } from './tool-runtime';
import { buildWeek2Timeline } from './week2-agent-tool-lab';
import { emptySession } from './session-api';

describe('SQLite conversation history', () => {
  it('restores calculation timeline and follow-up context after restart without replay or session leakage', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'd7-history-'));
    let server: ReturnType<typeof createSessionServer> | undefined;
    let base = '';
    const start = async () => {
      server = createSessionServer(join(folder, 'sessions.sqlite'));
      await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No test port');
      base = `http://127.0.0.1:${address.port}/api/sessions`;
    };
    const stop = async () => { await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve())); };
    const events = async (id: string): Promise<HistoryEvent[]> => (await fetch(`${base}/${id}/events`)).json();
    const post = async (event: HistoryEvent) => {
      const response = await fetch(`${base}/${event.sessionId}/events`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(event) });
      expect(response.ok).toBe(true);
      return response.json();
    };
    try {
      // Simulate an existing metadata-only installation before history schema initialization.
      const old = new DatabaseSync(join(folder, 'sessions.sqlite'));
      old.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, createdAt INTEGER NOT NULL); INSERT INTO sessions VALUES ('legacy', 'Older session', 1)");
      old.close();
      await start();
      expect(await events('legacy')).toEqual([]);
      expect(await (await fetch(base)).json()).toContainEqual(expect.objectContaining({ id: 'legacy', title: 'Older session', createdAt: 1, requestTokenLimit: 0, updatedAt: expect.any(Number) }));
      const first = await (await fetch(base, { method: 'POST' })).json();
      const second = await (await fetch(base, { method: 'POST' })).json();
      expect(await events(first.id)).toEqual([]);
      const tools = createBuiltInToolRegistry();
      const execute = vi.spyOn(tools, 'executeById');
      const llm = { complete: vi.fn().mockResolvedValueOnce({ toolCalls: [{ id: 'call-tax', toolId: 'builtin.tax_calculator', arguments: { amount: 100, taxRate: 15 } }] }).mockResolvedValueOnce({ text: 'The total is 115.' }) };
      const writer = new HistoryWriter(post);
      const manager = new ManagerAgent(llm, tools);
      await manager.run({ state: emptySession(first), userText: 'Add 15% tax to 100', onEvent: async (event) => {
        if (event.type === 'tool-call') expect(execute).not.toHaveBeenCalled();
        await writer.append(event);
      } });
      expect(execute).toHaveBeenCalledTimes(1);
      const saved = await events(first.id);
      expect(saved.map((event) => event.type)).toEqual(['message', 'run', 'tool-call', 'tool-result', 'message', 'run']);
      const call = saved.find((event) => event.type === 'tool-call')!;
      const result = saved.find((event) => event.type === 'tool-result')!;
      expect(result.payload.id).toBe(call.payload.id);
      expect(result.payload).toMatchObject({ toolCallId: 'call-tax', output: { total: 115 } });
      const badConfig = await fetch(`${base}/${first.id}/events`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...call, id: 'bad-config', payload: { ...call.payload, provider: 'example-provider' } }) });
      expect(badConfig.status).toBe(400);
      const wrongResult = await fetch(`${base}/${second.id}/events`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...result, id: 'wrong-result', sessionId: second.id }) });
      expect(wrongResult.status).toBe(400);
      expect(saved.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
      // An ambiguous response/retry must return the existing event without allocating another sequence.
      await post(result);
      expect(await events(first.id)).toHaveLength(saved.length);
      const conflict = await fetch(`${base}/${first.id}/events`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...result, type: 'tool-call', payload: call.payload }) });
      expect(conflict.status).toBe(409);
      await stop();
      await start();
      const restored = restoreHistory(emptySession(first), await events(first.id));
      expect(restored.messages.map((message) => message.text)).toEqual(['Add 15% tax to 100', 'The total is 115.']);
      const timeline = buildWeek2Timeline(restored, tools);
      expect(timeline.filter((event) => event.kind === 'tool')).toMatchObject([{ status: 'completed', output: { total: 115 } }]);
      expect(timeline.some((event) => event.kind === 'manager' && event.description === 'Run completed')).toBe(true);
      expect(execute).toHaveBeenCalledTimes(1);
      const followup = { complete: vi.fn(async ({ messages }: { messages: readonly ManagerLlmMessage[] }) => {
        expect(messages.some((message) => message.content.includes('"total":115'))).toBe(true);
        expect(messages.some((message) => message.content === 'The total is 115.')).toBe(true);
        return { text: 'Using the saved total, twice 115 is 230.' };
      }) } satisfies ConstructorParameters<typeof ManagerAgent>[0];
      await new ManagerAgent(followup, tools).run({ state: restored, userText: 'Double the previous total', onEvent: (event) => writer.append(event) });
      expect(execute).toHaveBeenCalledTimes(1);
      expect((await events(first.id)).at(-2)?.payload).toMatchObject({ text: 'Using the saved total, twice 115 is 230.' });
      expect(await events(second.id)).toEqual([]);
      const interrupted = restoreHistory(emptySession(first), saved.slice(0, 3));
      expect(interrupted.toolExecutions[0].status).toBe('incomplete');
      expect(buildWeek2Timeline(interrupted, tools).some((event) => event.kind === 'tool' && event.status === 'incomplete')).toBe(true);
      expect(execute).toHaveBeenCalledTimes(1);
    } finally {
      if (server?.listening) await stop();
      await rm(folder, { recursive: true, force: true });
    }
  });
});

afterEach(() => vi.restoreAllMocks());
it('keeps the exact failed event for retry and stops before tool execution if call save fails', async () => {
  const state = createManagerConversation();
  const saved: HistoryEvent[] = [];
  let failed = false;
  const save = vi.fn(async (event: HistoryEvent) => {
    if (event.type === 'tool-call' && !failed) { failed = true; throw new Error('offline'); }
    saved.push(structuredClone(event));
  });
  const writer = new HistoryWriter(save);
  const tools = createBuiltInToolRegistry();
  const execute = vi.spyOn(tools, 'executeById');
  const manager = new ManagerAgent({ complete: async () => ({ toolCalls: [{ id: 'call', toolId: 'builtin.tax_calculator', arguments: { amount: 100, taxRate: 15 } }] }) }, tools);
  await expect(manager.run({ state, userText: 'Calculate', onEvent: (event) => writer.append(event) })).rejects.toThrow('offline');
  expect(execute).not.toHaveBeenCalled();
  const original = save.mock.calls.at(-1)![0];
  await writer.flush();
  expect(saved.at(-1)).toEqual(original);
  expect(execute).not.toHaveBeenCalled();
  expect(() => restoreHistory(createManagerConversation(), saved)).toThrow("another session");
});

it('retries a failed result save without dispatching the calculation again', async () => {
  const state = createManagerConversation();
  const events: HistoryEvent[] = [];
  let failResult = true;
  const writer = new HistoryWriter(async (event) => {
    if (event.type === 'tool-result' && failResult) { failResult = false; throw new Error('lost response'); }
    events.push(structuredClone(event));
  });
  const tools = createBuiltInToolRegistry();
  const execute = vi.spyOn(tools, 'executeById');
  const manager = new ManagerAgent({ complete: async () => ({ toolCalls: [{ id: 'result-retry', toolId: 'builtin.tax_calculator', arguments: { amount: 100, taxRate: 15 } }] }) }, tools);
  await expect(manager.run({ state, userText: 'Calculate tax', onEvent: (event) => writer.append(event) })).rejects.toThrow('lost response');
  expect(execute).toHaveBeenCalledTimes(1);
  expect(restoreHistory(state, events).toolExecutions[0].status).toBe('incomplete');
  await writer.flush();
  const restored = restoreHistory(state, events);
  expect(restored.toolExecutions[0]).toMatchObject({ status: 'completed', output: { total: 115 } });
  expect(restored.runs[0].status).toBe('incomplete');
  expect(execute).toHaveBeenCalledTimes(1);
});

it('keeps delayed run events in the originating session while another session runs', async () => {
  const first = createManagerConversation();
  const second = createManagerConversation();
  const firstEvents: HistoryEvent[] = [];
  const secondEvents: HistoryEvent[] = [];
  let finish!: (value: { text: string }) => void;
  const delayed = new Promise<{ text: string }>((resolve) => { finish = resolve; });
  const tools = createBuiltInToolRegistry();
  const pending = new ManagerAgent({ complete: () => delayed }, tools).run({ state: first, userText: 'First', onEvent: async (event) => { firstEvents.push(event); } });
  await new ManagerAgent({ complete: async () => ({ text: 'Second answer' }) }, tools).run({ state: second, userText: 'Second', onEvent: async (event) => { secondEvents.push(event); } });
  finish({ text: 'First answer' });
  await pending;
  expect(firstEvents.every((event) => event.sessionId === first.conversation.id)).toBe(true);
  expect(secondEvents.every((event) => event.sessionId === second.conversation.id)).toBe(true);
  expect(restoreHistory(first, firstEvents).messages.at(-1)?.text).toBe('First answer');
  expect(restoreHistory(second, secondEvents).messages.at(-1)?.text).toBe('Second answer');
});
