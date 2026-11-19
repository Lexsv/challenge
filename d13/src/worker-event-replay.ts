import { initialWorkerState, transition, type WorkerAction, type WorkerContext, type WorkerLifecycle, type WorkerState } from './worker-state-machine.ts';

type ErrorCode = 'malformed_event' | 'unsupported_version' | 'sequence_gap' | 'duplicate_sequence' | 'invalid_transition' | 'identity_mismatch' | 'revision_mismatch' | 'projection_mismatch' | 'invalid_snapshot';
type Result<T> = {ok:true;data:T} | {ok:false;error:ErrorCode};
export type EventKind = 'worker_started' | 'validation_accepted' | 'validation_rejected' | 'retry_started' | 'error_accepted' | 'step_advanced' | 'step_revisited' | 'execution_failed' | 'worker_completed';
export type EventEvidence = Readonly<{validator?:Readonly<{kind:string;version:string}>;failureSource?:string;retrySource?:'rejection'|'execution_failure';rejectedRequestId?:string}>;
export type WorkerEvent = Readonly<{schemaVersion:1;reducerVersion:1;sessionId:string;requestId:string;sequence:number;eventType:EventKind;action:WorkerAction;evidence:EventEvidence;stepId:string;stepIndex:number;visit:number;attempt:number;expectedRevision:number;resultingRevision:number;resultingState:WorkerLifecycle;resultingStepIndex:number;resultingStepId:string;resultingVisit:number;resultingAttempt:number;completion:'passed'|'completed_with_errors'|null}>;
export type ReplayInput = Readonly<{sessionId:string;snapshot:unknown;allowBack?:boolean}>;
export type ReplayValue = Readonly<{state:WorkerState;revision:number}>;
export type WorkerProjection = Readonly<{state:WorkerLifecycle;stepIndex:number;attempt:number;revision:number;completion?:'passed'|'completed_with_errors'|null}>;
const bad=<T>(error:ErrorCode):Result<T>=>({ok:false,error});
const obj=(v:unknown):v is Record<string,unknown>=>typeof v==='object' && v!==null && !Array.isArray(v);
const integer=(v:unknown,min:number):v is number=>typeof v==='number' && Number.isSafeInteger(v) && v>=min;
const id=(v:unknown):v is string=>typeof v==='string' && /^[a-zA-Z0-9-]{1,100}$/.test(v);
const bounded=(v:unknown,n:number):v is string=>typeof v==='string' && v.length<=n;
const kinds:Record<string,EventKind>={start:'worker_started',retry:'retry_started',continue:'error_accepted',next:'step_advanced',back:'step_revisited',failure:'execution_failed',complete:'worker_completed'};
const lifecycle=(v:unknown):v is WorkerLifecycle=>v==='not_started'||v==='in_progress'||v==='failed'||v==='completed';
const exact=(v:Record<string,unknown>,keys:string[])=>Object.keys(v).length===keys.length && keys.every(k=>Object.hasOwn(v,k));

function parseAction(value:unknown):WorkerAction|null {
 if(!obj(value) || typeof value.type!=='string')return null;
 if(value.type==='start'||value.type==='next'||value.type==='back'||value.type==='retry'||value.type==='continue'||value.type==='complete')return exact(value,['type'])?{type:value.type}:null;
 if(value.type==='failure')return exact(value,['type','reason']) && bounded(value.reason,2000) && value.reason.trim()?{type:'failure',reason:value.reason}:null;
 if(value.type!=='validate'||!exact(value,['type','answer','result'])||!bounded(value.answer,10000)||!obj(value.result))return null;
 const r=value.result;const keys=['stepId','visit','attempt','outcome','feedback',...(Object.hasOwn(r,'reason')?['reason']:[])];
 if(!exact(r,keys)||!id(r.stepId)||!integer(r.visit,1)||!integer(r.attempt,1)||(r.outcome!=='accepted'&&r.outcome!=='rejected')||!bounded(r.feedback,5000)||(r.reason!==undefined&&!bounded(r.reason,2000)))return null;
 return {type:'validate',answer:value.answer,result:{stepId:r.stepId,visit:r.visit,attempt:r.attempt,outcome:r.outcome,feedback:r.feedback,...(typeof r.reason==='string'?{reason:r.reason}:{})}};
}
function eventKind(action:WorkerAction):EventKind {return action.type==='validate'?(action.result.outcome==='accepted'?'validation_accepted':'validation_rejected'):kinds[action.type];}
/** Decodes only the domain envelope; semantic evidence is verified during replay. */
export function decodeWorkerEvent(value:unknown):Result<WorkerEvent> {
 if(!obj(value))return bad('malformed_event');
 if(value.schemaVersion!==1 || value.reducerVersion!==1)return bad((typeof value.schemaVersion==='number' || typeof value.reducerVersion==='number')?'unsupported_version':'malformed_event');
 const fields=['schemaVersion','reducerVersion','sessionId','requestId','sequence','eventType','action','evidence','stepId','stepIndex','visit','attempt','expectedRevision','resultingRevision','resultingState','resultingStepIndex','resultingStepId','resultingVisit','resultingAttempt','completion'];
 if(!exact(value,fields))return bad('malformed_event');
 const action=parseAction(value.action);
 if(!action||!id(value.sessionId)||!id(value.requestId)||!id(value.stepId)||!integer(value.sequence,1)||!integer(value.stepIndex,0)||!integer(value.visit,0)||!integer(value.attempt,1)||!integer(value.expectedRevision,1)||!integer(value.resultingRevision,2)||!lifecycle(value.resultingState)||!integer(value.resultingStepIndex,0)||!id(value.resultingStepId)||!integer(value.resultingVisit,1)||!integer(value.resultingAttempt,1)||(value.completion!==null&&value.completion!=='passed'&&value.completion!=='completed_with_errors')||value.eventType!==eventKind(action)||(value.resultingState==='completed')!==(value.completion!==null))return bad('malformed_event');
 if(value.expectedRevision===Number.MAX_SAFE_INTEGER || value.resultingRevision!==value.expectedRevision+1)return bad('revision_mismatch');
 if(!obj(value.evidence))return bad('malformed_event');
 let evidence:EventEvidence={};
 if(action.type==='validate') {const validator=value.evidence.validator;if(!exact(value.evidence,['validator']) || !obj(validator) || !exact(validator,['kind','version']) || !id(validator.kind) || !id(validator.version))return bad('malformed_event');evidence={validator:{kind:validator.kind,version:validator.version}};}
 else if(action.type==='failure'){if(!exact(value.evidence,['failureSource']) || !id(value.evidence.failureSource))return bad('malformed_event');evidence={failureSource:value.evidence.failureSource};}
 else if(action.type==='retry'){if(!exact(value.evidence,['retrySource']) || (value.evidence.retrySource!=='rejection' && value.evidence.retrySource!=='execution_failure'))return bad('malformed_event');evidence={retrySource:value.evidence.retrySource};}
 else if(action.type==='continue'){if(!exact(value.evidence,['rejectedRequestId']) || !id(value.evidence.rejectedRequestId))return bad('malformed_event');evidence={rejectedRequestId:value.evidence.rejectedRequestId};}
 else if(!exact(value.evidence,[]))return bad('malformed_event');
 if(action.type==='validate' && (action.result.stepId!==value.stepId || action.result.visit!==value.visit || action.result.attempt!==value.attempt))return bad('identity_mismatch');
 return {ok:true,data:{schemaVersion:1,reducerVersion:1,sessionId:value.sessionId,requestId:value.requestId,sequence:value.sequence,eventType:eventKind(action),action,evidence,stepId:value.stepId,stepIndex:value.stepIndex,visit:value.visit,attempt:value.attempt,expectedRevision:value.expectedRevision,resultingRevision:value.resultingRevision,resultingState:value.resultingState,resultingStepIndex:value.resultingStepIndex,resultingStepId:value.resultingStepId,resultingVisit:value.resultingVisit,resultingAttempt:value.resultingAttempt,completion:value.completion}};
}
function snapshotContext(input:ReplayInput):Result<WorkerContext> {
 if(!obj(input)||!id(input.sessionId)||!obj(input.snapshot))return bad('invalid_snapshot');
 const s=input.snapshot,d=s.document;
 if(Object.keys(s).some(key=>!['id','name','description','rules','version','document','createdAt','updatedAt'].includes(key))||!id(s.id)||!bounded(s.name,200)||!s.name.trim()||!bounded(s.description,5000)||!bounded(s.rules,20000)||!integer(s.version,1)||(s.createdAt!==undefined&&!integer(s.createdAt,0))||(s.updatedAt!==undefined&&!integer(s.updatedAt,0))||!obj(d)||!exact(d,['schemaVersion','steps'])||d.schemaVersion!==1||!Array.isArray(d.steps)||d.steps.length<1||d.steps.length>100||(input.allowBack!==undefined&&typeof input.allowBack!=='boolean'))return bad('invalid_snapshot');
 const steps:{id:string}[]=[];const ids=new Set<string>();
 for(const step of d.steps){if(!obj(step)||!id(step.id)||ids.has(step.id)||!bounded(step.prompt,2000)||!step.prompt.trim())return bad('invalid_snapshot');ids.add(step.id);if(step.type==='action'){if(!exact(step,['id','type','prompt']))return bad('invalid_snapshot');}else if(step.type==='question'){if(!exact(step,['id','type','prompt','options'])||!Array.isArray(step.options)||step.options.length<2||step.options.length>4)return bad('invalid_snapshot');const opts=new Set<string>();for(const option of step.options){if(!obj(option)||!exact(option,['id','text'])||!id(option.id)||opts.has(option.id)||!bounded(option.text,500)||!option.text.trim())return bad('invalid_snapshot');opts.add(option.id);}}else return bad('invalid_snapshot');steps.push({id:step.id});}
 if(new TextEncoder().encode(JSON.stringify(d)).length>100000)return bad('invalid_snapshot');
 return {ok:true,data:{steps,...(input.allowBack===undefined?{}:{allowBack:input.allowBack})}};
}
/** Encodes a transition by recomputing it, never trusting a caller-supplied result. */
export function encodeWorkerEvent(input:ReplayInput,state:WorkerState,revision:number,sequence:number,requestId:string,action:WorkerAction,evidence:EventEvidence={}):Result<WorkerEvent> {
 const context=snapshotContext(input);if(!context.ok)return context;
 if(!integer(revision,1)||revision===Number.MAX_SAFE_INTEGER||!integer(sequence,1)||!id(requestId))return bad('malformed_event');
 if(sequence!==revision)return bad('revision_mismatch');
 if(!parseAction(action))return bad('malformed_event');
 const next=transition(state,action,context.data);if(!next.ok)return bad('invalid_transition');
 const step=context.data.steps[state.stepIndex];if(!step)return bad('identity_mismatch');
 if(action.type==='retry') {
  if(!obj(evidence) || !exact(evidence,['retrySource']) || (evidence.retrySource!=='rejection' && evidence.retrySource!=='execution_failure'))return bad('malformed_event');
  if(evidence.retrySource!==(state.status==='failed'?'execution_failure':'rejection'))return bad('identity_mismatch');
 }
 return decodeWorkerEvent({schemaVersion:1,reducerVersion:1,sessionId:input.sessionId,requestId,sequence,eventType:eventKind(action),action,evidence,stepId:step.id,stepIndex:state.stepIndex,visit:state.visit,attempt:state.attempt,expectedRevision:revision,resultingRevision:revision+1,resultingState:next.state.status,resultingStepIndex:next.state.stepIndex,resultingStepId:context.data.steps[next.state.stepIndex].id,resultingVisit:next.state.visit,resultingAttempt:next.state.attempt,completion:next.state.completion});
}
/** Replays recorded facts through the current versioned reducer; performs no I/O. */
export function replayWorkerEvents(input:ReplayInput,events:readonly unknown[]):Result<ReplayValue> {
 const context=snapshotContext(input);if(!context.ok)return context;
 if(!Array.isArray(events))return bad('malformed_event');
 let state=initialWorkerState(context.data.steps.length),revision=1;const ids=new Set<string>(),sequences=new Set<number>();const rejected=new Map<string,string>();
 for(let i=0;i<events.length;i++){
  const decoded=decodeWorkerEvent(events[i]);if(!decoded.ok)return decoded;const e=decoded.data;
  if(sequences.has(e.sequence))return bad('duplicate_sequence');sequences.add(e.sequence);
  if(e.sequence!==i+1)return bad('sequence_gap');if(ids.has(e.requestId))return bad('identity_mismatch');ids.add(e.requestId);
  if(e.sessionId!==input.sessionId || e.stepIndex!==state.stepIndex || e.stepId!==context.data.steps[state.stepIndex].id || e.visit!==state.visit || e.attempt!==state.attempt)return bad('identity_mismatch');
  if(e.expectedRevision!==revision || e.resultingRevision!==revision+1)return bad('revision_mismatch');
  const attemptKey=`${e.stepId}:${e.visit}:${e.attempt}`;
  if(e.action.type==='retry' && e.evidence.retrySource!==(state.status==='failed'?'execution_failure':'rejection'))return bad('identity_mismatch');
  if(e.action.type==='continue' && e.evidence.rejectedRequestId!==rejected.get(attemptKey))return bad('identity_mismatch');
  const next=transition(state,e.action,context.data);if(!next.ok)return bad('invalid_transition');
  if(next.state.status!==e.resultingState||next.state.stepIndex!==e.resultingStepIndex||context.data.steps[next.state.stepIndex].id!==e.resultingStepId||next.state.visit!==e.resultingVisit||next.state.attempt!==e.resultingAttempt||next.state.completion!==e.completion)return bad('identity_mismatch');
  if(e.action.type==='validate' && e.action.result.outcome==='rejected')rejected.set(attemptKey,e.requestId);
  state=next.state;revision=e.resultingRevision;
 }
 return {ok:true,data:{state,revision}};
}
export function verifyWorkerProjection(result:ReplayValue,projection:WorkerProjection):Result<true> {
 if(!obj(result)||!obj(result.state)||!obj(projection)||!integer(result.revision,1)||!integer(projection.revision,1)||!integer(projection.stepIndex,0)||!integer(projection.attempt,1)||!lifecycle(projection.state))return bad('projection_mismatch');
 if(projection.state!==result.state.status||projection.stepIndex!==result.state.stepIndex||projection.attempt!==result.state.attempt||projection.revision!==result.revision||(Object.hasOwn(projection,'completion')&&projection.completion!==result.state.completion))return bad('projection_mismatch');
 return {ok:true,data:true};
}
