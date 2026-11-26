import { decodeWorkerEvent, encodeWorkerEvent, replayWorkerEvents, verifyWorkerProjection } from '../src/worker-event-replay.ts';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { decodeWorkerV2Event, encodeWorkerV2Event, replayWorkerV2Events, verifyWorkerV2Projection } from '../src/worker-event-replay-v2.ts';
import { workerV2EvaluationEvidence } from '../src/worker-state-machine-v2.ts';
import { validDocument } from './worker-repository.mjs';

// Internal-only repository. Validators and failure attestations are server-owned,
// synchronous, deterministic dependencies; never bind this interface to HTTP.
const validId=value=>typeof value==='string' && /^[a-zA-Z0-9-]{1,100}$/.test(value);
const object=value=>value!==null && typeof value==='object' && !Array.isArray(value);
const exact=(value,keys)=>object(value) && Object.keys(value).length===keys.length && keys.every(key=>Object.hasOwn(value,key));
const err=error=>({ok:false,error});
const abort=error=>{throw {controlled:true,error};};
// V1 identity is derived from command facts, never from a receipt's digest.
const commandFingerprint=(sessionId,expectedRevision,action)=>createHash('sha256').update(JSON.stringify([1,sessionId,expectedRevision,action.type,action.type==='validate'?action.answer:action.type==='failure'?action.reason:null])).digest('hex');
const v2Context=(id,snapshot)=>({workflowVersion:2,sessionId:id,...(snapshot.document.allowBack===undefined?{}:{allowBack:snapshot.document.allowBack}),steps:snapshot.document.steps.map(step=>step.type==='question'?{id:step.id,type:step.type,prompt:step.prompt,options:step.options}:{id:step.id,type:step.type,prompt:step.prompt})});
const v2PublicAction=action=>action.type==='submit'||action.type==='correct'?{type:action.type,result:action.result}:{type:action.type};
const v2Fingerprint=(sessionId,revision,action)=>createHash('sha256').update(JSON.stringify([2,sessionId,revision,action.type,action.type==='submit'||action.type==='correct'?action.result.type==='question'?['question',action.result.optionId]:['action',action.result.status,action.result.reason??null]:null])).digest('hex');
function validV2Action(action){
 if(!object(action) || !['start','next','back','quiz_next','quiz_back','retry','complete','submit','correct','evaluate'].includes(action.type))return false;
 if(!['submit','correct'].includes(action.type))return exact(action,['type']);
 if(!exact(action,['type','result'])||!object(action.result))return false;
 const r=action.result;
 return r.type==='question'?exact(r,['type','optionId'])&&validId(r.optionId):r.type==='action'&&(r.status==='completed'?exact(r,['type','status']):r.status==='problem'&&exact(r,['type','status','reason'])&&typeof r.reason==='string'&&!!r.reason.trim()&&r.reason.length<=10000);
}

/** SQLite columns repeat envelope identities so corruption cannot select a winner. */
export function workerEventToRow(event,createdAt) {
 const decoded=decodeWorkerEvent(event);
 if(!decoded.ok || !Number.isSafeInteger(createdAt) || createdAt<0)return err('invalid_input');
 const e=decoded.data;
 return {ok:true,data:{session_id:e.sessionId,sequence:e.sequence,request_id:e.requestId,action:e.eventType,step_index:e.stepIndex,payload:JSON.stringify(e),created_at:createdAt}};
}
export function workerRowToEvent(row,sessionId) {
 if(!object(row) || !validId(sessionId) || row.session_id!==sessionId || typeof row.payload!=='string' || !Number.isSafeInteger(row.created_at) || row.created_at<0)return err('corrupt_events');
 let payload;try{payload=JSON.parse(row.payload);}catch{return err('corrupt_events');}
 const decoded=decodeWorkerEvent(payload);if(!decoded.ok)return err('corrupt_events');
 const e=decoded.data;
 if(e.sessionId!==row.session_id || e.sequence!==row.sequence || e.requestId!==row.request_id || e.eventType!==row.action || e.stepIndex!==row.step_index)return err('corrupt_events');
 return {ok:true,data:e};
}

export function createWorkerTransitionRepository(db,{validate,attestFailure,now=Date.now,onPhase=()=>{}}={}) {
 const session=db.prepare('SELECT id,profile_id,template_id,template_version,template_snapshot,state,step_index,attempt,revision FROM worker_sessions WHERE id=?');
 const rows=db.prepare('SELECT session_id,sequence,request_id,action,step_index,payload,created_at FROM worker_events WHERE session_id=? ORDER BY sequence');
 const existing=db.prepare('SELECT 1 FROM worker_events WHERE session_id=? AND request_id=?');
 const receipt=db.prepare('SELECT fingerprint,action,outcome,response FROM worker_command_receipts WHERE session_id=? AND request_id=?');
 const addReceipt=db.prepare('INSERT INTO worker_command_receipts(session_id,request_id,fingerprint,action,outcome,response,created_at) VALUES(?,?,?,?,?,?,?)');
 const insert=db.prepare('INSERT INTO worker_events(session_id,sequence,request_id,action,step_index,payload,created_at) VALUES(?,?,?,?,?,?,?)');
 const update=db.prepare('UPDATE worker_sessions SET state=?,step_index=?,attempt=?,revision=?,updated_at=? WHERE id=? AND revision=?');
 const run=(fn,mode)=>{
  let begun=false,committing=false;try{if(db.prepare('PRAGMA foreign_keys').get().foreign_keys!==1)return err('storage_failure');db.exec(mode);begun=true;const result=fn();committing=true;db.exec('COMMIT');begun=false;return result;}
  catch(error){if(begun)try{db.exec('ROLLBACK');}catch{/* connection failure: no success claim */}return error?.controlled?err(error.error):err(committing?'unknown_outcome':'storage_failure');}
 };
 const read=id=>{
  const row=session.get(id);if(!row)abort('not_found');let snapshot;
  try{snapshot=JSON.parse(row.template_snapshot);}catch{abort('corrupt_events');}
  if(!object(snapshot) || snapshot.version!==row.template_version || (row.template_id!==null && snapshot.id!==row.template_id))abort('corrupt_events');
  if(snapshot.document?.schemaVersion===2){
   if(!validDocument(snapshot.document)||!validId(snapshot.id)||typeof snapshot.name!=='string'||!snapshot.name.trim()||snapshot.name.length>200||typeof snapshot.description!=='string'||snapshot.description.length>5000||typeof snapshot.rules!=='string'||snapshot.rules.length>20000)abort('corrupt_events');
   const context=v2Context(id,snapshot),data=[];
   for(const rowEvent of rows.all(id)){
    let raw;try{raw=JSON.parse(rowEvent.payload);}catch{abort('corrupt_events');}
    const decoded=decodeWorkerV2Event(raw);if(!decoded.ok)abort('corrupt_events');const event=decoded.data;
    if(rowEvent.session_id!==id||event.sessionId!==id||rowEvent.sequence!==event.sequence||rowEvent.request_id!==event.requestId||rowEvent.action!==event.action.type||rowEvent.step_index!==event.stepIndex)abort('corrupt_events');
    data.push(event);
   }
   const replay=replayWorkerV2Events(context,data);if(!replay.ok)abort('corrupt_events');
   onPhase('before_projection_verification');
   if(!verifyWorkerV2Projection(replay.data,{state:row.state,stepIndex:row.step_index,attempt:row.attempt,revision:row.revision}).ok)abort('projection_mismatch');
   return {row,input:{sessionId:id,snapshot},context,events:data,replay:{state:replay.data,revision:replay.data.revision},v2:true};
  }
  const data=[];for(const record of rows.all(id)){const result=workerRowToEvent(record,id);if(!result.ok)abort('corrupt_events');data.push(result.data);}
  const input={sessionId:id,snapshot};const replay=replayWorkerEvents(input,data);if(!replay.ok)abort('corrupt_events');
  onPhase('before_projection_verification');
  const projection=verifyWorkerProjection(replay.data,{state:row.state,stepIndex:row.step_index,attempt:row.attempt,revision:row.revision});
  if(!projection.ok)abort('projection_mismatch');
  return {row,input,events:data,replay:replay.data};
 };
 const get=id=>!validId(id)?err('invalid_input'):run(()=>({ok:true,data:read(id).replay}),'BEGIN');
 const isV2=id=>{const row=session.get(id);if(!row)return false;try{return JSON.parse(row.template_snapshot).document?.schemaVersion===2;}catch{return false;}};
 const receiptV2=(request,current,fingerprint)=>{
  const prior=receipt.get(request.sessionId,request.requestId);if(!prior)return null;
  if(!/^[a-f0-9]{64}$/.test(prior.fingerprint)||!['accepted','rejected'].includes(prior.outcome)||typeof prior.response!=='string')abort('integrity_failure');
  let response;try{response=JSON.parse(prior.response);}catch{abort('integrity_failure');}
  if(!object(response)||(prior.outcome==='accepted'? !exact(response,['ok','data'])||response.ok!==true||!object(response.data):!exact(response,['ok','error'])||response.ok!==false||!['invalid_transition','revision_conflict'].includes(response.error)))abort('integrity_failure');
  const event=current.events.find(item=>item.requestId===request.requestId);
  if(prior.outcome==='accepted'){
   if(!event||event.action.type!==prior.action||v2Fingerprint(event.sessionId,event.expectedRevision,v2PublicAction(event.action))!==prior.fingerprint)abort('integrity_failure');
   const historical=replayWorkerV2Events(current.context,current.events.slice(0,event.sequence));
   if(!historical.ok||!isDeepStrictEqual(response.data,{state:historical.data,revision:historical.data.revision}))abort('integrity_failure');
  }else if(event)abort('integrity_failure');
  if(prior.fingerprint!==fingerprint||prior.action!==request.action.type)abort('request_id_conflict');
  return {...response,replayed:true,historical:true};
 };
 const applyV2=(request, trustedEvaluation, prepare=false, inTransaction=false)=>{
  if(!exact(request,['sessionId','requestId','expectedRevision','action'])||!validId(request.sessionId)||!validId(request.requestId)||!Number.isSafeInteger(request.expectedRevision)||request.expectedRevision<1||!validV2Action(request.action))return err('invalid_input');
  const fingerprint=v2Fingerprint(request.sessionId,request.expectedRevision,request.action);
  const execute=()=>{
   const current=read(request.sessionId);if(!current.v2)abort('invalid_input');
   const prior=receiptV2(request,current,fingerprint);if(prior)return prior;
   if(existing.get(request.sessionId,request.requestId))abort('legacy_outcome_unavailable');
   if(prepare){
    if(request.action.type!=='evaluate')abort('invalid_input');
    let rejection;
    if(current.replay.revision!==request.expectedRevision)rejection='revision_conflict';
    const binding=workerV2EvaluationEvidence(current.replay.state,current.context);if(!binding.ok && !rejection)rejection='invalid_transition';
    if(rejection){const timestamp=now();if(!Number.isSafeInteger(timestamp)||timestamp<0)abort('storage_failure');const response=err(rejection);addReceipt.run(request.sessionId,request.requestId,fingerprint,request.action.type,'rejected',JSON.stringify(response),timestamp);return response;}
    return {ok:true,prepared:true,data:{state:current.replay.state,revision:current.replay.revision,snapshot:current.input.snapshot,binding}};
   }
   db.exec('SAVEPOINT worker_command');
   try{
    if(current.replay.revision!==request.expectedRevision)abort('revision_conflict');
    const state=current.replay.state;let action=request.action;
    if(state.evaluation && current.context.steps.every(step=>step.type==='question') && action.type!=='complete')abort('invalid_transition');
    if(action.type==='evaluate'){
     if(!trustedEvaluation)abort('validation_unavailable');
     action={type:'evaluate',evaluation:trustedEvaluation};
    }else if(action.type==='submit'||action.type==='correct')action={...action,stepId:current.context.steps[state.stepIndex].id,visit:state.visit};
    const candidate=encodeWorkerV2Event(current.context,state,request.requestId,current.events.length+1,action);if(!candidate.ok)abort(candidate.error==='invalid_transition'?'invalid_transition':'invalid_input');
    const next=replayWorkerV2Events(current.context,[...current.events,candidate.data]);if(!next.ok)abort('invalid_transition');
    const timestamp=now();if(!Number.isSafeInteger(timestamp)||timestamp<0)abort('storage_failure');
    onPhase('before_event_insert');insert.run(request.sessionId,candidate.data.sequence,request.requestId,action.type,candidate.data.stepIndex,JSON.stringify(candidate.data),timestamp);
    onPhase('after_event_insert');if(update.run(next.data.status,next.data.stepIndex,next.data.attempt,next.data.revision,timestamp,request.sessionId,current.replay.revision).changes!==1)abort('revision_conflict');
    onPhase('after_projection_update');const response={ok:true,data:{state:next.data,revision:next.data.revision}};
    onPhase('before_receipt_insert');addReceipt.run(request.sessionId,request.requestId,fingerprint,request.action.type,'accepted',JSON.stringify(response),timestamp);onPhase('after_receipt_insert');
    db.exec('RELEASE worker_command');return response;
   }catch(error){
    db.exec('ROLLBACK TO worker_command');db.exec('RELEASE worker_command');
    if(error?.controlled&&['invalid_transition','revision_conflict'].includes(error.error)){
     const response=err(error.error),timestamp=now();if(!Number.isSafeInteger(timestamp)||timestamp<0)abort('storage_failure');
     onPhase('before_receipt_insert');addReceipt.run(request.sessionId,request.requestId,fingerprint,request.action.type,'rejected',JSON.stringify(response),timestamp);onPhase('after_receipt_insert');return response;
    }
    throw error;
   }
  };
  return inTransaction?execute():run(execute,'BEGIN IMMEDIATE');
 };
 const apply=request=>{
  if(object(request)&&validId(request.sessionId)&&isV2(request.sessionId))return applyV2(request);
  if(!exact(request,['sessionId','requestId','expectedRevision','action']) || !validId(request.sessionId) || !validId(request.requestId) || !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision<1 || !object(request.action) || typeof request.action.type!=='string')return err('invalid_input');
  const type=request.action.type;
  if(!['start','next','back','retry','continue','complete','validate','failure'].includes(type))return err('invalid_input');
  if(type==='validate' ? !exact(request.action,['type','answer']) || typeof request.action.answer!=='string' || request.action.answer.length>10000 : type==='failure' ? !exact(request.action,['type','reason']) || typeof request.action.reason!=='string' || !request.action.reason.trim() || request.action.reason.length>2000 : !exact(request.action,['type']))return err('invalid_input');
  // V1 fingerprint covers session, expected revision, action type and exact
  // answer/reason text; request ID is the lookup key, not fingerprint input.
  const fingerprint=commandFingerprint(request.sessionId,request.expectedRevision,request.action);
  return run(()=>{
   onPhase('before_receipt_lookup');const prior=receipt.get(request.sessionId,request.requestId);
   if(prior){
    onPhase('before_receipt_decode');
    if(!/^[a-f0-9]{64}$/.test(prior.fingerprint) || typeof prior.action!=='string' || !['accepted','rejected'].includes(prior.outcome) || typeof prior.response!=='string')abort('integrity_failure');
    let response;try{response=JSON.parse(prior.response);}catch{abort('integrity_failure');}
    if(!object(response) || (prior.outcome==='accepted' ? !exact(response,['ok','data']) || response.ok!==true || !object(response.data) : !exact(response,['ok','error']) || response.ok!==false || !['invalid_transition','revision_conflict'].includes(response.error)))abort('integrity_failure');
    const verified=read(request.sessionId), applied=verified.events.find(event=>event.requestId===request.requestId);
    if(prior.outcome==='accepted'){
     if(!applied || applied.sessionId!==request.sessionId || applied.requestId!==request.requestId || applied.action.type!==prior.action || commandFingerprint(applied.sessionId,applied.expectedRevision,applied.action)!==prior.fingerprint)abort('integrity_failure');
     const historical=replayWorkerEvents(verified.input,verified.events.slice(0,applied.sequence));
     if(!historical.ok || JSON.stringify(historical.data)!==JSON.stringify(response.data))abort('integrity_failure');
    } else if(applied)abort('integrity_failure');
    if(prior.fingerprint!==fingerprint || prior.action!==type)abort('request_id_conflict');
    return {...response,replayed:true,historical:true};
   }
   const current=read(request.sessionId);
   if(existing.get(request.sessionId,request.requestId))abort('legacy_outcome_unavailable');
   db.exec('SAVEPOINT worker_command');
   try {
   if(current.replay.revision!==request.expectedRevision)abort('revision_conflict');
   const state=current.replay.state;let action=request.action,evidence={};
   if(type==='validate'){
    // Ask the domain reducer whether validation is allowed before invoking the validator.
    const probe={type:'validate',answer:request.action.answer,result:{stepId:current.input.snapshot.document.steps[state.stepIndex].id,visit:state.visit || 1,attempt:state.attempt,outcome:'accepted',feedback:''}};
    const eligible=encodeWorkerEvent(current.input,state,current.replay.revision,current.events.length+1,request.requestId,probe,{validator:{kind:'preflight',version:'1'}});
    if(!eligible.ok)abort(eligible.error==='invalid_transition'?'invalid_transition':'invalid_input');
    if(typeof validate!=='function')abort('trusted_validation_unavailable');
    // This trusted synchronous function must not perform I/O or network calls.
    const result=validate({sessionId:request.sessionId,snapshot:structuredClone(current.input.snapshot),state:structuredClone(state),answer:request.action.answer});
    if(!object(result) || !object(result.result) || !object(result.validator))abort('trusted_validation_unavailable');
    if(result.result.outcome==='unavailable'){
     // Validate the complete result and provenance using the codec's normal rules;
     // unavailable itself is not an encodable transition event.
     const check=encodeWorkerEvent(current.input,state,current.replay.revision,current.events.length+1,request.requestId,{type:'validate',answer:request.action.answer,result:{...result.result,outcome:'accepted'}},{validator:result.validator});
     if(!check.ok)abort('invalid_input');
     abort('validation_unavailable');
    }
    action={type:'validate',answer:request.action.answer,result:result.result};evidence={validator:result.validator};
   } else if(type==='failure'){
    if(typeof attestFailure!=='function' || attestFailure({sessionId:request.sessionId,state:structuredClone(state),reason:request.action.reason})!==true)abort('trusted_failure_unavailable');
    evidence={failureSource:'trusted-executor'};
   } else if(type==='retry') evidence={retrySource:state.status==='failed'?'execution_failure':'rejection'};
   else if(type==='continue'){
    const rejected=[...current.events].reverse().find(event=>event.eventType==='validation_rejected' && event.stepIndex===state.stepIndex && event.visit===state.visit && event.attempt===state.attempt);
    if(!rejected)abort('invalid_transition');evidence={rejectedRequestId:rejected.requestId};
   }
   const candidate=encodeWorkerEvent(current.input,state,current.replay.revision,current.events.length+1,request.requestId,action,evidence);
   if(!candidate.ok)abort(candidate.error==='invalid_transition'?'invalid_transition':'invalid_input');
   const replay=replayWorkerEvents(current.input,[...current.events,candidate.data]);if(!replay.ok)abort('invalid_transition');
   const timestamp=now();const encoded=workerEventToRow(candidate.data,timestamp);if(!encoded.ok)abort('storage_failure');
   onPhase('before_event_insert');const e=encoded.data;insert.run(e.session_id,e.sequence,e.request_id,e.action,e.step_index,e.payload,e.created_at);
   onPhase('after_event_insert');const next=replay.data;
   if(update.run(next.state.status,next.state.stepIndex,next.state.attempt,next.revision,timestamp,request.sessionId,current.replay.revision).changes!==1)abort('revision_conflict');
   onPhase('after_projection_update');const response={ok:true,data:next};
   onPhase('before_receipt_insert');addReceipt.run(request.sessionId,request.requestId,fingerprint,type,'accepted',JSON.stringify(response),timestamp);onPhase('after_receipt_insert');
   db.exec('RELEASE worker_command');return response;
   } catch(error) {
    db.exec('ROLLBACK TO worker_command');db.exec('RELEASE worker_command');
    if(error?.controlled && ['invalid_transition','revision_conflict'].includes(error.error)){
     const response=err(error.error), timestamp=now();if(!Number.isSafeInteger(timestamp) || timestamp<0)abort('storage_failure');
     onPhase('before_receipt_insert');addReceipt.run(request.sessionId,request.requestId,fingerprint,type,'rejected',JSON.stringify(response),timestamp);onPhase('after_receipt_insert');return response;
    }
    throw error;
   }
  },'BEGIN IMMEDIATE');
 };
 // One immutable starting snapshot per new attempt. Its deterministic ID also
 // reconciles a lost response without creating a second session.
 const retryQuiz=(sessionId,requestId,expectedRevision)=>{
  if(!validId(sessionId)||!validId(requestId)||!Number.isSafeInteger(expectedRevision)||expectedRevision<1)return err('invalid_input');
  const id=createHash('sha256').update(JSON.stringify(['quiz-attempt',sessionId,requestId])).digest('hex');
  return run(()=>{
   const source=read(sessionId);
   if(!source.v2 || !source.context.steps.every(step=>step.type==='question') || !source.replay.state.evaluation)abort('invalid_transition');
   const startKey=`start-${expectedRevision}`;
   if(session.get(id)){
    const child=read(id);
    if(child.events[0]?.requestId!==startKey)abort('request_id_conflict');
    return {ok:true,id};
   }
   if(source.replay.revision!==expectedRevision)abort('revision_conflict');
   const stamp=now();
   db.prepare(`INSERT INTO worker_sessions(id,name,profile_id,template_id,template_version,template_snapshot,state,step_index,attempt,revision,created_at,updated_at)
    SELECT ?,name,profile_id,template_id,template_version,template_snapshot,'not_started',0,1,1,?,? FROM worker_sessions WHERE id=?`).run(id,stamp,stamp,sessionId);
   const started=applyV2({sessionId:id,requestId:startKey,expectedRevision:1,action:{type:'start'}},undefined,false,true);
   if(!started.ok)abort(started.error);
   return {ok:true,id};
  },'BEGIN IMMEDIATE');
 };
 return {load:get,apply,isV2,retryQuiz,prepareV2Evaluation:request=>applyV2(request,undefined,true),commitV2Evaluation:(request,evaluation)=>applyV2(request,evaluation)};
}
