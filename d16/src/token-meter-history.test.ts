import { expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createSessionServer } from '../server/sessions.mjs';
import { createManagerLlmAdapter } from './manager-llm-adapter';
import { ManagerAgent } from './manager-agent';
import { ProviderRegistry } from './provider-registry';
import { createBuiltInToolRegistry } from './tool-runtime';
import { emptySession } from './session-api';
import { restoreHistory, type HistoryEvent } from './conversation-history';
import { buildWeek2Timeline } from './week2-agent-tool-lab';

it('migrates old history safely, saves one Library item per request, and restores usage/cost without replaying calls', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'd7-token-history-'));
  const path = join(folder, 'sessions.sqlite');
  const oldMessage = { id: 'old-message', conversationId: 'legacy', runId: 'old-run', role: 'user', type: 'text', text: 'Legacy history retained', createdAt: 1 };
  const old = new DatabaseSync(path);
  old.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, createdAt INTEGER NOT NULL); INSERT INTO sessions VALUES ('legacy', 'Legacy session', 1); CREATE TABLE history_events (id TEXT PRIMARY KEY, sessionId TEXT NOT NULL REFERENCES sessions(id), sequence INTEGER NOT NULL, type TEXT NOT NULL CHECK(type IN ('message','run','tool-call','tool-result')), payload TEXT NOT NULL CHECK(json_valid(payload)), UNIQUE(sessionId, sequence));");
  old.prepare('INSERT INTO history_events VALUES (?, ?, ?, ?, ?)').run('legacy-event', 'legacy', 1, 'message', JSON.stringify(oldMessage));
  old.close();
  let server: ReturnType<typeof createSessionServer> | undefined;
  let base = '';
  const start = async () => {
    server = createSessionServer(path);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No local test port');
    base = `http://127.0.0.1:${address.port}`;
  };
  const stop = () => new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
  const api = (suffix = '', method = 'GET', body?: unknown) => fetch(`${base}/api/sessions${suffix}`, { method, headers: { Origin: base, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  try {
    await start();
    expect(await (await api('/legacy/events')).json()).toMatchObject([{ id: 'legacy-event', payload: oldMessage, sequence: 1 }]);
    const session = await (await api('', 'POST')).json();
    const other = await (await api('', 'POST')).json();
    const tools = createBuiltInToolRegistry();
    const execute = vi.spyOn(tools, 'executeById');
    const registry = new ProviderRegistry();
    vi.spyOn(registry, 'endpointFor').mockReturnValue('https://api.openai.com/v1/responses');
    let count = 0;
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      const saved: HistoryEvent[] = await (await api(`/${session.id}/events`)).json();
      const last = saved.at(-1)!;
      expect(last.type).toBe('metering');
      expect(last.payload).toMatchObject({ status: 'running', sessionId: session.id, model: 'gpt-4o-mini' });
      if (last.type !== 'metering') throw new Error('Missing pre-request meter');
      expect(last.payload.estimatedInputTokens).toBeGreaterThan(0);
      expect(last.payload.estimatedInputCost).toBeGreaterThan(0);
      const request = JSON.parse(init!.body as string);
      expect(request.tools.some((tool: { name: string }) => tool.name.includes('tiktoken'))).toBe(false);
      count++;
      if (count === 1) return new Response(JSON.stringify({ model: 'gpt-4o-mini', output: [{ type: 'function_call', call_id: 'tax-call', name: 'builtin_tax_calculator', arguments: JSON.stringify({ amount: 100, taxRate: 15 }) }], usage: { input_tokens: 20, output_tokens: 4, total_tokens: 24 }, debug: 'raw-response-must-not-be-copied' }));
      return new Response(JSON.stringify({ model: 'gpt-4o-mini', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Total: 115' }] }], usage: { input_tokens: 40, output_tokens: 8, total_tokens: 48 }, debug: 'raw-response-must-not-be-copied' }));
    });
    const adapter = createManagerLlmAdapter({ providerId: 'openai', model: 'gpt-4o-mini', apiKey: 'placeholder-private-key', registry, fetcher });
    const result = await new ManagerAgent(adapter, tools).run({ state: emptySession(session), userText: 'user-prompt-must-not-be-copied-to-meter', onEvent: async (event) => {
      expect((await api(`/${session.id}/events`, 'POST', event)).ok).toBe(true);
    } });
    expect(result.run.status).toBe('completed');
    expect(count).toBe(2);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.state.requestMeters).toHaveLength(2);
    expect(result.state.requestMeters!.map((meter) => meter.actualTotalTokens)).toEqual([24, 48]);
    expect(new Set(result.state.requestMeters!.map((meter) => meter.id)).size).toBe(2);
    const events: HistoryEvent[] = await (await api(`/${session.id}/events`)).json();
    const meterEvents = events.filter((event) => event.type === 'metering');
    expect(meterEvents).toHaveLength(4);
    expect(JSON.stringify(meterEvents)).not.toMatch(/user-prompt-must-not|raw-response-must-not|placeholder-private-key|Authorization|instructions|arguments/);
    expect(meterEvents[1].payload.id).toBe(meterEvents[0].payload.id);
    expect((await api(`/${session.id}/events`, 'POST', meterEvents[1])).status).toBe(200);
    expect(await (await api(`/${session.id}/events`)).json()).toHaveLength(events.length);
    const bad = { ...meterEvents[0], id: 'bad-meter', payload: { ...meterEvents[0].payload, prompt: 'do not persist' } };
    expect((await api(`/${session.id}/events`, 'POST', bad)).status).toBe(400);
    const badPrice = { ...meterEvents[0], id: 'bad-pricing', payload: { ...meterEvents[0].payload, pricing: { currency: 'USD', inputPerMillion: 1, outputPerMillion: 2, source: 'openai-model-page', asOf: '2026-11-10', apiKey: 'placeholder' } } };
    expect((await api(`/${session.id}/events`, 'POST', badPrice)).status).toBe(400);
    const changedIdentity = { ...meterEvents[0], id: 'changed-identity', payload: { ...meterEvents[0].payload, model: 'different-model' } };
    expect((await api(`/${session.id}/events`, 'POST', changedIdentity)).status).toBe(409);
    await stop(); await start();
    expect(await (await api('/legacy/events')).json()).toMatchObject([{ id: 'legacy-event', payload: oldMessage, sequence: 1 }]);
    const restored = restoreHistory(emptySession(session), await (await api(`/${session.id}/events`)).json());
    expect(restored.requestMeters).toEqual(result.state.requestMeters!.map((meter) => JSON.parse(JSON.stringify(meter))));
    expect(buildWeek2Timeline(restored, tools).filter((event) => event.kind === 'metering')).toHaveLength(2);
    expect(restored.requestMeters![0].estimatedRequestCost).toBeGreaterThan(0);
    const tied = structuredClone(restored);
    for (const message of tied.messages) message.createdAt = 100;
    for (const run of tied.runs) { run.startedAt = 100; run.endedAt = 100; }
    for (const tool of tied.toolExecutions) { tool.startedAt = 100; tool.endedAt = 100; }
    for (const meter of tied.requestMeters!) meter.startedAt = 100;
    expect(buildWeek2Timeline(tied, tools).filter((event) => event.kind === 'metering' || event.kind === 'tool').map((event) => event.kind)).toEqual(['metering', 'tool', 'metering']);
    expect(restored.toolExecutions[0].output).toMatchObject({ total: 115 });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(await (await api(`/${other.id}/events`)).json()).toEqual([]);
    const firstMeterIndex = events.findIndex((event) => event.type === 'metering');
    const interrupted = restoreHistory(emptySession(session), events.slice(0, firstMeterIndex + 1));
    expect(interrupted.requestMeters![0].status).toBe('incomplete');
    expect(execute).toHaveBeenCalledTimes(1);
  } finally {
    if (server?.listening) await stop();
    await rm(folder, { recursive: true, force: true });
  }
});
