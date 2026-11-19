import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createContextProfileRepository } from './context-profile-repository.mjs';
import { createWeek3Routes } from './week3-sessions.mjs';
import { createWorkerRepository } from './worker-repository.mjs';
import { createWorkerTransitionRepository } from './worker-transition-repository.mjs';

test('V2 actions persist and replay using existing events and receipts',()=>{
 const db=new DatabaseSync(':memory:');try{
  db.exec('PRAGMA foreign_keys=ON');createContextProfileRepository(db);createWeek3Routes(db,()=>true);
  const workers=createWorkerRepository(db),repo=createWorkerTransitionRepository(db);
  const created=workers.createSession({name:'Test V2',profileId:'general',templateId:'quiz-v2'});assert.ok(created.value);const id=created.value.id;
  const command=(requestId,revision,action)=>({sessionId:id,requestId,expectedRevision:revision,action});
  const start=command('start',1,{type:'start'});assert.equal(repo.apply(start).ok,true);assert.equal(repo.apply(start).replayed,true);
  assert.equal(repo.apply(command('forbidden',2,{type:'next'})).error,'invalid_transition');
  let revision=2;
  for(let i=0;i<5;i++){
   const s=repo.apply(command(`submit-${i}`,revision++,{type:'submit',result:{type:'question',optionId:'option-1'}}));assert.equal(s.ok,true,JSON.stringify(s));
   if(i<4)assert.equal(repo.apply(command(`next-${i}`,revision++,{type:'next'})).ok,true);
  }
  const request=command('eval',revision,{type:'evaluate'}),prepared=repo.prepareV2Evaluation(request);assert.equal(prepared.ok,true);assert.equal(prepared.prepared,true);
  const {binding,state}=prepared.data;
  const evaluation={schemaVersion:1,sessionId:id,sourceRevision:revision,evidence:binding.evidence,success:true,reason:'All complete.',errorCount:0,findings:state.results.map(result=>({stepId:result.stepId,passed:true,reason:'Accepted',evidence:'option-1'}))};
  assert.equal(repo.commitV2Evaluation(request,evaluation).ok,true);
  assert.equal(repo.prepareV2Evaluation(request).replayed,true);
  assert.equal(repo.apply(command('finish',++revision,{type:'complete'})).ok,true);
  assert.equal(repo.load(id).data.state.completion,'passed');
 }finally{db.close();}
});

test('V2 event, projection and receipt roll back together on failures',()=>{
 for(const phase of ['before_event_insert','after_event_insert','after_projection_update','before_receipt_insert','after_receipt_insert']){
  const db=new DatabaseSync(':memory:');try{
   db.exec('PRAGMA foreign_keys=ON');createContextProfileRepository(db);createWeek3Routes(db,()=>true);const workers=createWorkerRepository(db), id=workers.createSession({name:'Rollback',profileId:'general',templateId:'quiz-v2'}).value.id;
   const repo=createWorkerTransitionRepository(db,{onPhase:value=>{if(value===phase)throw Error('injected');}});
   assert.equal(repo.apply({sessionId:id,requestId:'r',expectedRevision:1,action:{type:'start'}}).error,'storage_failure');
   assert.equal(workers.events(id).length,0);assert.equal(workers.getSession(id).revision,1);assert.equal(db.prepare('SELECT COUNT(*) AS count FROM worker_command_receipts WHERE session_id=?').get(id).count,0);
  }finally{db.close();}
 }
});

test('V2 template edits preserve existing snapshots and seed initialization is idempotent',()=>{
 const db=new DatabaseSync(':memory:');try{
  db.exec('PRAGMA foreign_keys=ON');createContextProfileRepository(db);createWeek3Routes(db,()=>true);let workers=createWorkerRepository(db);
  const original=workers.getTemplate('quiz-v2'),session=workers.createSession({name:'Snapshot',profileId:'general',templateId:'quiz-v2'}).value;
  const update={name:original.name,description:'Changed',rules:original.rules,document:original.document,expectedVersion:original.version};
  assert.equal(workers.updateTemplate('quiz-v2',update).value.version,original.version+1);
  assert.equal(workers.updateTemplate('quiz-v2',update).error,'conflict');
  assert.deepEqual(workers.getSession(session.id).templateSnapshot,original);
  assert.equal(workers.deleteTemplate('quiz-v2').value,true);workers=createWorkerRepository(db);
  assert.equal(workers.getTemplate('quiz-v2'),null);assert.deepEqual(workers.getSession(session.id).templateSnapshot,original);
 }finally{db.close();}
});

test('V2 corrupted stored criteria cannot be used for transitions',()=>{
 const db=new DatabaseSync(':memory:');try{
  db.exec('PRAGMA foreign_keys=ON');createContextProfileRepository(db);createWeek3Routes(db,()=>true);const workers=createWorkerRepository(db),repo=createWorkerTransitionRepository(db);
  const session=workers.createSession({name:'Corrupt',profileId:'general',templateId:'quiz-v2'}).value, snapshot=structuredClone(session.templateSnapshot);delete snapshot.document.steps[0].evaluation;
  db.exec('DROP TRIGGER worker_session_immutable');db.prepare('UPDATE worker_sessions SET template_snapshot=? WHERE id=?').run(JSON.stringify(snapshot),session.id);
  assert.equal(repo.load(session.id).error,'corrupt_events');assert.equal(repo.apply({sessionId:session.id,requestId:'start',expectedRevision:1,action:{type:'start'}}).error,'corrupt_events');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM worker_events WHERE session_id=?').get(session.id).count,0);
 }finally{db.close();}
});
