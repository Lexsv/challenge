import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionServer } from './sessions.mjs';

test('two sessions and rename survive backend restart and fresh list load', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'd7-sessions-'));
  let server;
  async function start() {
    server = createSessionServer(join(folder, 'sessions.sqlite'));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${server.address().port}/api/sessions`;
  }
  async function stop() { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  try {
    let url = await start();
    assert.deepEqual(await (await fetch(url)).json(), []);
    const first = await (await fetch(url, { method: 'POST' })).json();
    const second = await (await fetch(url, { method: 'POST' })).json();
    assert.notEqual(first.id, second.id);
    assert.equal(first.title, 'New session');
    const renamed = await (await fetch(`${url}/${first.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Planning' }) })).json();
    assert.equal(renamed.id, first.id);
    assert.equal(renamed.createdAt, first.createdAt);
    assert.equal(renamed.title, 'Planning');
    const invalid = await fetch(`${url}/${first.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: ' ' }) });
    assert.equal(invalid.status, 400);
    const crossOrigin = await fetch(url, { method: 'POST', headers: { Origin: 'https://example.com' } });
    assert.equal(crossOrigin.status, 403);
    assert.equal((await fetch(`${url}/missing`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Missing' }) })).status, 404);
    for (const [session, limit] of [[renamed, 1000], [second, 0]]) {
      const saved = await (await fetch(`${url}/${session.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestTokenLimit: limit }) })).json();
      assert.equal(saved.requestTokenLimit, limit);
      session.requestTokenLimit = limit;
    }
    for (const value of [-1, 1.5, '1000', null]) {
      assert.equal((await fetch(`${url}/${first.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({requestTokenLimit:value}) })).status,400);
    }
    for (const setting of [{contextStrategy:'key-facts'}, {recentMessages:7}, {contextStrategy:'token-budget'}]) {
      const response = await fetch(`${url}/${first.id}`, { method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify(setting) });
      assert.equal(response.status, 200);
      Object.assign(renamed, await response.json());
    }
    for (const recentMessages of [0, -1, 1.5, '10']) {
      assert.equal((await fetch(`${url}/${first.id}`, {method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({recentMessages})})).status, 400);
    }
    const message = {id:'message-1',sessionId:first.id,type:'message',payload:{id:'m1',conversationId:first.id,runId:'r1',createdAt:1,role:'user',type:'text',text:'Original dialogue'}};
    assert.equal((await fetch(`${url}/${first.id}/events`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(message)})).status,201);
    const facts = {facts:[{subject:'Project',attribute:'budget',value:'$100'}],coveredMessageId:'m1',expectedCoveredMessageId:null};
    const put = () => fetch(`${url}/${first.id}/facts`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(facts)});
    assert.equal((await put()).status,200);
    assert.equal((await put()).status,409);
    await stop();
    url = await start();
    assert.deepEqual(await (await fetch(`${url}/${first.id}/facts`)).json(),{facts:facts.facts,coveredMessageId:'m1'});
    assert.equal((await (await fetch(`${url}/${first.id}/events`)).json())[0].payload.text,'Original dialogue');
    const restored = await (await fetch(url)).json();
    assert.deepEqual(restored.map(({updatedAt, ...item}) => item), [renamed, second]);
    assert.ok(restored[0].updatedAt >= restored[0].createdAt);
    assert.deepEqual(Object.keys(restored[0]).sort(), ['contextStrategy', 'createdAt', 'id', 'recentMessages', 'requestTokenLimit', 'title', 'updatedAt']);
  } finally {
    if (server?.listening) await stop();
    await rm(folder, { recursive: true, force: true });
  }
});
