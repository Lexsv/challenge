import { initialWorkerV2State, transitionWorkerV2, type V2Action, type V2Context, type V2State } from './worker-state-machine-v2.ts';

/** V2 envelopes contain accepted domain facts. They do not authorize client-supplied evaluations. */
export type V2Event = Readonly<{
  schemaVersion:2; reducerVersion:2; sessionId:string; requestId:string;
  sequence:number; expectedRevision:number; resultingRevision:number;
  stepId:string; stepIndex:number; visit:number; attempt:number;
  action:V2Action; resultingState:V2State['status']; resultingStepIndex:number;
  resultingVisit:number; resultingAttempt:number; completion:V2State['completion'];
}>;
export type V2ReplayError = 'invalid_context'|'malformed_event'|'unsupported_version'|'sequence_gap'|'duplicate_sequence'|'identity_mismatch'|'revision_mismatch'|'invalid_transition'|'projection_mismatch';
type Result<T> = {ok:true;data:T}|{ok:false;error:V2ReplayError};
const fail=<T>(error:V2ReplayError):Result<T>=>({ok:false,error});
const object=(value:unknown):value is Record<string,unknown>=>!!value && typeof value==='object' && !Array.isArray(value);
const id=(value:unknown):value is string=>typeof value==='string' && /^[a-zA-Z0-9-]{1,100}$/.test(value);
const integer=(value:unknown,min:number):value is number=>typeof value==='number' && Number.isFinite(value) && Number.isSafeInteger(value) && !Object.is(value,-0) && value>=min;
const keys=['schemaVersion','reducerVersion','sessionId','requestId','sequence','expectedRevision','resultingRevision','stepId','stepIndex','visit','attempt','action','resultingState','resultingStepIndex','resultingVisit','resultingAttempt','completion'];

/** Syntax validation only: replay verifies action evidence and transition semantics. */
export function decodeWorkerV2Event(value:unknown):Result<V2Event> {
 if(!object(value))return fail('malformed_event');
 if(value.schemaVersion!==2 || value.reducerVersion!==2)return fail(typeof value.schemaVersion==='number' && typeof value.reducerVersion==='number'?'unsupported_version':'malformed_event');
 if(Object.keys(value).length!==keys.length || keys.some(key=>!Object.hasOwn(value,key)) || !id(value.sessionId) || !id(value.requestId) || !id(value.stepId) || !integer(value.sequence,1) || !integer(value.expectedRevision,1) || !integer(value.resultingRevision,2) || !integer(value.stepIndex,0) || !integer(value.visit,0) || !integer(value.attempt,1) || !integer(value.resultingStepIndex,0) || !integer(value.resultingVisit,1) || !integer(value.resultingAttempt,1) || !object(value.action) || typeof value.action.type!=='string' || !['start','submit','correct','next','back','quiz_next','quiz_back','evaluate','complete','failure','retry'].includes(value.action.type) || !['not_started','in_progress','failed','completed'].includes(String(value.resultingState)) || !(value.completion===null || value.completion==='passed' || value.completion==='completed_with_errors') || (value.resultingState==='completed')!==(value.completion!==null))return fail('malformed_event');
 if(value.expectedRevision===Number.MAX_SAFE_INTEGER || value.resultingRevision!==value.expectedRevision+1)return fail('revision_mismatch');
 try{return {ok:true,data:structuredClone(value) as V2Event};}catch{return fail('malformed_event');}
}

/** The supplied state is checked by the V2 reducer before an event is produced. */
export function encodeWorkerV2Event(context:V2Context,state:V2State,requestId:string,sequence:number,action:V2Action):Result<V2Event> {
 if(!id(requestId) || !integer(sequence,1))return fail('malformed_event');
 if(!state || sequence!==state.revision)return fail('revision_mismatch');
 const result=transitionWorkerV2(state,action,context);
 if(!result.ok)return fail(result.error==='invalid_context'?'invalid_context':'invalid_transition');
 const step=context.steps[state.stepIndex];if(!step)return fail('identity_mismatch');
 return decodeWorkerV2Event({schemaVersion:2,reducerVersion:2,sessionId:context.sessionId,requestId,sequence,expectedRevision:state.revision,resultingRevision:result.state.revision,stepId:step.id,stepIndex:state.stepIndex,visit:state.visit,attempt:state.attempt,action,resultingState:result.state.status,resultingStepIndex:result.state.stepIndex,resultingVisit:result.state.visit,resultingAttempt:result.state.attempt,completion:result.state.completion});
}

/** Deterministic replay never invokes providers and never repairs corrupt history. */
export function replayWorkerV2Events(context:V2Context,events:readonly unknown[]):Result<V2State> {
 let state:V2State;try{state=initialWorkerV2State(context);}catch{return fail('invalid_context');}
 if(!Array.isArray(events))return fail('malformed_event');
 const sequences=new Set<number>(),requests=new Set<string>();
 for(let i=0;i<events.length;i++){
  const decoded=decodeWorkerV2Event(events[i]);if(!decoded.ok)return decoded;
  const event=decoded.data;
  if(sequences.has(event.sequence))return fail('duplicate_sequence');sequences.add(event.sequence);
  if(event.sequence!==i+1)return fail('sequence_gap');
  if(requests.has(event.requestId))return fail('identity_mismatch');requests.add(event.requestId);
  if(event.sessionId!==context.sessionId || event.stepId!==context.steps[state.stepIndex].id || event.stepIndex!==state.stepIndex || event.visit!==state.visit || event.attempt!==state.attempt)return fail('identity_mismatch');
  if(event.expectedRevision!==state.revision || event.resultingRevision!==state.revision+1)return fail('revision_mismatch');
  const next=transitionWorkerV2(state,event.action,context);if(!next.ok)return fail('invalid_transition');
  if(event.resultingState!==next.state.status || event.resultingStepIndex!==next.state.stepIndex || event.resultingVisit!==next.state.visit || event.resultingAttempt!==next.state.attempt || event.completion!==next.state.completion)return fail('identity_mismatch');
  state=next.state;
 }
 return {ok:true,data:state};
}

export function verifyWorkerV2Projection(state:V2State,projection:{state:string;stepIndex:number;attempt:number;revision:number}):Result<true> {
 if(!object(state) || !object(projection) || projection.state!==state.status || !integer(projection.stepIndex,0) || projection.stepIndex!==state.stepIndex || !integer(projection.attempt,1) || projection.attempt!==state.attempt || !integer(projection.revision,1) || projection.revision!==state.revision)return fail('projection_mismatch');
 return {ok:true,data:true};
}
