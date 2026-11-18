import type { DatabaseSync } from 'node:sqlite';
import { createHabitsPersistence, type HabitsPersistenceResult } from './habits-persistence.ts';
import type { createTurnContextStore } from './turn-context.ts';
import type { InstructionDetectorInput, InstructionDetectorResult } from '../src/persistent-instruction-detector.ts';
import type { PersonalizationSnapshot } from '../src/week3-session-api.ts';
import { editHabits, hasDetailLevelAddConflict } from '../src/habits-editor.ts';
import { isValidatedInstructionResult, parseInstructionProposals } from '../src/persistent-instruction-detector.ts';
import { createInstructionProposalStore } from './instruction-proposals.ts';

type DB = Pick<DatabaseSync,'exec'|'isTransaction'|'prepare'>;
type Profile = {id:string;name:string;habits:string;revision:number;is_system:number};
type Profiles = {get(id:string):Profile|null;update(id:string,name:string,habits:string,revision:number):Profile};
type Resolution = {ok:true;data:PersonalizationSnapshot}|{ok:false;error:string};
type Request = {sessionId:string;runId:string;messageId:string;turnToken:string};
export type InstructionCoordinatorResult =
  | {status:'confirmation_required';proposalId:string;expiresInMs:number;changes:Array<{action:'ADD'|'UPDATE'|'REMOVE';before?:string;after?:string}>}
  | {status:'applied';revision:number}
  | {status:'unchanged';revision:number}
  | {status:'general_skipped'|'invalid_token'|'mismatch'|'missing_message'|'ambiguous_message'|'incomplete_run'|'detector_failure'|'conflict'|'clarification_required'|'persistence_failure'|'unknown_commit'|'archive_failure'};

/** Local workflow consistency only: archived user roles are not authenticated authorship. */
export function createInstructionCoordinator<D extends DB>(deps:{db:D;profiles:Profiles;resolve:(db:D,sessionId:string)=>Resolution;contexts:ReturnType<typeof createTurnContextStore>;proposals?:ReturnType<typeof createInstructionProposalStore>;detector:{detect(input:InstructionDetectorInput):Promise<InstructionDetectorResult>}}) {
  const persistence=createHabitsPersistence({db:deps.db,profiles:deps.profiles,resolve:deps.resolve});
  const proposals=deps.proposals ?? createInstructionProposalStore();
  return {async process(input:Request):Promise<InstructionCoordinatorResult> {
    if (!input || typeof input!=='object' || Array.isArray(input) || Object.keys(input).length!==4 || Object.keys(input).some(key=>!['sessionId','runId','messageId','turnToken'].includes(key))) return {status:'mismatch'};
    const {sessionId,runId,messageId,turnToken}=input;
    let token;
    try {token=deps.contexts.consume(turnToken,{sessionId,runId,messageId});} catch {return {status:'invalid_token'};}
    if (!token.ok) return {status:token.error==='mismatch'?'mismatch':'invalid_token'};
    const snapshot=token.context.snapshot;
    let userMessage:string;
    try {
      const rows=deps.db.prepare(`SELECT sequence,type,payload FROM week3_history_events WHERE sessionId=? AND
        ((type='message' AND (json_extract(payload,'$.runId')=? OR json_extract(payload,'$.id')=?)) OR
         (type='run' AND json_extract(payload,'$.id')=?)) ORDER BY sequence`).all(sessionId,runId,messageId,runId);
      const events=rows.map(row=>({sequence:row.sequence,type:row.type,payload:JSON.parse(String(row.payload)) as Record<string,unknown>}));
      const messages=events.filter(event=>event.type==='message');
      const target=messages.filter(event=>event.payload.id===messageId);
      if (target.length>1) return {status:'ambiguous_message'};
      if (!target.length) return {status:'missing_message'};
      const users=messages.filter(event=>event.payload.runId===runId && event.payload.role==='user');
      if(users.length>1)return {status:'ambiguous_message'};
      const message=target[0];
      if(message.payload.id!==messageId || message.payload.runId!==runId || message.payload.conversationId!==sessionId || message.payload.role!=='user' || message.payload.type!=='text' || typeof message.payload.text!=='string' || !message.payload.text.trim())return {status:'mismatch'};
      const runs=events.filter(event=>event.type==='run');
      const latest=runs.at(-1);
      if (!latest || latest.payload.id!==runId || latest.payload.conversationId!==sessionId || latest.payload.status!=='completed' || !Array.isArray(latest.payload.messageIds) || !latest.payload.messageIds.includes(messageId) || typeof latest.sequence!=='number' || typeof message.sequence!=='number' || latest.sequence<=message.sequence || runs.filter(event=>event.payload.status==='completed').length!==1 || runs.slice(0,-1).some(event=>event.payload.status!=='running')) return {status:'incomplete_run'};
      const messageSequence=message.sequence, endSequence=latest.sequence;
      const hasAnswer=messages.some(event=>event.payload.runId===runId && event.payload.conversationId===sessionId && event.payload.role==='assistant' && event.payload.type==='text' && typeof event.payload.text==='string' && !!event.payload.text.trim() && typeof event.payload.id==='string' && (latest.payload.messageIds as unknown[]).includes(event.payload.id) && typeof event.sequence==='number' && event.sequence>messageSequence && event.sequence<endSequence);
      if(!hasAnswer)return {status:'incomplete_run'};
      userMessage=message.payload.text;
      const current=deps.resolve(deps.db,sessionId);
      if (!current.ok) return {status:current.error==='database_error'?'archive_failure':'mismatch'};
      if(current.data.sessionId!==sessionId || current.data.profileId!==snapshot.profileId)return {status:'mismatch'};
      if(current.data.profileRevision!==snapshot.profileRevision || current.data.habits!==snapshot.habits)return {status:'conflict'};
    } catch {return {status:'archive_failure'};}
    if(snapshot.profileId==='general')return {status:'general_skipped'};
    let detectorResult:InstructionDetectorResult;
    try {detectorResult=await deps.detector.detect({userMessage,habits:snapshot.habits});} catch {return {status:'detector_failure'};}
    if (!detectorResult || detectorResult.ok!==true)return {status:'detector_failure'};
    if(!isValidatedInstructionResult(detectorResult,{userMessage,habits:snapshot.habits}))return {status:'detector_failure'};
    const verified=parseInstructionProposals({userMessage,habits:snapshot.habits},JSON.stringify({operations:detectorResult.operations}));
    if(!verified.ok)return {status:'detector_failure'};
    const edited=editHabits(snapshot.habits,verified.operations);
    if(!edited.ok || edited.habits.length>50000)return {status:'detector_failure'};
    if(hasDetailLevelAddConflict(edited.habits,verified.operations))return {status:'clarification_required'};
    if(!edited.changed)return {status:'unchanged',revision:snapshot.profileRevision};
    try {
      const current=deps.resolve(deps.db,sessionId);
      if(!current.ok)return {status:current.error==='database_error'?'archive_failure':'mismatch'};
      if(current.data.profileId!==snapshot.profileId || current.data.sessionId!==sessionId)return {status:'mismatch'};
      if(current.data.profileRevision!==snapshot.profileRevision || current.data.habits!==snapshot.habits)return {status:'conflict'};
      const pending=proposals.create({sessionId,runId,messageId,userMessage,snapshot,detectorResult,proposedHabits:edited.habits});
      return pending.ok ? {status:'confirmation_required',proposalId:pending.id,expiresInMs:pending.expiresInMs,changes:verified.operations.map(op=>op.action==='ADD'?{action:op.action,after:op.newInstruction}:op.action==='UPDATE'?{action:op.action,before:op.targetLine.slice(2),after:op.newInstruction}:{action:op.action,before:op.targetLine.slice(2)})} : {status:'clarification_required'};
    } catch {return {status:'archive_failure'};}
  }, decide(input:{sessionId:string;proposalId:string;decision:'accept'|'reject'}):InstructionCoordinatorResult|{status:'rejected'|'invalid_proposal'|'expired_proposal'} {
    if(!input || !['accept','reject'].includes(input.decision) || typeof input.sessionId!=='string' || typeof input.proposalId!=='string')return {status:'invalid_proposal'};
    const claimed=proposals.claim(input.proposalId,input.sessionId);
    if(!claimed.ok)return {status:claimed.error==='expired'?'expired_proposal':'invalid_proposal'};
    if(input.decision==='reject')return {status:'rejected'};
    const {sessionId,userMessage,snapshot,detectorResult}=claimed.proposal;
    let result:HabitsPersistenceResult;
    try {result=persistence.apply({sessionId,userMessage,snapshot,detectorResult});} catch {return {status:'persistence_failure'};}
    if(result.status==='applied' || result.status==='unchanged')return result;
    if(result.status==='conflict')return {status:'conflict'};
    if(result.status==='clarification_required')return {status:'clarification_required'};
    if(result.code==='unknown_commit')return {status:'unknown_commit'};
    if(result.code==='invalid_session')return {status:'mismatch'};
    return {status:'persistence_failure'};
  }};
}
