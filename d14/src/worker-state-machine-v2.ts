import type { CompletionOutcome, WorkerLifecycle } from './worker-state-machine';

/** V1 remains the default for sessions without a discriminator. */
export function workerWorkflowVersion(value: unknown): 1 | 2 | null {
  return value === undefined || value === 1 ? 1 : value === 2 ? 2 : null;
}
export type V2Step = Readonly<{id:string; type:'question'; prompt:string; options:readonly Readonly<{id:string;text:string}>[]}> | Readonly<{id:string;type:'action';prompt:string}>;
export type V2Context = Readonly<{workflowVersion:2;sessionId:string;steps:readonly V2Step[];allowBack?:boolean}>;
export type V2Result = Readonly<{type:'question';optionId:string}> | Readonly<{type:'action';status:'completed'}> | Readonly<{type:'action';status:'problem';reason:string}>;
export type V2Finding = Readonly<{stepId:string;passed:boolean;reason:string;evidence:string}>;
export type V2Evaluation = Readonly<{schemaVersion:1;sessionId:string;sourceRevision:number;evidence:string;success:boolean;reason:string;errorCount:number;findings:readonly V2Finding[]}>;
export type V2Action = Readonly<{type:'start'|'next'|'back'|'quiz_next'|'quiz_back'|'retry'|'complete'|'validation_unavailable'}> | Readonly<{type:'submit'|'correct';stepId:string;visit:number;result:V2Result}> | Readonly<{type:'evaluate';evaluation:V2Evaluation}> | Readonly<{type:'failure';reason:string}>;
export type V2Submission = Readonly<{stepId:string;stepIndex:number;visit:number;attempt:number;result:V2Result}>;
// Future persistence must retain workflow version, ordered action facts, visits,
// submissions/invalidation, trusted evaluation and its evidence binding, and
// completion. This in-memory action log is not the V2 event codec or authority.
export type V2State = Readonly<{workflowVersion:2;sessionId:string;contextIdentity:string;revision:number;status:WorkerLifecycle;stepIndex:number;visit:number;attempt:number;visits:readonly Readonly<{stepId:string;stepIndex:number;visit:number}>[];results:readonly (V2Submission|null)[];submissions:readonly V2Submission[];evaluation:V2Evaluation|null;completion:CompletionOutcome|null;actions:readonly V2Action[]}>;
export type V2Error = 'invalid_context'|'invalid_state'|'invalid_action'|'forbidden_transition'|'identity_mismatch'|'invalid_result'|'invalid_evaluation'|'stale_evidence'|'validation_unavailable'|'counter_overflow';
export type V2Transition = {ok:true;state:V2State}|{ok:false;error:V2Error};
const fail=(error:V2Error):V2Transition=>({ok:false,error});
const obj=(v:unknown):v is Record<string,unknown>=>!!v && typeof v==='object' && !Array.isArray(v);
const exact=(v:Record<string,unknown>,keys:readonly string[])=>Object.keys(v).length===keys.length && keys.every(k=>Object.hasOwn(v,k));
const nonempty=(v:unknown,max:number):v is string=>typeof v==='string' && !!v.trim() && v.length<=max;
const id=(v:unknown):v is string=>typeof v==='string' && /^[a-zA-Z0-9-]{1,100}$/.test(v);
const number=(v:unknown,min:number):v is number=>typeof v==='number' && Number.isFinite(v) && Number.isSafeInteger(v) && !Object.is(v,-0) && v>=min;
// Encode only supported data values. Unlike JSON.stringify, this never equates
// NaN/Infinity, holes, undefined or custom serialization with null evidence.
function canonical(value:unknown, ancestors=new Set<object>()):string {
 if(value===null)return 'null';
 if(typeof value==='string')return JSON.stringify(value);
 if(typeof value==='boolean')return value?'true':'false';
 if(typeof value==='number'){if(!number(value,0))throw new TypeError('Invalid number');return String(value);}
 if(typeof value!=='object'||ancestors.has(value))throw new TypeError('Invalid value');
 ancestors.add(value);
 try {
  if(Array.isArray(value)){
   if(Reflect.ownKeys(value).length!==value.length+1)throw new TypeError('Invalid array');
   const entries:string[]=[];
   for(let i=0;i<value.length;i++){
    const descriptor=Object.getOwnPropertyDescriptor(value,String(i));
    if(!descriptor || !('value' in descriptor) || !descriptor.enumerable)throw new TypeError('Invalid array');
    entries.push(canonical(descriptor.value,ancestors));
   }
   return `[${entries.join(',')}]`;
  }
  if(Object.getPrototypeOf(value)!==Object.prototype && Object.getPrototypeOf(value)!==null)throw new TypeError('Invalid object');
  const keys=Reflect.ownKeys(value);
  if(keys.some(key=>typeof key!=='string'))throw new TypeError('Invalid key');
  return `{${(keys as string[]).sort().map(key=>{
   const descriptor=Object.getOwnPropertyDescriptor(value,key);
   if(!descriptor || !('value' in descriptor) || !descriptor.enumerable)throw new TypeError('Invalid property');
   return `${JSON.stringify(key)}:${canonical(descriptor.value,ancestors)}`;
  }).join(',')}}`;
 } finally {ancestors.delete(value);}
}
const same=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
function validContext(c:V2Context):boolean {
 if(!obj(c)||c.workflowVersion!==2||!id(c.sessionId)||!Array.isArray(c.steps)||c.steps.length<1||c.steps.length>100||(c.allowBack!==undefined&&typeof c.allowBack!=='boolean'))return false;
 const ids=new Set<string>();
 for(const step of c.steps){
  if(!obj(step)||!id(step.id)||ids.has(step.id)||!nonempty(step.prompt,2000))return false;ids.add(step.id);
  if(step.type==='action'){if(!exact(step,['id','type','prompt']))return false;}
  else if(step.type==='question'){
   if(!exact(step,['id','type','prompt','options'])||!Array.isArray(step.options)||step.options.length<2||step.options.length>4)return false;
   const options=new Set<string>();for(const option of step.options){if(!obj(option)||!exact(option,['id','text'])||!id(option.id)||options.has(option.id)||!nonempty(option.text,500))return false;options.add(option.id);}
  }else return false;
 }
 return true;
}
function validResult(step:V2Step,value:unknown):value is V2Result {
 if(!obj(value))return false;
 if(step.type==='question')return exact(value,['type','optionId'])&&value.type==='question'&&typeof value.optionId==='string'&&step.options.some(option=>option.id===value.optionId);
 return value.type==='action'&&(value.status==='completed' ? exact(value,['type','status']) : value.status==='problem'&&exact(value,['type','status','reason'])&&nonempty(value.reason,10000));
}
export function initialWorkerV2State(context:V2Context):V2State {
 if(!validContext(context))throw new RangeError('Invalid Worker V2 context');
 return {workflowVersion:2,sessionId:context.sessionId,contextIdentity:canonical([context.sessionId,context.steps,context.allowBack??true]),revision:1,status:'not_started',stepIndex:0,visit:0,attempt:1,visits:[],results:context.steps.map(()=>null),submissions:[],evaluation:null,completion:null,actions:[]};
}
// This canonical identity is an opaque binding, not a cryptographic signature.
// Stage 3D.3d must bind it to trusted server-owned snapshots and persisted events.
function evidence(state:V2State,context:V2Context,revision=state.revision):string {
 return canonical([2,context.sessionId,revision,context.steps,context.allowBack??true,state.results]);
}
function evidenceText(result:V2Result,step:V2Step):string {
 if(result.type==='question' && step.type==='question')return `Selected option ${result.optionId}: ${step.options.find(o=>o.id===result.optionId)?.text ?? ''}`;
 return result.type==='action' ? result.status==='problem'?`Problem: ${result.reason}`:'Completed' : '';
}
function validEvaluation(value:unknown,state:V2State,context:V2Context,revision:number):boolean {
 if(!obj(value)||!exact(value,['schemaVersion','sessionId','sourceRevision','evidence','success','reason','errorCount','findings'])||value.schemaVersion!==1||value.sessionId!==context.sessionId||!number(value.sourceRevision,1)||value.sourceRevision!==revision||value.evidence!==evidence(state,context,revision)||typeof value.success!=='boolean'||!nonempty(value.reason,5000)||!number(value.errorCount,0)||!Array.isArray(value.findings)||value.findings.length!==context.steps.length)return false;
 let errors=0;
 for(let i=0;i<context.steps.length;i++){
  const finding=value.findings[i],result=state.results[i];
  if(!result||!obj(finding)||!exact(finding,['stepId','passed','reason','evidence'])||finding.stepId!==context.steps[i].id||typeof finding.passed!=='boolean'||!nonempty(finding.reason,5000)||!nonempty(finding.evidence,10000)||!evidenceText(result.result,context.steps[i]).includes(finding.evidence))return false;
  if(!finding.passed)errors++;
 }
 return value.errorCount===errors&&value.success===(errors===0);
}
// applyKnown never reads clocks, storage, random values or external providers.
function applyKnown(state:V2State,action:V2Action,c:V2Context):V2Transition {
 if(!obj(action)||typeof action.type!=='string')return fail('invalid_action');
 if(state.status==='completed')return fail('forbidden_transition');
 if(state.revision===Number.MAX_SAFE_INTEGER)return fail('counter_overflow');
 const simple=['start','next','back','quiz_next','quiz_back','retry','complete','validation_unavailable'];
 if(simple.includes(action.type)&&!exact(action,['type']))return fail('invalid_action');
 const commit=(patch:Partial<V2State>):V2Transition=>({ok:true,state:{...state,...patch,revision:state.revision+1,actions:[...state.actions,structuredClone(action)]}});
 const current=state.results[state.stepIndex],step=c.steps[state.stepIndex];
 const move=(index:number):V2Transition=>{
  if(state.visits.length===Number.MAX_SAFE_INTEGER)return fail('counter_overflow');
  const visit=state.visits.length+1;
  return commit({stepIndex:index,visit,attempt:1,visits:[...state.visits,{stepId:c.steps[index].id,stepIndex:index,visit}],results:state.results.map((value,i)=>i>=index?null:value),evaluation:null});
 };
 switch(action.type){
  case 'start': return state.status==='not_started'?commit({status:'in_progress',visit:1,visits:[{stepId:step.id,stepIndex:0,visit:1}]}):fail('forbidden_transition');
  case 'submit': case 'correct': {
   if(!exact(action,['type','stepId','visit','result']))return fail('invalid_action');
   if(state.status!=='in_progress'||(action.type==='submit'?!!current:!current))return fail('forbidden_transition');
   if(action.stepId!==step.id||action.visit!==state.visit)return fail('identity_mismatch');
   if(!validResult(step,action.result))return fail('invalid_result');
   if(action.type==='correct'&&state.attempt===Number.MAX_SAFE_INTEGER)return fail('counter_overflow');
   const attempt=state.attempt+(action.type==='correct'?1:0),entry:V2Submission={stepId:step.id,stepIndex:state.stepIndex,visit:state.visit,attempt,result:structuredClone(action.result)};
   return commit({attempt,results:state.results.map((value,i)=>i===state.stepIndex?entry:value),submissions:[...state.submissions,entry],evaluation:null});
  }
  // Reviewing a quiz reopens its saved answer. Legacy navigation still records
  // invalidation when replaying older events or running a production task.
  case 'quiz_next': case 'quiz_back': {
   if(state.status!=='in_progress' || state.evaluation || !c.steps.every(s=>s.type==='question'))return fail('forbidden_transition');
   const forward=action.type==='quiz_next';
   const index=state.stepIndex+(forward?1:-1);
   if(index<0 || index>=c.steps.length || (forward?!current:c.allowBack===false))return fail('forbidden_transition');
   const previous=state.results[index];
   if(previous)return commit({stepIndex:index,visit:previous.visit,attempt:previous.attempt});
   const visit=state.visits.length+1;
   // Unanswered destinations get a fresh visit. Answered ones retain their evidence identity.
   return commit({stepIndex:index,visit,attempt:1,visits:[...state.visits,{stepId:c.steps[index].id,stepIndex:index,visit}]});
  }
  case 'next': return state.status==='in_progress'&&!!current&&state.stepIndex<c.steps.length-1?move(state.stepIndex+1):fail('forbidden_transition');
  case 'back': return state.status==='in_progress'&&c.allowBack!==false&&state.stepIndex>0?move(state.stepIndex-1):fail('forbidden_transition');
  case 'validation_unavailable': return fail('validation_unavailable');
  case 'evaluate': {
   if(!exact(action,['type','evaluation']))return fail('invalid_action');
   if(state.status!=='in_progress'||state.stepIndex!==c.steps.length-1||state.results.some(r=>!r)||state.evaluation)return fail('forbidden_transition');
   if(!obj(action.evaluation)||action.evaluation.sessionId!==c.sessionId||action.evaluation.sourceRevision!==state.revision||action.evaluation.evidence!==evidence(state,c))return fail('stale_evidence');
   if(!validEvaluation(action.evaluation,state,c,state.revision))return fail('invalid_evaluation');
   return commit({evaluation:structuredClone(action.evaluation)});
  }
  case 'complete': return state.status==='in_progress'&&!!state.evaluation?commit({status:'completed',completion:state.evaluation.success?'passed':'completed_with_errors'}):fail('forbidden_transition');
  case 'failure': return exact(action,['type','reason'])&&state.status==='in_progress'&&!current&&nonempty(action.reason,2000)?commit({status:'failed'}):fail('forbidden_transition');
  case 'retry': return state.status==='failed'?(state.attempt===Number.MAX_SAFE_INTEGER?fail('counter_overflow'):commit({status:'in_progress',attempt:state.attempt+1})):fail('forbidden_transition');
  default:return fail('invalid_action');
 }
}
// Shared consistency contract: reconstruct from immutable action facts; never
// accept a projection whose identity, visits, attempts, evidence or report differs.
function validState(state:V2State,c:V2Context):boolean {
 if(!obj(state)||state.workflowVersion!==2||state.sessionId!==c.sessionId||typeof state.contextIdentity!=='string'||!number(state.revision,1)||!number(state.stepIndex,0)||state.stepIndex>=c.steps.length||!number(state.visit,0)||!number(state.attempt,1)||!['not_started','in_progress','failed','completed'].includes(state.status)||!Array.isArray(state.visits)||!Array.isArray(state.results)||state.results.length!==c.steps.length||!Array.isArray(state.submissions)||!Array.isArray(state.actions)||state.actions.length>100000||(state.evaluation!==null&&!obj(state.evaluation))||(state.completion!==null&&state.completion!=='passed'&&state.completion!=='completed_with_errors'))return false;
 let rebuilt=initialWorkerV2State(c);
 for(const action of state.actions){const next=applyKnown(rebuilt,action,c);if(!next.ok)return false;rebuilt=next.state;}
 return same(state,rebuilt);
}
export function transitionWorkerV2(state:V2State,action:V2Action,context:V2Context):V2Transition {
 try {if(!validContext(context))return fail('invalid_context');if(!validState(state,context))return fail('invalid_state');return applyKnown(state,action,context);}catch{return fail('invalid_state');}
}
export function workerV2EvaluationEvidence(state:V2State,context:V2Context):{ok:true;sessionId:string;sourceRevision:number;evidence:string}|{ok:false;error:V2Error} {
 try {if(!validContext(context))return {ok:false,error:'invalid_context'};if(!validState(state,context))return {ok:false,error:'invalid_state'};if(state.status!=='in_progress'||state.stepIndex!==context.steps.length-1||state.results.some(r=>!r)||state.evaluation)return {ok:false,error:'forbidden_transition'};return {ok:true,sessionId:context.sessionId,sourceRevision:state.revision,evidence:evidence(state,context)};}catch{return {ok:false,error:'invalid_state'};}
}
