import { editHabits, hasDetailLevelAddConflict, type HabitsOperation } from '../src/habits-editor.ts';
import { isValidatedInstructionResult, parseInstructionProposals, type InstructionDetectorResult } from '../src/persistent-instruction-detector.ts';
import type { PersonalizationSnapshot } from '../src/week3-session-api.ts';

type Profile = {id:string;name:string;habits:string;revision:number;is_system:number};
type Database = {exec(sql:string):void;readonly isTransaction:boolean};
type Profiles = {get(id:string):Profile | null;update(id:string,name:string,habits:string,revision:number):Profile};
type Resolution = {ok:true;data:PersonalizationSnapshot}|{ok:false;error:string};
export type HabitsPersistenceResult =
  | {status:'applied';revision:number}
  | {status:'unchanged';revision:number}
  | {status:'conflict'}
  | {status:'clarification_required'}
  | {status:'error';code:'invalid_proposal'|'invalid_session'|'general_immutable'|'storage_failure'|'unknown_commit';reconciliation?:'matches'|'different'|'unavailable'};
export type HabitsPersistenceInput = {sessionId:string;userMessage:string;snapshot:PersonalizationSnapshot;detectorResult:InstructionDetectorResult};

/** Internal-only service; dependencies must share one SQLite connection. */
export function createHabitsPersistence<DB extends Database>(deps:{db:DB;profiles:Profiles;resolve:(db:DB,sessionId:string)=>Resolution}) {
  return {apply(input:HabitsPersistenceInput):HabitsPersistenceResult {
    const {db,profiles,resolve}=deps;
    if (!input || !input.snapshot || input.sessionId!==input.snapshot.sessionId || !isValidatedInstructionResult(input.detectorResult,{userMessage:input.userMessage,habits:input.snapshot.habits})) return {status:'error',code:'invalid_proposal'};
    const verified=parseInstructionProposals({userMessage:input.userMessage,habits:input.snapshot.habits},JSON.stringify({operations:input.detectorResult.operations}));
    if (!verified.ok) return {status:'error',code:'invalid_proposal'};
    const operations:HabitsOperation[]=verified.operations.map(op=>op.action==='ADD'?{action:'ADD',newInstruction:op.newInstruction}:op.action==='UPDATE'?{action:'UPDATE',targetLine:op.targetLine,newInstruction:op.newInstruction}:{action:'REMOVE',targetLine:op.targetLine});
    let expectedHabits:string|undefined, expectedRevision:number|undefined, commitAttempted=false;
    const uncertain = ():HabitsPersistenceResult => {
      let reconciliation:'matches'|'different'|'unavailable'='unavailable';
      try {
        if (!db.isTransaction) {
          const current=profiles.get(input.snapshot.profileId);
          reconciliation=current && current.habits===expectedHabits && current.revision===expectedRevision ? 'matches' : 'different';
        }
      } catch { /* Outcome remains unknown when a reread fails. */ }
      return {status:'error',code:'unknown_commit',reconciliation};
    };
    try {
      if (db.isTransaction) return {status:'error',code:'storage_failure'};
      db.exec('BEGIN IMMEDIATE');
      const current=resolve(db,input.sessionId);
      if (!current.ok) {db.exec('ROLLBACK');return {status:'error',code:current.error==='database_error'?'storage_failure':'invalid_session'};}
      if (current.data.profileId!==input.snapshot.profileId || current.data.sessionId!==input.sessionId) {db.exec('ROLLBACK');return {status:'error',code:'invalid_session'};}
      if (current.data.profileId==='general') {db.exec('ROLLBACK');return {status:'error',code:'general_immutable'};}
      const profile=profiles.get(current.data.profileId);
      if (!profile || profile.is_system!==0 || profile.id!==current.data.profileId) {db.exec('ROLLBACK');return {status:'error',code:'invalid_session'};}
      if (profile.revision!==input.snapshot.profileRevision || profile.habits!==input.snapshot.habits || current.data.profileRevision!==profile.revision || current.data.habits!==profile.habits) {db.exec('ROLLBACK');return {status:'conflict'};}
      const edited=editHabits(profile.habits,operations);
      if (!edited.ok || edited.habits.length>50000) {db.exec('ROLLBACK');return {status:'error',code:'invalid_proposal'};}
      if (hasDetailLevelAddConflict(edited.habits,operations)) {db.exec('ROLLBACK');return {status:'clarification_required'};}
      if (!edited.changed) {db.exec('ROLLBACK');return {status:'unchanged',revision:profile.revision};}
      expectedHabits=edited.habits;expectedRevision=profile.revision+1;
      const saved=profiles.update(profile.id,profile.name,edited.habits,profile.revision);
      if (!saved || saved.revision!==expectedRevision || saved.habits!==expectedHabits || saved.id!==profile.id) throw new Error('Invalid profile update');
      commitAttempted=true;
      db.exec('COMMIT');
      return {status:'applied',revision:saved.revision};
    } catch {
      try {if (db.isTransaction) {db.exec('ROLLBACK');return {status:'error',code:'storage_failure'};}} catch {return uncertain();}
      return commitAttempted ? uncertain() : {status:'error',code:'storage_failure'};
    }
  }};
}
