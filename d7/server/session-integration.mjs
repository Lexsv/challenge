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
    await stop();
    url = await start();
    const restored = await (await fetch(url)).json();
    assert.deepEqual(restored, [renamed, second]);
    assert.deepEqual(Object.keys(restored[0]).sort(), ['createdAt', 'id', 'title']);
  } finally {
    if (server?.listening) await stop();
    await rm(folder, { recursive: true, force: true });
  }
});
