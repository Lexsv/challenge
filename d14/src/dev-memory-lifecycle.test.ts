import { expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createSessionServer } from '../server/sessions.mjs';
import { createTopicLifecycle } from './topic-lifecycle';
import { createDevManagerMock } from './dev-manager-mock';
import { ManagerAgent } from './manager-agent';
import { HistoryWriter, restoreHistory, type HistoryEvent } from './conversation-history';
import { emptySession } from './week3-session-api';
import { createBuiltInToolRegistry } from './tool-runtime';
import { MemoryProcessor, SessionMemory, type MemorySnapshot } from './session-memory';

it('exposes a recoverable deterministic summary failure', async () => {
  let failing = true;
  const adapter = createDevManagerMock('gpt-4o-mini', async () => failing);
  await expect(adapter.context!.summarize('test')).rejects.toThrow('Synthetic summary failure');
  failing = false;
  await expect(adapter.context!.summarize('test')).resolves.toContain('Synthetic QA summary');
});

it('runs the real Manager, archive, HTTP hook and memory lifecycle with deterministic model responses', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'd11-dev-lifecycle-'));
  const path = join(dir, 'test.sqlite');
  let server: ReturnType<typeof createSessionServer> | undefined;
  let base = '';
  let assessments = 0;
  const start = async () => {
    server = createSessionServer(path, { mockModel: true, topicProcess: async (repo, sessionId, runId) => {
      await createTopicLifecycle(repo, sessionId, async events => { assessments++; return events.flatMap(event => {
        if (event.type !== 'message' || event.payload.role !== 'user' || !event.payload.text.startsWith('QA_TOPIC: ') || event.sequence === undefined) return [];
        const text=event.payload.text; const evidence={messageId:event.payload.id,role:'user' as const,sequence:event.sequence,quote:text,existence:'verified' as const};
        return [{candidate:{key:'Synthetic QA topic',value:'Synthetic decision',status:'confirmed' as const,sources:[event.payload.id],evidence:[evidence],assessment:{support:'unverified' as const,change:'unverified' as const}},assessment:{classification:'fact' as const,factSupported:true,changeConfirmed:false,evidence:[{messageId:event.payload.id,quote:text}]}}];
      }); })([{ id: runId, messages: [] }]);
    } });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw Error('No port');
    base = `http://127.0.0.1:${address.port}/api/week3/sessions`;
  };
  const stop = () => new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
  try {
    await start(); const session = await (await fetch(base, { method: 'POST' })).json();
    const writer = new HistoryWriter(async (event: HistoryEvent) => {
      const response = await fetch(`${base}/${session.id}/events`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(event) });
      if (!response.ok) throw Error('Archive write failed'); return response.json();
    });
    const store = {
      load: async () => await (await fetch(`${base}/${session.id}/memory`)).json() as MemorySnapshot,
      save: async (snapshot: MemorySnapshot) => { const response = await fetch(`${base}/${session.id}/memory`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(snapshot) }); if (!response.ok) throw Error('Memory write failed'); return await response.json() as MemorySnapshot; },
    };
    const adapter = createDevManagerMock('gpt-4o-mini');
    const memory = new SessionMemory(store, new MemoryProcessor(adapter), 'gpt-4o-mini', undefined, async groups => {
      for (const group of groups) { const response = await fetch(`${base}/${session.id}/segments`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId: group.id }) }); if (!response.ok) throw Error('Topic processing failed'); }
    });
    const state = emptySession(session); const manager = new ManagerAgent(adapter, createBuiltInToolRegistry());
    for (let i = 0; i < 9; i++) {
      const result = await manager.run({ state, userText: `${i === 0 ? 'QA_TOPIC: ' : `Message ${i}: `}${'synthetic context '.repeat(80)}`, sessionMemory: memory, onEvent: event => writer.append(event) });
      expect(result.run.status).toBe('completed');
    }
    const snapshot = await store.load(); expect(snapshot.data?.covered.length).toBeGreaterThan(0);
    expect(snapshot.data?.buffer).toHaveLength(0); expect(snapshot.data?.summary).toContain('Synthetic QA summary');
    expect(assessments).toBeGreaterThan(0);
    const events = await (await fetch(`${base}/${session.id}/events`)).json();
    expect(restoreHistory(emptySession(session), events).messages).toHaveLength(18);
    await stop(); await start();
    expect((await store.load()).data?.covered).toEqual(snapshot.data?.covered);
    expect(restoreHistory(emptySession(session), await (await fetch(`${base}/${session.id}/events`)).json()).messages).toHaveLength(18);
    await stop(); const db = new DatabaseSync(path, { readOnly: true });
    try { expect(db.prepare('SELECT COUNT(*) AS count FROM week3_topic_segments WHERE session_id=?').get(session.id)).toMatchObject({ count: assessments });expect(db.prepare('SELECT value FROM week3_topics WHERE session_id=?').get(session.id)).toMatchObject({value:'Synthetic decision'}); }
    finally { db.close(); }
  } finally { if (server?.listening) await stop(); await rm(dir, { recursive: true, force: true }); }
}, 30000);
