import { expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionServer } from '../server/sessions.mjs';
import { ManagerAgent } from './manager-agent';
import { HistoryWriter, restoreHistory, type HistoryEvent } from './conversation-history';
import { emptySession } from './week3-session-api';
import { createBuiltInToolRegistry } from './tool-runtime';
import { buildWeek2Timeline } from './week2-agent-tool-lab';
import { MemoryProcessor, SessionMemory, type MemorySnapshot } from './session-memory';

it('saves a real Manager tool run in Week 3 and restores its log without re-execution', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'd11-manager-'));
  let server: ReturnType<typeof createSessionServer> | undefined;
  let base = '';
  const start = async () => {
    server = createSessionServer(join(dir, 'test.sqlite'));
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    base = `http://127.0.0.1:${address.port}/api/week3/sessions`;
  };
  const stop = () => new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
  try {
    await start();
    const session = await (await fetch(base, { method: 'POST' })).json();
    const writer = new HistoryWriter(async (event: HistoryEvent) => {
      const response = await fetch(`${base}/${session.id}/events`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(event) });
      if (!response.ok) throw new Error(`Saving ${event.type} failed: ${response.status} ${await response.text()}`);
      return response.json();
    });
    const tools = createBuiltInToolRegistry();
    const execute = vi.spyOn(tools, 'executeById');
    const provider = { complete: vi.fn().mockResolvedValueOnce({ toolCalls: [{ id: 'tax-call', toolId: 'builtin.tax_calculator', arguments: { amount: 100, taxRate: 15 } }] }).mockResolvedValueOnce({ text: 'The total is 115.' }) };
    const processor=new MemoryProcessor(provider);
    vi.spyOn(processor,'extract').mockImplementation(async (_messages,_meter,source)=>[{subject:'Calculation',attribute:'amount',value:'100',status:'confirmed',sources:[source!]}]);
    const memory=new SessionMemory({
      load:async()=>await(await fetch(`${base}/${session.id}/memory`)).json() as MemorySnapshot,
      save:async snapshot=>{const response=await fetch(`${base}/${session.id}/memory`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(snapshot)});if(!response.ok)throw new Error('Could not save test memory');return await response.json() as MemorySnapshot;},
    },processor,'gpt-4o-mini');
    const state = emptySession(session);
    const result = await new ManagerAgent(provider, tools).run({ state, userText: 'Add 15% tax to 100.', turnIds:{runId:'synthetic-run',messageId:'synthetic-message'}, sessionMemory:memory, onEvent: event => writer.append(event) });
    expect(result.run.status).toBe('completed');
    expect(execute).toHaveBeenCalledTimes(1);
    await stop();
    await start();
    const events = await (await fetch(`${base}/${session.id}/events`)).json();
    const restored = restoreHistory(emptySession(session), events);
    expect(restored.runs[0].id).toBe('synthetic-run');
    expect(restored.messages[0]).toMatchObject({id:'synthetic-message',runId:'synthetic-run',conversationId:session.id});
    expect(events.filter((event:HistoryEvent)=>event.type==='message' && event.payload.role==='user')).toHaveLength(1);
    expect(restored.messages.map(message => message.text)).toEqual(['Add 15% tax to 100.', 'The total is 115.']);
    expect(buildWeek2Timeline(restored, tools).filter(event => event.kind === 'tool')).toMatchObject([{ status: 'completed', output: { total: 115 } }]);
    expect((await memory.facts())[0]).toMatchObject({subject:'Calculation',value:'100',status:'confirmed',sources:[restored.messages[0].id]});
    expect(execute).toHaveBeenCalledTimes(1);
  } finally {
    if (server?.listening) await stop();
    await rm(dir, { recursive: true, force: true });
  }
});
