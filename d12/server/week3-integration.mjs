import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionServer } from './sessions.mjs';

test('Week 3 history and deletion remain isolated from Week 2 after restart',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'d11-week3-'));let server;
  const start=async()=>{server=createSessionServer(join(dir,'test.sqlite'));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return `http://127.0.0.1:${server.address().port}/api`;};
  const stop=()=>new Promise(resolve=>server.close(resolve));
  const post=(url,body)=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  let base=await start();const week2=await(await post(`${base}/sessions`,{})).json();const week3=await(await post(`${base}/week3/sessions`,{})).json();
  const renamed=await fetch(`${base}/week3/sessions/${week3.id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:'Synthetic Week 3'})});assert.equal(renamed.status,200);
  assert.equal((await(await renamed.json()).title),'Synthetic Week 3');
  const payload={id:'w3-message',conversationId:week3.id,runId:'w3-run',createdAt:1,role:'user',type:'text',text:'Synthetic Week 3 message'};
  assert.equal((await post(`${base}/week3/sessions/${week3.id}/events`,{id:'w3-event',sessionId:week3.id,type:'message',payload})).status,201);
  const save=(id,type,payload)=>post(`${base}/week3/sessions/${week3.id}/events`,{id,sessionId:week3.id,type,payload});
  const run={id:'w3-run',conversationId:week3.id,agentId:'manager-agent',status:'completed',startedAt:1,endedAt:8,messageIds:['w3-message'],toolExecutionIds:['w3-tool']};
  assert.equal((await save('run-event','run',run)).status,201);
  const call={id:'w3-tool',runId:'w3-run',toolCallId:'call-1',toolId:'builtin.tax_calculator',status:'running',arguments:{amount:100,taxRate:10},startedAt:2};
  assert.equal((await save('tool-call-event','tool-call',call)).status,201);
  assert.equal((await save('tool-result-event','tool-result',{...call,status:'completed',output:{tax:10,total:110},endedAt:3})).status,201);
  const meter={id:'meter',sessionId:week3.id,runId:'w3-run',provider:'openai',model:'synthetic',library:'js-tiktoken',startedAt:1,endedAt:4,status:'completed',actualInputTokens:100,actualOutputTokens:10,actualTotalTokens:110};
  assert.equal((await save('meter-event','metering',meter)).status,201);
  assert.equal((await fetch(`${base}/sessions/${week3.id}/events`)).status,404);
  assert.equal((await fetch(`${base}/week3/sessions/${week2.id}/events`)).status,404);
  assert.equal((await fetch(`${base}/week3/sessions/${week2.id}`,{method:'DELETE'})).status,404);
  await stop();base=await start();
  const restored=await(await fetch(`${base}/week3/sessions/${week3.id}/events`)).json();
  assert.equal((await(await fetch(`${base}/week3/sessions`)).json())[0].title,'Synthetic Week 3');
  assert.equal(restored[0].payload.text,payload.text);
  assert.equal(restored.find(event=>event.type==='tool-result').payload.output.total,110);
  assert.equal(restored.find(event=>event.type==='metering').payload.actualTotalTokens,110);
  assert.deepEqual((await(await fetch(`${base}/sessions`)).json()).map(row=>row.id),[week2.id]);
  assert.equal((await fetch(`${base}/week3/sessions/${week3.id}`,{method:'DELETE'})).status,200);
  assert.equal((await(await fetch(`${base}/sessions`)).json())[0].id,week2.id);
  await stop();
});

test('Week 3 memory is revision checked, restored, isolated and deleted with its session',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'d11-memory-'));let server;
  const start=async()=>{server=createSessionServer(join(dir,'test.sqlite'));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return `http://127.0.0.1:${server.address().port}/api/week3/sessions`;};
  const stop=()=>new Promise(resolve=>server.close(resolve));
  let base=await start();
  const first=await(await fetch(base,{method:'POST'})).json();const second=await(await fetch(base,{method:'POST'})).json();
  const url=()=>`${base}/${first.id}/memory`;
  const put=body=>fetch(url(),{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const data={summary:'Synthetic decision',facts:[{subject:'Appointment',attribute:'day',value:'Monday',status:'confirmed',sources:['correction'],supersedes:[{value:'Tuesday',status:'confirmed',sources:['original']}]}],covered:['run'],short:[],buffer:[],extracted:['original','correction']};
  assert.equal((await put({revision:0,data})).status,200);assert.equal((await put({revision:0,data})).status,409);
  assert.equal((await(await fetch(`${base}/${second.id}/memory`)).json()).data,null);
  await stop();base=await start();assert.deepEqual((await(await fetch(url())).json()).data,data);
  assert.equal((await fetch(`${base}/${first.id}`,{method:'DELETE'})).status,200);assert.equal((await fetch(url())).status,404);
  assert.equal((await(await fetch(`${base}/${second.id}/memory`)).json()).data,null);await stop();
});

test('Week 3 sessions persist immutable profile associations across restart',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'d12-session-profile-'));let server,base;
  const start=async()=>{server=createSessionServer(join(dir,'test.sqlite'));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${server.address().port}/api`;};
  const stop=()=>new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  const request=(path,method='GET',body)=>fetch(`${base}${path}`,{method,...(body===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});
  try {
    await start();
    let result=await request('/users','POST',{name:'Test profile',habits:'concise'});assert.equal(result.status,201);const profile=await result.json();
    result=await request('/week3/sessions','POST');assert.equal(result.status,201);const legacy=await result.json();assert.equal(legacy.profileId,'general');
    result=await request('/week3/sessions','POST',{});assert.equal(result.status,201);assert.equal((await result.json()).profileId,'general');
    result=await request('/week3/sessions','POST',{profileId:'general'});assert.equal(result.status,201);assert.equal((await result.json()).profileId,'general');
    result=await request('/week3/sessions','POST',{profileId:profile.id});assert.equal(result.status,201);const selected=await result.json();assert.equal(selected.profileId,profile.id);
    assert.equal((await request('/week3/sessions','POST',{profileId:'unknown'})).status,404);
    for(const profileId of [null,'','  general',42])assert.equal((await request('/week3/sessions','POST',{profileId})).status,400);
    assert.equal((await fetch(`${base}/week3/sessions`,{method:'POST',body:'{'})).status,400);
    result=await request(`/week3/sessions/${selected.id}`,'PATCH',{profileId:'general'});assert.equal(result.status,400);
    result=await request(`/week3/sessions/${selected.id}`,'PATCH',{title:'Renamed'});assert.equal(result.status,200);assert.equal((await result.json()).profileId,profile.id);
    result=await request(`/week3/sessions/${selected.id}`);assert.equal(result.status,200);assert.equal((await result.json()).profileId,profile.id);
    result=await request('/week3/sessions');const listed=await result.json();assert.equal(listed.length,4);assert.equal(listed.find(item=>item.id===selected.id).profileId,profile.id);assert.equal(listed.find(item=>item.id===legacy.id).profileId,'general');
    await stop();await start();
    result=await request(`/week3/sessions/${selected.id}`);assert.equal(result.status,200);const restored=await result.json();assert.equal(restored.profileId,profile.id);assert.equal(restored.title,'Renamed');
    result=await request('/week3/sessions');assert.equal((await result.json()).find(item=>item.id===selected.id).profileId,profile.id);
  } finally {if(server?.listening)await stop();}
});
