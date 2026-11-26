import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createSessionServer } from './sessions.mjs';
import { createSavedProviderTransport } from './credentials.mjs';
import { serverClock, serverTimePath } from '../src/server-time-context.ts';

test('browser clock endpoint uses the backend timezone and forbids caching', async t => {
  const server = createSessionServer(':memory:');
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const start = Date.now();
  const response = await fetch(`http://127.0.0.1:${server.address().port}${serverTimePath}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const { localDateTime, timeZone } = await response.json();
  assert.equal(timeZone, Intl.DateTimeFormat().resolvedOptions().timeZone);
  assert.ok(Date.parse(localDateTime) >= start - 999 && Date.parse(localDateTime) <= Date.now());
});

for (const provider of ['openai', 'opencode-console', 'opencode-go']) {
  test(`${provider} samples the server at dispatch including after a tool result crosses midnight`, async () => {
    const times = ['2026-11-25T04:59:59Z', '2026-11-25T05:00:00Z'];
    const bodies = [];
    const transport = createSavedProviderTransport({status: async () => true, read: async () => 'fixture-only'},
      async (_url, init) => { bodies.push(JSON.parse(init.body)); return Response.json({}); }, undefined,
      () => serverClock(new Date(times.shift()), 'America/Toronto'));
    const isResponses = provider === 'openai';
    const input = [{ role: 'system', content: 'Use the attached tools.' }, { role: 'user', content: 'Remind me in one minute.' }];
    const continuation = isResponses ? { type: 'function_call_output', call_id: 'r1', output: 'scheduled' }
      : { role: 'tool', tool_call_id: 'r1', content: 'scheduled' };
    for (const messages of [input, [...input, continuation]]) {
      const result = await transport(provider, { model: 'fixture-model', ...(isResponses ? {input: messages} : {messages}) });
      assert.equal(result.status, 200);
    }
    for (const [i, expected] of ['2026-11-24T23:59:59-05:00', '2026-11-25T00:00:00-05:00'].entries()) {
      const { instructions, messages } = bodies[i];
      const prompt = isResponses ? instructions : messages[0].content;
      assert.ok(prompt.includes(expected + ' [America/Toronto]'));
      assert.equal(JSON.stringify(bodies[i]).match(/Current server time:/g).length, 1);
    }
    assert.deepEqual((bodies[1].input ?? bodies[1].messages).at(-1), continuation);
    assert.equal(input[0].content, 'Use the attached tools.');
  });
}
