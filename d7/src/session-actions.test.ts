import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SessionRow } from './session-row';
import { expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createSessionServer } from '../server/sessions.mjs';
import { SessionDeletion } from './session-deletion';
import { ManagerAgent } from './manager-agent';
import { createBuiltInToolRegistry } from './tool-runtime';
import { emptySession } from './session-api';
import { restoreHistory, type HistoryEvent } from './conversation-history';
import { buildWeek2Timeline } from './week2-agent-tool-lab';
import { isWeek2Provider, week2ProviderOptions, unsupportedWeek2ProviderMessage } from './week2-provider';
import { submitSession } from './session-send';

async function fixture(run: (context: {
  api: (path?: string, method?: string, body?: unknown) => Promise<Response>;
  restart: () => Promise<void>;
  database: string;
}) => Promise<void>) {
  const folder = await mkdtemp(join(tmpdir(), 'd7-session-actions-'));
  const database = join(folder, 'sessions.sqlite');
  let server: ReturnType<typeof createSessionServer> | undefined;
  let base = '';
  const start = async () => {
    server = createSessionServer(database);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    base = `http://127.0.0.1:${address.port}`;
  };
  const stop = () => new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
  const api = (path = '', method = 'GET', body?: unknown) => fetch(`${base}/api/sessions${path}`, {
    method, headers: { Origin: base, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  try { await start(); await run({ api, database, restart: async () => { await stop(); await start(); } }); }
  finally { if (server?.listening) await stop(); await rm(folder, { recursive: true, force: true }); }
}

it('cancellation keeps a calculation; confirmed deletion removes only that session and its full history across restart', async () => {
  await fixture(async ({ api, database, restart }) => {
    const first = await (await api('', 'POST')).json();
    const second = await (await api('', 'POST')).json();
    const tools = createBuiltInToolRegistry();
    const save = async (event: HistoryEvent) => { expect((await api(`/${event.sessionId}/events`, 'POST', event)).ok).toBe(true); };
    const llm = { complete: vi.fn().mockResolvedValueOnce({ toolCalls: [{ id: 'tax-call', toolId: 'builtin.tax_calculator', arguments: { amount: 100, taxRate: 15 } }] }).mockResolvedValueOnce({ text: 'Total 115' }) };
    await new ManagerAgent(llm, tools).run({ state: emptySession(first), userText: 'Calculate tax', onEvent: save });
    await new ManagerAgent({ complete: async () => ({ text: 'Keep this other session' }) }, tools).run({ state: emptySession(second), userText: 'Other question', onEvent: save });
    const before = await (await api(`/${first.id}/events`)).json();
    const otherBefore = await (await api(`/${second.id}/events`)).json();
    let rows = [first.id, second.id];
    let selected: string | null = first.id;
    const remove = vi.fn(async (id: string) => { expect((await api(`/${id}`, 'DELETE')).ok).toBe(true); });
    const action = new SessionDeletion(remove, (id) => { rows = rows.filter((row) => row !== id); if (selected === id) selected = null; });
    action.request({ id: first.id, title: first.title });
    action.cancel();
    expect(await action.confirm()).toBe(false);
    expect(remove).not.toHaveBeenCalled();
    expect(rows).toEqual([first.id, second.id]);
    expect(await (await api(`/${first.id}/events`)).json()).toEqual(before);
    action.request({ id: first.id, title: first.title });
    expect(await action.confirm()).toBe(true);
    expect(selected).toBe(null);
    expect(rows).toEqual([second.id]);
    expect((await api(`/${first.id}/events`)).status).toBe(404);
    expect((await api(`/${first.id}`, 'PATCH', { title: 'Cannot revive' })).status).toBe(404);
    expect((await api(`/${first.id}/events`, 'POST', before[0])).status).toBe(404);
    const db = new DatabaseSync(database);
    expect(db.prepare('SELECT count(*) AS count FROM history_events WHERE sessionId = ?').get(first.id)?.count).toBe(0);
    expect(db.prepare('SELECT count(*) AS count FROM sessions WHERE id = ?').get(first.id)?.count).toBe(0);
    db.close();
    await restart();
    expect(await (await api()).json()).toEqual([second]);
    expect(await (await api(`/${second.id}/events`)).json()).toEqual(otherBefore);
    const restored = restoreHistory(emptySession(second), otherBefore);
    expect(restored.messages.at(-1)?.text).toBe('Keep this other session');
    expect(buildWeek2Timeline(restored, tools)).toHaveLength(4);
  });
});

it('rolls back history deletion if deleting session metadata fails', async () => {
  await fixture(async ({ api, database }) => {
    const session = await (await api('', 'POST')).json();
    await new ManagerAgent({ complete: async () => ({ text: 'Preserve on failure' }) }, createBuiltInToolRegistry()).run({ state: emptySession(session), userText: 'Hello', onEvent: async (event) => { expect((await api(`/${session.id}/events`, 'POST', event)).ok).toBe(true); } });
    const before = await (await api(`/${session.id}/events`)).json();
    const db = new DatabaseSync(database);
    // Fault injection applies only to this isolated temporary test database.
    db.exec("CREATE TRIGGER block_session_delete BEFORE DELETE ON sessions BEGIN SELECT RAISE(ABORT, 'test failure'); END;");
    expect((await api(`/${session.id}`, 'DELETE')).status).toBe(500);
    expect(await (await api()).json()).toEqual([session]);
    expect(await (await api(`/${session.id}/events`)).json()).toEqual(before);
    db.close();
  });
});

it('rejects writes from a pending run after deletion and never dispatches its tool call', async () => {
  await fixture(async ({ api }) => {
    const session = await (await api('', 'POST')).json();
    let finish!: (value: { toolCalls: { id: string; toolId: string; arguments: unknown }[] }) => void;
    const response = new Promise<{ toolCalls: { id: string; toolId: string; arguments: unknown }[] }>((resolve) => { finish = resolve; });
    const tools = createBuiltInToolRegistry();
    const execute = vi.spyOn(tools, 'executeById');
    const running = new ManagerAgent({ complete: () => response }, tools).run({ state: emptySession(session), userText: 'Pending question', onEvent: async (event) => {
      const saved = await api(`/${session.id}/events`, 'POST', event);
      if (!saved.ok) throw new Error(`Save failed (${saved.status})`);
    } });
    await vi.waitFor(async () => expect(await (await api(`/${session.id}/events`)).json()).toHaveLength(2));
    expect((await api(`/${session.id}`, 'DELETE')).status).toBe(200);
    const rejected = expect(running).rejects.toThrow('404');
    finish({ toolCalls: [{ id: 'late-call', toolId: 'builtin.tax_calculator', arguments: { amount: 100, taxRate: 15 } }] });
    await rejected;
    expect(execute).not.toHaveBeenCalled();
    expect(await (await api()).json()).toEqual([]);
  });
});

it('keeps the row until save succeeds, reports deletion failure, and prevents duplicate confirmation', async () => {
  let finish!: () => void;
  const wait = new Promise<void>((resolve) => { finish = resolve; });
  const remove = vi.fn().mockRejectedValueOnce(new Error('offline')).mockImplementationOnce(() => wait);
  const onDeleted = vi.fn();
  const action = new SessionDeletion(remove, onDeleted);
  action.request({ id: 'test-session', title: 'Calculation' });
  expect(await action.confirm()).toBe(false);
  expect(action.getSnapshot().target?.title).toBe('Calculation');
  expect(action.getSnapshot().error).toContain('Could not delete');
  expect(onDeleted).not.toHaveBeenCalled();
  const pending = action.confirm();
  expect(await action.confirm()).toBe(false);
  expect(onDeleted).not.toHaveBeenCalled();
  finish();
  expect(await pending).toBe(true);
  expect(onDeleted).toHaveBeenCalledExactlyOnceWith('test-session');
});

it('offers only supported Week 2 providers and blocks a legacy Go send without clearing its draft/history', async () => {
  expect(week2ProviderOptions.map((option) => option.id)).toEqual(['openai', 'opencode-console']);
  expect(isWeek2Provider('opencode-go')).toBe(false);
  let draft = 'Legacy question';
  const history = { messages: ['Prior user message', 'Prior response'], toolResult: 115 };
  const before = structuredClone(history);
  const run = vi.fn();
  let error = '';
  expect(await submitSession({ lock: { current: false }, draft, provider: 'opencode-go', ready: true, model: 'legacy-model', hasCredential: true,
    onBlocked: (message) => { error = message; }, onAccepted: () => { draft = ''; }, onSettled: () => {}, run,
  })).toBe(false);
  expect(run).not.toHaveBeenCalled();
  expect(draft).toBe('Legacy question');
  expect(history).toEqual(before);
  expect(error).toBe(unsupportedWeek2ProviderMessage);
});

it('renders a trailing accessible session menu button without nesting it in the selection button', () => {
  const html = renderToStaticMarkup(createElement(SessionRow, {
    id: 'test-session', title: 'Calculation', selected: true, menuOpen: true, disabled: false,
    onSelect: () => {}, onActions: () => {},
  }));
  expect(html).toContain('aria-label="Actions for Calculation"');
  expect(html).toContain('aria-haspopup="menu"');
  expect(html).toContain('aria-controls="session-actions-menu"');
  expect(html).toContain('aria-expanded="true"');
  expect(html).toContain('aria-current="true"');
  expect(html.indexOf('>Calculation<')).toBeLessThan(html.indexOf('aria-label="Actions for Calculation"'));
});
