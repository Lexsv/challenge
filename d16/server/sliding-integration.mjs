import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionServer } from './sessions.mjs';

test('Sliding Window preserves its full history and settings across restart', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'd10-sliding-'));
  let server;
  const start = async () => {server=createSessionServer(join(folder,'history.sqlite'));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return `http://127.0.0.1:${server.address().port}/api/sessions`;};
  const stop = () => new Promise(resolve=>server.close(resolve));
  const post = (url,body) => fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const patch = (url,body) => fetch(url,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  let base = await start();
  const root = await (await post(base,{})).json();
  const child = await (await post(`${base}/${root.id}/sliding`,{})).json();
  assert.equal((await patch(`${base}/${child.id}`,{recentMessages:2})).status,200);
  assert.equal((await patch(`${base}/${root.id}`,{slidingSelected:1})).status,200);
  for (let i=1;i<=14;i++) {
    if (i % 2 === 1) {
      const runId=`run-${i}`;
      const run={id:runId,conversationId:child.id,agentId:'manager',status:'completed',startedAt:i,endedAt:i+1,messageIds:[],toolExecutionIds:[]};
      assert.equal((await post(`${base}/${child.id}/events`,{id:`run-event-${i}`,sessionId:child.id,type:'run',payload:run})).status,201);
      const meter={id:`meter-${i}`,sessionId:child.id,runId,provider:'openai',model:'test-model',library:'js-tiktoken',startedAt:i,endedAt:i+1,status:'completed',actualInputTokens:100,actualOutputTokens:10,actualTotalTokens:110};
      assert.equal((await post(`${base}/${child.id}/events`,{id:`meter-event-${i}`,sessionId:child.id,type:'metering',payload:meter})).status,201);
    }
    const payload={id:`message-${i}`,conversationId:child.id,runId:`run-${i}`,createdAt:i,role:i%2?'user':'assistant',type:'text',text:`message ${i}`};
    assert.equal((await post(`${base}/${child.id}/events`,{id:`event-${i}`,sessionId:child.id,type:'message',payload})).status,201);
  }
  assert.deepEqual((await (await fetch(base)).json()).map(s=>s.id),[root.id]);
  await stop(); base=await start();
  const restored=(await (await fetch(`${base}/${root.id}/sliding`,{method:'POST'})).json());
  assert.equal(restored.id,child.id); assert.equal(restored.recentMessages,2);
  assert.equal((await (await fetch(base)).json())[0].slidingSelected,1);
  assert.deepEqual((await (await fetch(`${base}/${child.id}/events`)).json()).filter(e=>e.type==='message').map(e=>e.payload.text),Array.from({length:14},(_,i)=>`message ${i+1}`));
  const page = await (await fetch(`${base}/${child.id}/events?limit=3`)).json();
  assert.equal(page.dialogueCount,14);
  const meters = page.accountingEvents.filter(e=>e.type==='metering');
  assert.equal(meters.length,7);
  assert.equal(meters.reduce((sum,e)=>sum+e.payload.actualInputTokens,0),700);
  assert.equal(meters.reduce((sum,e)=>sum+e.payload.actualOutputTokens,0),70);
  assert.deepEqual(await (await fetch(`${base}/${root.id}/events`)).json(),[]);
  await stop();
});
