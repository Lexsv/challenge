/** Pure Worker domain model. Existing templates default to allowing Back. */
export type WorkerLifecycle = 'not_started' | 'in_progress' | 'failed' | 'completed';
export type CompletionOutcome = 'passed' | 'completed_with_errors';
export type StepResolution = 'passed' | 'accepted_error';
export type ValidationResult = Readonly<{
  stepId: string;
  visit: number;
  attempt: number;
  outcome: 'accepted' | 'rejected' | 'unavailable';
  feedback: string;
  reason?: string;
}>;
export type ValidationAttempt = Readonly<{
  stepId: string; stepIndex: number; visit: number; attempt: number;
  answer: string; outcome: 'accepted' | 'rejected'; feedback: string;
  reason?: string; disposition: 'pending' | 'retried' | 'continued' | 'accepted';
}>;
export type WorkerState = Readonly<{
  status: WorkerLifecycle; stepIndex: number; attempt: number; visit: number;
  resolutions: readonly (StepResolution | null)[];
  history: readonly ValidationAttempt[];
  failures: readonly Readonly<{stepId:string;stepIndex:number;visit:number;attempt:number;reason:string}>[];
  stepIds: readonly string[] | null;
  visits: readonly Readonly<{stepId:string;stepIndex:number;visit:number}>[];
  completion: CompletionOutcome | null;
}>;
export type WorkerContext = Readonly<{ steps: readonly Readonly<{id:string}>[]; allowBack?: boolean }>;
export type WorkerAction =
  | Readonly<{type:'start' | 'next' | 'back' | 'retry' | 'continue' | 'complete'}>
  | Readonly<{type:'validate'; answer:string; result:ValidationResult}>
  | Readonly<{type:'failure'; reason:string}>;
export type TransitionError = 'invalid_state' | 'invalid_action' | 'forbidden_transition' | 'invalid_validation' | 'identity_mismatch' | 'validation_unavailable' | 'counter_overflow';
export type TransitionResult = Readonly<{ok:true; state:WorkerState}> | Readonly<{ok:false; error:TransitionError}>;

export function initialWorkerState(stepCount:number):WorkerState {
  if(!Number.isSafeInteger(stepCount) || stepCount<1) throw new RangeError('A Worker needs at least one step.');
  return {status:'not_started',stepIndex:0,attempt:1,visit:0,resolutions:Array(stepCount).fill(null),history:[],failures:[],stepIds:null,visits:[],completion:null};
}
const failure=(error:TransitionError):TransitionResult=>({ok:false,error});
const isPositive=(value:unknown):value is number=>Number.isSafeInteger(value) && (value as number)>0;

// Invariants: every visit has sequential, unique attempts; retries follow a
// rejection or failure; the active attempt and lifecycle match the latest
// evidence; and a resolution is supported by its visit's final attempt.
// Persistence/API callers additionally validate ownership and revisions.
function stateError(state:WorkerState,context:WorkerContext):TransitionError | null {
  if(!context || !Array.isArray(context.steps) || !context.steps.length || Array.from(context.steps).some(s=>!s || typeof s.id!=='string' || !s.id.trim()) || new Set(context.steps.map(s=>s.id)).size!==context.steps.length || (context.allowBack!==undefined && typeof context.allowBack!=='boolean'))return 'invalid_state';
  if(!state || !['not_started','in_progress','failed','completed'].includes(state.status) || !Number.isSafeInteger(state.stepIndex) || state.stepIndex<0 || state.stepIndex>=context.steps.length || !isPositive(state.attempt) || !Number.isSafeInteger(state.visit) || state.visit<0 || !Array.isArray(state.resolutions) || state.resolutions.length!==context.steps.length || Array.from(state.resolutions).some(r=>r!==null && r!=='passed' && r!=='accepted_error') || !Array.isArray(state.history) || !Array.isArray(state.failures) || !Array.isArray(state.visits))return 'invalid_state';
  if(state.status==='not_started') return state.stepIndex===0 && state.visit===0 && state.attempt===1 && state.stepIds===null && !state.history.length && !state.failures.length && !state.visits.length && state.resolutions.every(r=>r===null) && state.completion===null ? null : 'invalid_state';
  if(!Array.isArray(state.stepIds) || state.stepIds.length!==context.steps.length || Array.from(state.stepIds).some((id,i)=>id!==context.steps[i].id))return 'identity_mismatch';
  if(!isPositive(state.visit) || state.visits.length!==state.visit)return 'invalid_state';
  if(Array.from(state.history).some(item=>!item || typeof item!=='object') || Array.from(state.failures).some(item=>!item || typeof item!=='object'))return 'invalid_state';
  const ordered=(items:readonly {visit:number;attempt:number}[])=>items.every((item,i)=>i===0 || item.visit>items[i-1].visit || (item.visit===items[i-1].visit && item.attempt>items[i-1].attempt));
  if(!ordered(state.history) || !ordered(state.failures))return 'invalid_state';
  for(let i=0;i<state.visits.length;i++) {
    const v=state.visits[i],previous=state.visits[i-1];
    if(!v || v.visit!==i+1 || !Number.isSafeInteger(v.stepIndex) || v.stepIndex<0 || v.stepIndex>=context.steps.length || v.stepId!==context.steps[v.stepIndex].id || (i===0 ? v.stepIndex!==0 : Math.abs(v.stepIndex-previous.stepIndex)!==1))return 'invalid_state';
  }
  if(state.visits.at(-1)?.stepIndex!==state.stepIndex)return 'identity_mismatch';
  const counters=new Map<number,number>();
  const seen=new Set<string>();
  const attempts=[...state.history.map(item=>({item,kind:'history' as const})),...state.failures.map(item=>({item,kind:'failure' as const}))];
  for(const record of attempts){
    const a=record.item;
    if(!a || typeof a!=='object' || !isPositive(a.visit) || !isPositive(a.attempt) || !Number.isSafeInteger(a.stepIndex) || a.stepIndex<0 || a.stepIndex>=context.steps.length || typeof a.stepId!=='string' || state.visits[a.visit-1]?.stepIndex!==a.stepIndex || context.steps[a.stepIndex].id!==a.stepId)return 'invalid_state';
    if(record.kind==='history') {const h=record.item as ValidationAttempt;if(typeof h.answer!=='string' || typeof h.feedback!=='string' || (h.reason!==undefined && typeof h.reason!=='string') || (h.outcome==='accepted' ? h.disposition!=='accepted' : h.outcome==='rejected' ? !['pending','retried','continued'].includes(h.disposition) : true))return 'invalid_state';}
    else if(typeof (a as WorkerState['failures'][number]).reason!=='string' || !(a as WorkerState['failures'][number]).reason.trim())return 'invalid_state';
    const key=`${a.visit}:${a.attempt}`;
    // A visit/attempt may have exactly one validation or execution failure.
    if(seen.has(key))return 'invalid_state';seen.add(key);
    counters.set(a.visit,Math.max(counters.get(a.visit) ?? 0,a.attempt));
  }
  for(const [visit,max] of counters){
    const records=attempts.filter(x=>x.item.visit===visit).sort((a,b)=>a.item.attempt-b.item.attempt);
    if(records.some((record,i)=>record.item.attempt!==i+1 || (i<records.length-1 && record.kind==='history' && (record.item as ValidationAttempt).disposition!=='retried')) || max>(visit===state.visit?state.attempt:Number.MAX_SAFE_INTEGER))return 'invalid_state';
  }
  const activeRecords=attempts.filter(record=>record.item.visit===state.visit).sort((a,b)=>a.item.attempt-b.item.attempt);
  const active=activeRecords.at(-1);
  if(!active){
    if(state.attempt!==1 || state.status==='failed')return 'invalid_state';
  } else if(active.kind==='failure') {
    if(state.status==='failed' ? state.attempt!==active.item.attempt : state.attempt!==active.item.attempt+1)return 'invalid_state';
  } else {
    const disposition=(active.item as ValidationAttempt).disposition;
    if(state.status==='failed' || state.attempt!==(disposition==='retried'?active.item.attempt+1:active.item.attempt))return 'invalid_state';
  }
  for(let i=0;i<state.resolutions.length;i++){
    const resolution=state.resolutions[i];if(resolution===null)continue;
    const relevant=state.history.filter(h=>h.stepIndex===i && (h.disposition==='accepted' || h.disposition==='continued')).at(-1);
    const lastInvalidation=state.visits.filter(v=>v.stepIndex<=i).at(-1)?.visit ?? 0;
    if(!relevant || relevant.visit<lastInvalidation || (resolution==='passed' ? relevant.disposition!=='accepted' : relevant.disposition!=='continued'))return 'identity_mismatch';
    if(relevant.visit===state.visit && relevant.attempt!==state.attempt)return 'identity_mismatch';
  }
  if(state.status==='completed') {if(state.resolutions.some(r=>r===null) || state.completion!==(state.resolutions.includes('accepted_error')?'completed_with_errors':'passed'))return 'invalid_state';}
  else if(state.completion!==null)return 'invalid_state';
  return null;
}

/** The caller supplies validator outcomes; no I/O, clocks, IDs or mutable globals are used. */
export function transition(state:WorkerState,action:WorkerAction,context:WorkerContext):TransitionResult {
  if(action?.type==='retry' && state?.attempt===Number.MAX_SAFE_INTEGER)return failure('counter_overflow');
  const invalid=stateError(state,context);if(invalid)return failure(invalid);
  if(!action || typeof action!=='object' || !['start','next','back','retry','continue','complete','validate','failure'].includes(action.type))return failure('invalid_action');
  if(state.status==='completed')return failure('forbidden_transition');
  const stepId=context.steps[state.stepIndex].id;
  const last=state.history.at(-1);
  const current=last && last.stepId===stepId && last.visit===state.visit && last.attempt===state.attempt ? last : undefined;
  const withState=(changes:Partial<WorkerState>):TransitionResult=>{
    const next={...state,...changes};
    return {ok:true,state:{...next,stepIds:next.stepIds && [...next.stepIds],visits:next.visits.map(item=>({...item})),resolutions:[...next.resolutions],history:next.history.map(item=>({...item})),failures:next.failures.map(item=>({...item}))}};
  };
  const move=(index:number):TransitionResult=>state.visit===Number.MAX_SAFE_INTEGER ? failure('counter_overflow') : withState({stepIndex:index,attempt:1,visit:state.visit+1,visits:[...state.visits,{stepId:context.steps[index].id,stepIndex:index,visit:state.visit+1}],resolutions:state.resolutions.map((r,i)=>i>=index ? null : r)});
  switch(action.type) {
    case 'start': return state.status==='not_started' ? withState({status:'in_progress',visit:1,stepIds:context.steps.map(step=>step.id),visits:[{stepId,stepIndex:0,visit:1}]}) : failure('forbidden_transition');
    case 'validate': {
      if(state.status!=='in_progress' || current || state.resolutions[state.stepIndex])return failure('forbidden_transition');
      const r=action.result;
      if(typeof action.answer!=='string' || !r || typeof r!=='object' || typeof r.stepId!=='string' || !isPositive(r.visit) || !isPositive(r.attempt) || !['accepted','rejected','unavailable'].includes(r.outcome) || typeof r.feedback!=='string' || (r.reason!==undefined && typeof r.reason!=='string'))return failure('invalid_validation');
      if(r.stepId!==stepId || r.visit!==state.visit || r.attempt!==state.attempt)return failure('identity_mismatch');
      if(r.outcome==='unavailable')return failure('validation_unavailable');
      const entry:ValidationAttempt={stepId,stepIndex:state.stepIndex,visit:state.visit,attempt:state.attempt,answer:action.answer,outcome:r.outcome,feedback:r.feedback,...(r.reason===undefined?{}:{reason:r.reason}),disposition:r.outcome==='accepted'?'accepted':'pending'};
      return withState({history:[...state.history,entry],resolutions:state.resolutions.map((value,i)=>i===state.stepIndex && r.outcome==='accepted'?'passed':value)});
    }
    case 'continue': {
      if(state.status!=='in_progress' || current?.outcome!=='rejected' || current.disposition!=='pending')return failure('forbidden_transition');
      return withState({history:[...state.history.slice(0,-1),{...current,disposition:'continued'}],resolutions:state.resolutions.map((v,i)=>i===state.stepIndex?'accepted_error':v)});
    }
    case 'retry': {
      if(state.attempt===Number.MAX_SAFE_INTEGER)return failure('counter_overflow');
      if(state.status==='failed')return withState({status:'in_progress',attempt:state.attempt+1});
      if(state.status!=='in_progress' || current?.outcome!=='rejected' || current.disposition!=='pending')return failure('forbidden_transition');
      return withState({attempt:state.attempt+1,history:[...state.history.slice(0,-1),{...current,disposition:'retried'}]});
    }
    case 'failure': {
      if(state.status!=='in_progress' || state.resolutions[state.stepIndex] || current || typeof action.reason!=='string' || !action.reason.trim())return failure('forbidden_transition');
      return withState({status:'failed',failures:[...state.failures,{stepId,stepIndex:state.stepIndex,visit:state.visit,attempt:state.attempt,reason:action.reason}]});
    }
    case 'next': return state.status==='in_progress' && !!state.resolutions[state.stepIndex] && state.stepIndex<context.steps.length-1 ? move(state.stepIndex+1) : failure('forbidden_transition');
    case 'back': return state.status==='in_progress' && context.allowBack!==false && state.stepIndex>0 ? move(state.stepIndex-1) : failure('forbidden_transition');
    case 'complete': {
      if(state.status!=='in_progress' || state.stepIndex!==context.steps.length-1 || state.resolutions.some(r=>r===null))return failure('forbidden_transition');
      return withState({status:'completed',completion:state.resolutions.includes('accepted_error')?'completed_with_errors':'passed'});
    }
  }
}

export type WorkerReport = Readonly<{
  totalSteps:number; successfulSteps:number; acceptedErrorSteps:number; validationAttempts:number; rejectedAttempts:number; retries:number;
  steps:readonly Readonly<{stepId:string;stepIndex:number;outcome:StepResolution|null}>[];
  historicalErrors:readonly ValidationAttempt[]; completion:CompletionOutcome|null;
}>;
/** Reports all historical mistakes while using only effective resolutions for the final outcome. */
export function deriveWorkerReport(state:WorkerState,context:WorkerContext):WorkerReport {
  const invalid=stateError(state,context);if(invalid)throw new RangeError(`Invalid Worker report input: ${invalid}`);
  const historicalErrors=state.history.filter(item=>item.outcome==='rejected').map(item=>({...item}));
  return {totalSteps:context.steps.length,successfulSteps:state.resolutions.filter(r=>r==='passed').length,acceptedErrorSteps:state.resolutions.filter(r=>r==='accepted_error').length,validationAttempts:state.history.length,rejectedAttempts:historicalErrors.length,retries:state.history.filter(item=>item.disposition==='retried').length + state.failures.filter(f=>state.status!=='failed' || f.visit!==state.visit || f.attempt!==state.attempt).length,steps:context.steps.map((step,index)=>({stepId:step.id,stepIndex:index,outcome:state.resolutions[index] ?? null})),historicalErrors,completion:state.status==='completed'?state.completion:null};
}
