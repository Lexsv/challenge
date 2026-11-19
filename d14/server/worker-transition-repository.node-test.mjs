import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContextProfileRepository } from './context-profile-repository.mjs';
import { createWeek3Routes } from './week3-sessions.mjs';
import { createWorkerRepository } from './worker-repository.mjs';
import { createWorkerTransitionRepository, workerEventToRow, workerRowToEvent } from './worker-transition-repository.mjs';
import { deriveWorkerReport } from '../src/worker-state-machine.ts';

function setup(db,options={}) {
 db.exec('PRAGMA foreign_keys=ON');createContextProfileRepository(db);createWeek3Routes(db,()=>true);const workers=createWorkerRepository(db);
 const validator=({state,snapshot,answer})=>({result:{stepId:snapshot.document.steps[state.stepIndex].id,visit:state.visit,attempt:state.attempt,outcome:answer==='wrong'?'rejected':'accepted',feedback:'fixture'},validator:{kind:'fixture',version:'1'}});
 return {workers,transitions:createWorkerTransitionRepository(db,{validate:validator,attestFailure:()=>true,...options})};
}
const command=(id,n,type,extra={})=>({sessionId:id,requestId:`request-${n}`,expectedRevision:n,action:{type,...extra}});
function ok(result){assert.equal(result.ok,true,JSON.stringify(result));return result.data;}

test('atomic events survive restart and preserve all lifecycle evidence',()=>{
 const dir=mkdtempSync(join(tmpdir(),'worker-transition-')),path=join(dir,'db.sqlite');let db;
 try{
  db=new DatabaseSync(path);let {workers,transitions}=setup(db);const profile='general';const session=workers.createSession({name:'Test',profileId:profile,templateId:'quiz'}).value;const id=session.id;
  assert.equal(ok(transitions.load(id)).state.status,'not_started');let revision=1;
  const apply=(type,extra={})=>{
   const committed=ok(transitions.apply(command(id,revision++,type,extra)));
   const expected=JSON.stringify(committed);db.close();db=new DatabaseSync(path);({workers,transitions}=setup(db));
   const recovered=ok(transitions.load(id));assert.equal(JSON.stringify(recovered),expected);
   const context={steps:recovered.state.stepIds.map(id=>({id}))};assert.deepEqual(deriveWorkerReport(recovered.state,context),deriveWorkerReport(committed.state,context));
   return recovered;
  };
  apply('start');apply('validate',{answer:'wrong'});apply('retry');apply('validate',{answer:'right'});apply('next');apply('validate',{answer:'wrong'});apply('continue');apply('next');apply('failure',{reason:'offline'});apply('retry');apply('validate',{answer:'right'});apply('back');apply('validate',{answer:'right'});apply('next');apply('validate',{answer:'right'});apply('next');apply('validate',{answer:'right'});apply('next');apply('validate',{answer:'right'});const last=apply('complete');
  assert.equal(last.state.completion,'passed');const before=JSON.stringify(last);db.close();db=new DatabaseSync(path);({transitions}=setup(db));const restored=ok(transitions.load(id));assert.equal(JSON.stringify(restored),before);
  const context={steps:restored.state.stepIds.map(id=>({id}))};assert.deepEqual(deriveWorkerReport(restored.state,context),deriveWorkerReport(last.state,context));
  assert.equal(transitions.apply(command(id,revision,'next')).error,'invalid_transition');assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
 } finally {if(db?.isOpen)db.close();rmSync(dir,{recursive:true,force:true});}
});

test('continue produces completed_with_errors after reopening and continuation',()=>{
 const dir=mkdtempSync(join(tmpdir(),'worker-transition-')),path=join(dir,'db.sqlite');let db;
 try{db=new DatabaseSync(path);let {workers,transitions}=setup(db);const id=workers.createSession({name:'Test',profileId:'general',templateId:'chocolate'}).value.id;let revision=1;
 const run=(type,extra={})=>ok(transitions.apply(command(id,revision++,type,extra)));run('start');run('validate',{answer:'wrong'});run('continue');db.close();db=new DatabaseSync(path);({transitions}=setup(db));assert.equal(ok(transitions.load(id)).state.resolutions[0],'accepted_error');
 for(let i=1;i<5;i++){run('next');run('validate',{answer:'right'});}assert.equal(run('complete').state.completion,'completed_with_errors');
 }finally{if(db?.isOpen)db.close();rmSync(dir,{recursive:true,force:true});}
});

test('failure injection rolls back event and projection at every phase',()=>{
 for(const phase of ['before_projection_verification','before_event_insert','after_event_insert','after_projection_update']){
  const db=new DatabaseSync(':memory:');let active='';const {workers,transitions}=setup(db,{onPhase:value=>{if(value===active)throw Error('injected');}});const id=workers.createSession({name:'Test',profileId:'general',templateId:'quiz'}).value.id;
  active=phase;assert.equal(transitions.apply(command(id,1,'start')).error,'storage_failure');active='';assert.equal(ok(transitions.load(id)).revision,1);assert.equal(db.prepare('SELECT count(*) AS n FROM worker_events WHERE session_id=?').get(id).n,0);db.close();
 }
});

test('a later failed write preserves previously committed history',()=>{
 const db=new DatabaseSync(':memory:');let fail=false;const {workers,transitions}=setup(db,{onPhase:phase=>{if(fail && phase==='after_event_insert')throw Error('injected');}});
 const id=workers.createSession({name:'Test',profileId:'general',templateId:'quiz'}).value.id;const first=ok(transitions.apply(command(id,1,'start')));fail=true;
 assert.equal(transitions.apply(command(id,2,'validate',{answer:'right'})).error,'storage_failure');fail=false;
 assert.deepEqual(ok(transitions.load(id)),first);assert.equal(db.prepare('SELECT count(*) AS n FROM worker_events WHERE session_id=?').get(id).n,1);db.close();
});

test('adapter rejects row identity and corrupted history; projection conflicts fail closed',()=>{
 const db=new DatabaseSync(':memory:');const {workers,transitions}=setup(db);const id=workers.createSession({name:'Test',profileId:'general',templateId:'quiz'}).value.id;
 ok(transitions.apply(command(id,1,'start')));const row=db.prepare('SELECT * FROM worker_events WHERE session_id=?').get(id);const event=ok(workerRowToEvent(row,id));assert.equal(ok(workerEventToRow(event,1)).request_id,'request-1');
 assert.throws(()=>db.prepare('INSERT INTO worker_events VALUES(?,?,?,?,?,?,?)').run(row.session_id,row.sequence,'other',row.action,row.step_index,row.payload,row.created_at));
 for(const changed of [{request_id:'other'},{session_id:'other'},{sequence:2},{action:'invalid'},{step_index:1},{payload:'{}'}])assert.equal(workerRowToEvent({...row,...changed},id).error,'corrupt_events');
 assert.equal(transitions.apply({...command(id,1,'next'),requestId:'stale'}).error,'revision_conflict');assert.equal(transitions.apply({...command(id,2,'start'),requestId:'invalid-start'}).error,'invalid_transition');assert.equal(transitions.apply({...command(id,2,'next'),requestId:'invalid-next'}).error,'invalid_transition');assert.equal(transitions.apply({...command(id,2,'start'),requestId:'invalid-start'}).error,'invalid_transition');
 assert.equal(transitions.apply({...command(id,2,'next'),requestId:'request-1'}).error,'request_id_conflict');
 db.prepare('UPDATE worker_sessions SET step_index=1 WHERE id=?').run(id);assert.equal(transitions.load(id).error,'projection_mismatch');assert.equal(transitions.apply(command(id,2,'next')).error,'projection_mismatch');assert.equal(db.prepare('SELECT count(*) AS n FROM worker_events WHERE session_id=?').get(id).n,1);db.close();
});

test('validation requires trusted dependency and refuses caller-supplied results',()=>{
 const db=new DatabaseSync(':memory:');const {workers}=setup(db);const id=workers.createSession({name:'Test',profileId:'general',templateId:'quiz'}).value.id;const transitions=createWorkerTransitionRepository(db);ok(transitions.apply(command(id,1,'start')));
 assert.equal(transitions.apply(command(id,2,'validate',{answer:'yes'})).error,'trusted_validation_unavailable');assert.equal(transitions.apply(command(id,2,'validate',{answer:'yes',result:{outcome:'accepted'}})).error,'invalid_input');assert.equal(ok(transitions.load(id)).revision,2);db.close();
});

test('corrupted rows and projection states are rejected without repair',()=>{
 for(const corruption of ['missing','version','revision','request','state','payload']){
  const db=new DatabaseSync(':memory:');const {workers,transitions}=setup(db);const id=workers.createSession({name:'Test',profileId:'general',templateId:'quiz'}).value.id;ok(transitions.apply(command(id,1,'start')));ok(transitions.apply(command(id,2,'validate',{answer:'right'})));
  if(corruption==='missing')db.prepare('DELETE FROM worker_events WHERE session_id=? AND sequence=1').run(id);
  if(corruption==='version')db.prepare("UPDATE worker_events SET payload=json_set(payload,'$.schemaVersion',99) WHERE session_id=? AND sequence=1").run(id);
  if(corruption==='revision')db.prepare("UPDATE worker_events SET payload=json_set(payload,'$.expectedRevision',50,'$.resultingRevision',51) WHERE session_id=? AND sequence=1").run(id);
  if(corruption==='request')db.prepare("UPDATE worker_events SET request_id='other' WHERE session_id=? AND sequence=1").run(id);
  if(corruption==='state')db.prepare("UPDATE worker_sessions SET state='bad' WHERE id=?").run(id);
  if(corruption==='payload')db.prepare("UPDATE worker_events SET payload='{}' WHERE session_id=? AND sequence=1").run(id);
  const expected=corruption==='state'?'projection_mismatch':'corrupt_events';assert.equal(transitions.load(id).error,expected);assert.equal(transitions.apply(command(id,3,'next')).error,expected);assert.equal(db.prepare('SELECT revision FROM worker_sessions WHERE id=?').get(id).revision,3);db.close();
 }
});

test('competing connections cannot both commit the same revision',()=>{
 const dir=mkdtempSync(join(tmpdir(),'worker-concurrent-')),path=join(dir,'db.sqlite');let one,two;
 try{one=new DatabaseSync(path);const first=setup(one);const id=first.workers.createSession({name:'Test',profileId:'general',templateId:'quiz'}).value.id;two=new DatabaseSync(path);const second=setup(two);
 one.exec('BEGIN IMMEDIATE');assert.equal(second.transitions.apply({...command(id,1,'start'),requestId:'other'}).error,'storage_failure');one.exec('ROLLBACK');
 assert.equal(first.transitions.apply(command(id,1,'start')).ok,true);assert.equal(second.transitions.apply({...command(id,1,'start'),requestId:'other'}).error,'revision_conflict');assert.equal(one.prepare('SELECT count(*) AS n FROM worker_events WHERE session_id=?').get(id).n,1);
 }finally{if(one?.isOpen)one.close();if(two?.isOpen)two.close();rmSync(dir,{recursive:true,force:true});}
});

test('forbidden validation does not invoke the trusted validator or write',()=>{
 const db=new DatabaseSync(':memory:');let calls=0;const {workers,transitions}=setup(db,{validate:()=>{calls++;throw Error('must not be called');}});
 const id=workers.createSession({name:'Test',profileId:'general',templateId:'quiz'}).value.id;
 const before=JSON.stringify(db.prepare('SELECT * FROM worker_sessions WHERE id=?').get(id));
 assert.equal(transitions.apply(command(id,1,'validate',{answer:'right'})).error,'invalid_transition');
 assert.equal(calls,0);assert.equal(JSON.stringify(db.prepare('SELECT * FROM worker_sessions WHERE id=?').get(id)),before);
 assert.equal(db.prepare('SELECT count(*) AS n FROM worker_events WHERE session_id=?').get(id).n,0);db.close();
});

test('valid unavailable evidence is distinct from malformed evidence and makes no writes',()=>{
 const db=new DatabaseSync(':memory:');let kind='unavailable';let calls=0;
 const {workers,transitions}=setup(db,{validate:({state,snapshot})=>{calls++;return {result:{stepId:kind==='wrong-identity'?'wrong':snapshot.document.steps[state.stepIndex].id,visit:state.visit,attempt:state.attempt,outcome:kind==='wrong-identity'?'unavailable':kind,feedback:'fixture'},validator:{kind:'fixture',version:'1'}};}});
 const id=workers.createSession({name:'Test',profileId:'general',templateId:'quiz'}).value.id;ok(transitions.apply(command(id,1,'start')));
 const before=JSON.stringify(db.prepare('SELECT * FROM worker_sessions WHERE id=?').get(id));const events=JSON.stringify(db.prepare('SELECT * FROM worker_events WHERE session_id=?').all(id));
 assert.equal(transitions.apply(command(id,2,'validate',{answer:'right'})).error,'validation_unavailable');
 assert.equal(JSON.stringify(db.prepare('SELECT * FROM worker_sessions WHERE id=?').get(id)),before);assert.equal(JSON.stringify(db.prepare('SELECT * FROM worker_events WHERE session_id=?').all(id)),events);
 kind='nonsense';assert.equal(transitions.apply(command(id,2,'validate',{answer:'right'})).error,'invalid_input');
 kind='wrong-identity';assert.equal(transitions.apply(command(id,2,'validate',{answer:'right'})).error,'invalid_input');
 assert.equal(JSON.stringify(db.prepare('SELECT * FROM worker_sessions WHERE id=?').get(id)),before);assert.equal(JSON.stringify(db.prepare('SELECT * FROM worker_events WHERE session_id=?').all(id)),events);
 kind='accepted';assert.equal(transitions.apply(command(id,2,'validate',{answer:'right'})).ok,true);assert.equal(calls,4);db.close();
});

test('receipts replay accepted and rejected outcomes without executing again',()=>{
 const db=new DatabaseSync(':memory:');let calls=0;const {workers,transitions}=setup(db,{validate:({state,snapshot})=>{calls++;return {result:{stepId:snapshot.document.steps[state.stepIndex].id,visit:state.visit,attempt:state.attempt,outcome:'accepted',feedback:'ok'},validator:{kind:'test',version:'1'}};}});
 const id=workers.createSession({name:'Test',profileId:'general',templateId:'quiz'}).value.id;
 const start=command(id,1,'start'),started=ok(transitions.apply(start));assert.deepEqual(transitions.apply(start),{ok:true,data:started,replayed:true,historical:true});
 const validateRequest=command(id,2,'validate',{answer:'yes'}),validated=ok(transitions.apply(validateRequest));assert.equal(calls,1);assert.equal(ok(transitions.apply(command(id,3,'next'))).revision,4);
 assert.deepEqual(transitions.apply(validateRequest),{ok:true,data:validated,replayed:true,historical:true});assert.equal(calls,1);
 const rejected={...command(id,4,'next'),requestId:'reject'};assert.equal(transitions.apply(rejected).error,'invalid_transition');assert.deepEqual(transitions.apply(rejected),{ok:false,error:'invalid_transition',replayed:true,historical:true});
 assert.equal(transitions.apply({...rejected,action:{type:'back'}}).error,'request_id_conflict');assert.equal(ok(transitions.load(id)).revision,4);
 assert.equal(ok(transitions.apply({...command(id,4,'back'),requestId:'new-command'})).revision,5);
 assert.deepEqual(transitions.apply(rejected),{ok:false,error:'invalid_transition',replayed:true,historical:true});
 assert.equal(db.prepare('SELECT count(*) AS n FROM worker_events WHERE session_id=?').get(id).n,4);db.close();
});

test('fingerprints are stable across key order; unavailable validation is not cached',()=>{
 const db=new DatabaseSync(':memory:');let available=false,calls=0;const {workers,transitions}=setup(db,{validate:({state,snapshot})=>{calls++;return {result:{stepId:snapshot.document.steps[state.stepIndex].id,visit:state.visit,attempt:state.attempt,outcome:available?'accepted':'unavailable',feedback:'test'},validator:{kind:'test',version:'1'}};}});
 const id=workers.createSession({name:'Test',profileId:'general',templateId:'quiz'}).value.id;const first=command(id,1,'start');ok(transitions.apply(first));
 assert.equal(transitions.apply({action:{type:'start'},expectedRevision:1,requestId:'request-1',sessionId:id}).replayed,true);
 const request=command(id,2,'validate',{answer:'yes'});assert.equal(transitions.apply(request).error,'validation_unavailable');assert.equal(db.prepare('SELECT count(*) AS n FROM worker_command_receipts WHERE request_id=?').get('request-2').n,0);available=true;assert.equal(transitions.apply(request).ok,true);assert.equal(calls,2);db.close();
});

test('receipt insertion failures roll back event, projection and receipt',()=>{
 for(const point of ['before_receipt_insert','after_event_insert','after_projection_update','after_receipt_insert']){
  const db=new DatabaseSync(':memory:');let active=point;const {workers,transitions}=setup(db,{onPhase:phase=>{if(phase===active)throw Error('fixture');}});const id=workers.createSession({name:'Test',profileId:'general',templateId:'quiz'}).value.id;
  assert.equal(transitions.apply(command(id,1,'start')).error,'storage_failure');active='';assert.equal(ok(transitions.load(id)).revision,1);assert.equal(db.prepare('SELECT count(*) AS n FROM worker_events').get().n,0);assert.equal(db.prepare('SELECT count(*) AS n FROM worker_command_receipts').get().n,0);db.close();
 }
});

test('legacy events without receipts fail closed without inventing an outcome',()=>{
 const db=new DatabaseSync(':memory:');const {workers,transitions}=setup(db);const id=workers.createSession({name:'Test',profileId:'general',templateId:'quiz'}).value.id;const request=command(id,1,'start');ok(transitions.apply(request));db.prepare('DELETE FROM worker_command_receipts WHERE session_id=?').run(id);
 assert.equal(transitions.apply(request).error,'legacy_outcome_unavailable');assert.equal(ok(transitions.load(id)).revision,2);assert.equal(db.prepare('SELECT count(*) AS n FROM worker_events').get().n,1);db.close();
});

test('receipt data survives reopening and concurrent connections see the original outcome',()=>{
 const dir=mkdtempSync(join(tmpdir(),'worker-receipt-')),path=join(dir,'db.sqlite');let first,second;
 try{first=new DatabaseSync(path);let {workers,transitions}=setup(first);const id=workers.createSession({name:'Test',profileId:'general',templateId:'quiz'}).value.id;const request=command(id,1,'start');const original=ok(transitions.apply(request));
 second=new DatabaseSync(path);let other=setup(second).transitions;assert.deepEqual(other.apply(request),{ok:true,data:original,replayed:true,historical:true});assert.equal(other.apply({...request,action:{type:'next'}}).error,'request_id_conflict');
 first.close();first=new DatabaseSync(path);({transitions}=setup(first));assert.deepEqual(transitions.apply(request),{ok:true,data:original,replayed:true,historical:true});
 }finally{if(first?.isOpen)first.close();if(second?.isOpen)second.close();rmSync(dir,{recursive:true,force:true});}
});

test('ambiguous commit is reconciled by the identical request',()=>{
 const real=new DatabaseSync(':memory:');let uncertain=false;
 const db=new Proxy(real,{get(target,key){if(key==='exec')return sql=>{const value=target.exec(sql);if(uncertain && sql==='COMMIT'){uncertain=false;throw Error('response lost');}return value;};const value=target[key];return typeof value==='function'?value.bind(target):value;}});
 const {workers,transitions}=setup(db);const id=workers.createSession({name:'Test',profileId:'general',templateId:'quiz'}).value.id;const request=command(id,1,'start');uncertain=true;
 assert.equal(transitions.apply(request).error,'unknown_outcome');const replay=transitions.apply(request);assert.equal(replay.ok,true);assert.equal(replay.replayed,true);assert.equal(real.prepare('SELECT count(*) AS n FROM worker_events').get().n,1);real.close();
});

test('corrupt receipt and receipt read failures fail closed',()=>{
 const db=new DatabaseSync(':memory:');let phase='';const {workers,transitions}=setup(db,{onPhase:value=>{if(phase===value)throw Error('injected');}});const id=workers.createSession({name:'Test',profileId:'general',templateId:'quiz'}).value.id;const request=command(id,1,'start');ok(transitions.apply(request));
 phase='before_receipt_lookup';assert.equal(transitions.apply(request).error,'storage_failure');phase='before_receipt_decode';assert.equal(transitions.apply(request).error,'storage_failure');phase='';db.prepare("UPDATE worker_command_receipts SET response='{}' WHERE session_id=?").run(id);assert.equal(transitions.apply(request).error,'integrity_failure');assert.equal(db.prepare('SELECT count(*) AS n FROM worker_events').get().n,1);db.close();
});

test('simultaneous connections serialize duplicate, conflicting and competing requests',async()=>{
 const {Worker}=await import('node:worker_threads');const dir=mkdtempSync(join(tmpdir(),'worker-race-')),path=join(dir,'db.sqlite');let db;
 const moduleUrl=new URL('./worker-transition-repository.mjs',import.meta.url).href;
 const code=`const {parentPort,workerData}=require('node:worker_threads');(async()=>{const {DatabaseSync}=await import('node:sqlite');const {createWorkerTransitionRepository}=await import(workerData.moduleUrl);const db=new DatabaseSync(workerData.path);db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');const repository=createWorkerTransitionRepository(db);parentPort.postMessage('ready');Atomics.wait(new Int32Array(workerData.barrier),0,0);const result=repository.apply(workerData.request);parentPort.postMessage(result);db.close();})().catch(e=>{parentPort.postMessage({fatal:String(e)});});`;
 try{
  db=new DatabaseSync(path);const {workers}=setup(db);
  for(const variant of ['same','conflict','revision']){
   const id=workers.createSession({name:variant,profileId:'general',templateId:'quiz'}).value.id;const first=command(id,1,'start');const second=variant==='same'?first:variant==='conflict'?{...first,action:{type:'next'}}:{...first,requestId:'different'};
   const barrier=new SharedArrayBuffer(4);const start=request=>new Worker(code,{eval:true,workerData:{moduleUrl,path,request,barrier}});const a=start(first),b=start(second);
   const ready=w=>new Promise((resolve,reject)=>{w.once('error',reject);w.once('message',value=>value==='ready'?resolve():reject(Error('worker startup failed')));});await Promise.all([ready(a),ready(b)]);
   const result=w=>new Promise((resolve,reject)=>{w.once('error',reject);w.once('message',resolve);});const results=Promise.all([result(a),result(b)]);Atomics.store(new Int32Array(barrier),0,1);Atomics.notify(new Int32Array(barrier),0,2);const values=await results;
   if(variant==='conflict') {
    assert.equal(values.filter(value=>value.error==='request_id_conflict').length,1);
    assert.equal(values.filter(value=>value.ok || value.error==='invalid_transition').length,1);
   } else {
    assert.equal(values.filter(value=>value.ok && !value.replayed).length,1);
    if(variant==='same')assert.equal(values.filter(value=>value.ok && value.replayed).length,1);
    else assert.equal(values.filter(value=>value.error==='revision_conflict').length,1);
   }
   assert.equal(db.prepare('SELECT count(*) AS n FROM worker_events WHERE session_id=?').get(id).n,values.some(value=>value.ok)?1:0);await Promise.all([a.terminate(),b.terminate()]);
  }
 } finally {if(db?.isOpen)db.close();rmSync(dir,{recursive:true,force:true});}
});

test('profile deletion and General clearing remove only owned receipts',()=>{
 const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');const profiles=createContextProfileRepository(db);createWeek3Routes(db,()=>true);const workers=createWorkerRepository(db);const transitions=createWorkerTransitionRepository(db);const alice=profiles.create('Alice',''),bob=profiles.create('Bob','');
 const create=profileId=>workers.createSession({name:'Worker',profileId,templateId:'quiz'}).value.id;const a=create(alice.id),b=create(bob.id),g=create('general');for(const id of [a,b,g])ok(transitions.apply(command(id,1,'start')));
 profiles.deleteWithSessions(alice.id);assert.equal(db.prepare('SELECT count(*) AS n FROM worker_command_receipts WHERE session_id=?').get(a).n,0);assert.equal(db.prepare('SELECT count(*) AS n FROM worker_command_receipts WHERE session_id=?').get(b).n,1);
 profiles.clearGeneralSessions();assert.equal(db.prepare('SELECT count(*) AS n FROM worker_command_receipts WHERE session_id=?').get(g).n,0);assert.ok(workers.getSession(b));assert.ok(workers.getTemplate('quiz'));assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);db.close();
});

test('accepted receipt is independently bound to the authoritative event command',async()=>{
 const {createHash}=await import('node:crypto');const db=new DatabaseSync(':memory:');let calls=0;
 const {workers,transitions}=setup(db,{validate:({state,snapshot})=>{calls++;return {result:{stepId:snapshot.document.steps[state.stepIndex].id,visit:state.visit,attempt:state.attempt,outcome:'accepted',feedback:'ok'},validator:{kind:'test',version:'1'}};}});
 const id=workers.createSession({name:'Test',profileId:'general',templateId:'quiz'}).value.id;
 ok(transitions.apply(command(id,1,'start')));const original={...command(id,2,'validate',{answer:'right'}),requestId:'accepted-answer'};const accepted=ok(transitions.apply(original));ok(transitions.apply(command(id,3,'next')));
 assert.deepEqual(transitions.apply(original),{ok:true,data:accepted,replayed:true,historical:true});
 assert.equal(transitions.apply({...original,action:{type:'validate',answer:'wrong'}}).error,'request_id_conflict');
 assert.equal(transitions.apply({...original,expectedRevision:3}).error,'request_id_conflict');
 const fingerprint=createHash('sha256').update(JSON.stringify([1,id,2,'validate','wrong'])).digest('hex');
 db.prepare('UPDATE worker_command_receipts SET fingerprint=? WHERE session_id=? AND request_id=?').run(fingerprint,id,original.requestId);
 const before=JSON.stringify({session:db.prepare('SELECT * FROM worker_sessions WHERE id=?').get(id),events:db.prepare('SELECT * FROM worker_events WHERE session_id=? ORDER BY sequence').all(id),receipt:db.prepare('SELECT * FROM worker_command_receipts WHERE session_id=? AND request_id=?').get(id,original.requestId)});
 assert.equal(transitions.apply({...original,action:{type:'validate',answer:'wrong'}}).error,'integrity_failure');assert.equal(transitions.apply(original).error,'integrity_failure');
 assert.equal(JSON.stringify({session:db.prepare('SELECT * FROM worker_sessions WHERE id=?').get(id),events:db.prepare('SELECT * FROM worker_events WHERE session_id=? ORDER BY sequence').all(id),receipt:db.prepare('SELECT * FROM worker_command_receipts WHERE session_id=? AND request_id=?').get(id,original.requestId)}),before);assert.equal(calls,1);db.close();
});

test('accepted and rejected receipt corruption cannot replay a false success',()=>{
 for(const corruption of ['response','action','request','rejected-response']){
  const db=new DatabaseSync(':memory:');const {workers,transitions}=setup(db);const id=workers.createSession({name:'Test',profileId:'general',templateId:'quiz'}).value.id;const request=command(id,1,'start');ok(transitions.apply(request));
  if(corruption==='response')db.prepare("UPDATE worker_command_receipts SET response=json_set(response,'$.data.revision',999) WHERE session_id=? AND request_id=?").run(id,request.requestId);
  if(corruption==='action')db.prepare("UPDATE worker_command_receipts SET action='next' WHERE session_id=? AND request_id=?").run(id,request.requestId);
  if(corruption==='request')db.prepare("UPDATE worker_command_receipts SET request_id='other' WHERE session_id=? AND request_id=?").run(id,request.requestId);
  if(corruption==='rejected-response')db.prepare("UPDATE worker_command_receipts SET outcome='rejected',response='{\"ok\":true,\"data\":{}}' WHERE session_id=? AND request_id=?").run(id,request.requestId);
  const before=JSON.stringify(db.prepare('SELECT * FROM worker_sessions WHERE id=?').get(id));const next=corruption==='request'?{...request,requestId:'other'}:request;
  assert.equal(transitions.apply(next).error,'integrity_failure');assert.equal(JSON.stringify(db.prepare('SELECT * FROM worker_sessions WHERE id=?').get(id)),before);assert.equal(db.prepare('SELECT count(*) AS n FROM worker_events WHERE session_id=?').get(id).n,1);db.close();
 }
});
