import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createSessionServer } from './sessions.mjs';
import { createWorkerTransitionRepository } from './worker-transition-repository.mjs';
import { createWorkerRoutes } from './worker-routes.mjs';
import { createServer, request as httpRequest } from 'node:http';

test('Worker action HTTP validates, deduplicates, recovers and preserves existing APIs',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'d13-actions-'));const path=join(dir,'test.sqlite');let server;let inject=false;
 try{
  server=createSessionServer(path,{workerTransitionOptions:{onPhase:phase=>{if(inject && phase==='after_event_insert')throw Error('private');}}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
  const call=async(path,body,options={})=>{const response=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',...options.headers},body:typeof body==='string'?body:JSON.stringify(body)});return {status:response.status,body:await response.json()};};
  const created=await call('/api/worker-sessions',{name:'HTTP',profileId:'general',templateId:'quiz'});assert.equal(created.status,201);const id=created.body.id,url=`/api/worker-sessions/${id}/actions`;
  const status=async()=>{const response=await fetch(`${base}/api/worker-sessions/${id}/status`);assert.equal(response.status,200);return response.json();};
  assert.deepEqual((await status()).availableActions,['start']);
  const command=(requestId,expectedRevision,action,payload={})=>({requestId,expectedRevision,action,payload});
  for(const input of [{},command('bad',0,'start'),command('bad',1,'validate'),command('bad',1,'failure',{outcome:'accepted'}),command('bad',1,'start',{state:'completed'}),{...command('bad',1,'start'),state:'completed'},command('bad!',1,'start')])assert.equal((await call(url,input)).status,400);
  assert.equal((await call(url,'{')).status,400);assert.equal((await call(url,'x'.repeat(4100))).status,413);
  assert.equal((await call('/api/worker-sessions/missing/actions',command('missing',1,'start'))).status,404);
  assert.equal((await call('/api/worker-sessions/bad_id/actions',command('missing',1,'start'))).status,400);
  inject=true;const fail=await call(url,command('failure',1,'start'));assert.equal(fail.status,500);assert.equal(fail.body.code,'storage_failure');assert.equal(JSON.stringify(fail).includes('private'),false);inject=false;
  const first=await call(url,command('start-id',1,'start'));assert.equal(first.status,200);assert.equal(first.body.result.state,'in_progress');assert.equal(first.body.result.revision,2);assert.equal(first.body.replayed,false);
  assert.deepEqual((await status()).availableActions,[]);assert.equal((await status()).resolvedSteps,0);
  const replay=await call(url,command('start-id',1,'start'));assert.equal(replay.status,200);assert.equal(replay.body.replayed,true);assert.equal(replay.body.historical,true);assert.deepEqual(replay.body.result,first.body.result);
  assert.equal((await call(url,command('start-id',1,'next'))).body.code,'request_id_conflict');
  const forbidden=await call(url,command('bad-next',2,'next'));assert.equal(forbidden.status,409);assert.equal(forbidden.body.code,'invalid_transition');assert.equal((await call(url,command('bad-next',2,'next'))).body.replayed,true);
  assert.equal((await call(url,command('duplicate-start',2,'start'))).body.code,'invalid_transition');assert.equal((await call(url,command('complete',2,'complete'))).body.code,'invalid_transition');assert.equal((await call(url,command('stale',1,'next'))).body.code,'revision_conflict');
  const row=await fetch(`${base}/api/worker-sessions/${id}`);assert.equal((await row.json()).state,'in_progress');const events=await (await fetch(`${base}/api/worker-sessions/${id}/events`)).json();assert.equal(events.length,1);
  const db=new DatabaseSync(path);try{
   db.exec('PRAGMA foreign_keys=ON');const trusted=createWorkerTransitionRepository(db,{validate:({state,snapshot})=>({result:{stepId:snapshot.document.steps[state.stepIndex].id,visit:state.visit,attempt:state.attempt,outcome:'accepted',feedback:'fixture'},validator:{kind:'fixture',version:'1'}})});
   assert.equal(trusted.apply({sessionId:id,requestId:'trusted',expectedRevision:2,action:{type:'validate',answer:'fixture'}}).ok,true);
   assert.deepEqual((await status()).availableActions,['next']);assert.equal((await status()).resolvedSteps,1);
   const advanced=await call(url,command('advance',3,'next'));assert.equal(advanced.status,200);assert.equal(advanced.body.result.revision,4);
   assert.deepEqual((await status()).availableActions,['back']);assert.equal((await status()).resolvedSteps,1);
   const historical=await call(url,command('start-id',1,'start'));assert.equal(historical.body.historical,true);assert.equal(historical.body.result.revision,2);
   assert.equal((await (await fetch(`${base}/api/worker-sessions/${id}`)).json()).revision,4);
   db.prepare("UPDATE worker_command_receipts SET fingerprint=? WHERE session_id=? AND request_id='start-id'").run('0'.repeat(64),id);const corrupt=await call(url,command('start-id',1,'start'));assert.equal(corrupt.body.code,'integrity_failure');assert.equal(corrupt.status,409);
   db.prepare("DELETE FROM worker_command_receipts WHERE session_id=? AND request_id='advance'").run(id);const legacy=await call(url,command('advance',3,'next'));assert.equal(legacy.body.code,'legacy_outcome_unavailable');assert.equal(legacy.status,409);
   const another=await call('/api/worker-sessions',{name:'Status lifecycle',profileId:'general',templateId:'quiz'});const sid=another.body.id;
   const query=async()=>await (await fetch(`${base}/api/worker-sessions/${sid}/status`)).json();
   const apply=(requestId,revision,action)=>trusted.apply({sessionId:sid,requestId,expectedRevision:revision,action});
   const rejected=createWorkerTransitionRepository(db,{validate:({state,snapshot})=>({result:{stepId:snapshot.document.steps[state.stepIndex].id,visit:state.visit,attempt:state.attempt,outcome:'rejected',feedback:'fixture'},validator:{kind:'fixture',version:'1'}})});
   assert.equal(apply('start-two',1,{type:'start'}).ok,true);
   assert.equal(rejected.apply({sessionId:sid,requestId:'reject',expectedRevision:2,action:{type:'validate',answer:'fixture'}}).ok,true);
   assert.deepEqual((await query()).availableActions,['retry','continue']);
   assert.equal(apply('continue',3,{type:'continue'}).ok,true);assert.equal((await query()).resolvedSteps,1);
   assert.equal(apply('next-one',4,{type:'next'}).ok,true);
   let revision=5;
   for(let index=1;index<5;index++){
     assert.equal(apply(`validate-${index}`,revision++,{type:'validate',answer:'fixture'}).ok,true);
     if(index<4) assert.equal(apply(`next-${index}`,revision++,{type:'next'}).ok,true);
   }
   const final=await query();assert.equal(final.resolvedSteps,5);assert.deepEqual(final.availableActions,['back','complete']);
   assert.equal(apply('finish',revision,{type:'complete'}).ok,true);
   const complete=await query();assert.deepEqual(complete.availableActions,[]);assert.equal(complete.completion,'completed_with_errors');
   db.prepare('UPDATE worker_sessions SET step_index=0 WHERE id=?').run(sid);
   const broken=await fetch(`${base}/api/worker-sessions/${sid}/status`);assert.equal(broken.status,409);assert.equal((await broken.json()).code,'projection_mismatch');
  }finally{db.close();}
  assert.equal((await fetch(`${base}/api/users`)).status,200);assert.equal((await fetch(`${base}/api/week3/sessions`)).status,200);assert.equal((await fetch(`${base}/api/worker-templates`)).status,200);
  assert.equal((await call(url,command('host',2,'next'),{headers:{Origin:'http://example.com'}})).status,403);
  const hostStatus=await new Promise((resolve,reject)=>{const request=httpRequest(base+url,{method:'POST',headers:{Host:'example.com'}},response=>{response.resume();resolve(response.statusCode);});request.on('error',reject);request.end();});assert.equal(hostStatus,403);
 }finally{if(server?.listening)await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});}
});

test('HTTP maps uncertain and unavailable outcomes without exposing internals',async()=>{
 let code='unknown_outcome';const route=createWorkerRoutes({}, {apply:()=>({ok:false,error:code})});
 const server=createServer((req,res)=>{void route(req,new URL(req.url,'http://localhost').pathname,(status,body)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(body));});});
 try{await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${server.address().port}/api/worker-sessions/test/actions`;
  for(const value of ['unknown_outcome','validation_unavailable']){code=value;const response=await fetch(url,{method:'POST',body:JSON.stringify({requestId:'request',expectedRevision:1,action:'start',payload:{}})});assert.equal(response.status,503);assert.equal((await response.json()).code,value);}
 }finally{if(server.listening)await new Promise(resolve=>server.close(resolve));}
});

test('simultaneous identical HTTP actions commit only once',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'d13-actions-race-'));let server;try{server=createSessionServer(join(dir,'test.sqlite'));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
 const post=(path,body)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const session=await (await post('/api/worker-sessions',{name:'Race',profileId:'general',templateId:'quiz'})).json();const cmd={requestId:'race',expectedRevision:1,action:'start',payload:{}};
 const result=await Promise.all([post(`/api/worker-sessions/${session.id}/actions`,cmd),post(`/api/worker-sessions/${session.id}/actions`,cmd)]);const payload=await Promise.all(result.map(x=>x.json()));assert.deepEqual(result.map(x=>x.status),[200,200]);assert.equal(payload.filter(x=>x.replayed).length,1);assert.equal((await (await fetch(`${base}/api/worker-sessions/${session.id}/events`)).json()).length,1);
 const competing=await (await post('/api/worker-sessions',{name:'Competing',profileId:'general',templateId:'quiz'})).json();const pair=await Promise.all([post(`/api/worker-sessions/${competing.id}/actions`,{...cmd,requestId:'first'}),post(`/api/worker-sessions/${competing.id}/actions`,{...cmd,requestId:'second'})]);assert.deepEqual(pair.map(x=>x.status).sort(),[200,409]);const bodies=await Promise.all(pair.map(x=>x.json()));assert.equal(bodies.filter(x=>x.code==='revision_conflict').length,1);
 }finally{if(server?.listening)await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});}
});
