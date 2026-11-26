import { describe, expect, it } from 'vitest';
import { initialWorkerV2State, transitionWorkerV2, workerV2EvaluationEvidence, workerWorkflowVersion, type V2Action, type V2Context, type V2Evaluation, type V2State } from './worker-state-machine-v2';
import { initialWorkerState, transition } from './worker-state-machine';
import { replayWorkerEvents } from './worker-event-replay';

const context:V2Context={workflowVersion:2,sessionId:'session-1',steps:[{id:'q',type:'question',prompt:'Language?',options:[{id:'a',text:'Java'},{id:'b',text:'Rust'}]},{id:'task',type:'action',prompt:'Inspect'}]};
const apply=(s:V2State,a:V2Action,c=context)=>{const result=transitionWorkerV2(s,a,c);if(!result.ok)throw Error(result.error);return result.state;};
const start=()=>apply(initialWorkerV2State(context),{type:'start'});
const question=(s:V2State):V2Action=>({type:'submit',stepId:'q',visit:s.visit,result:{type:'question',optionId:'b'}});
const task=(s:V2State):V2Action=>({type:'submit',stepId:'task',visit:s.visit,result:{type:'action',status:'completed'}});
function ready(){let s=start();s=apply(s,question(s));s=apply(s,{type:'next'});return apply(s,task(s));}
function evaluation(s:V2State,errors=false):V2Evaluation {const binding=workerV2EvaluationEvidence(s,context);if(!binding.ok)throw Error(binding.error);return {schemaVersion:1,...binding,success:!errors,reason:errors?'Issues found':'Excellent work',errorCount:errors?1:0,findings:[{stepId:'q',passed:!errors,reason:errors?'Incorrect':'Correct',evidence:'Rust'},{stepId:'task',passed:true,reason:'Completed',evidence:'Completed'}]};}
// Strip the binding's discriminant before submitting the strict evaluator shape.
function verdict(s:V2State,errors=false):V2Evaluation {const {ok:_,...rest}=evaluation(s,errors) as V2Evaluation & {ok?:boolean};return rest;}

describe('V2 collection and completion',()=>{
 it('starts and collects a question without judging it',()=>{const s=apply(start(),{type:'submit',stepId:'q',visit:1,result:{type:'question',optionId:'b'}});expect(s.results[0]?.result).toEqual({type:'question',optionId:'b'});expect(s.evaluation).toBeNull();expect(s.stepIndex).toBe(0);});
 it('rejects missing results, invalid options, wrong step, visit and duplicate submissions',()=>{const s=start();expect(transitionWorkerV2(s,{type:'next'},context).ok).toBe(false);for(const a of [{type:'submit',stepId:'q',visit:1,result:{type:'question',optionId:'x'}},{type:'submit',stepId:'wrong',visit:1,result:{type:'question',optionId:'a'}},{type:'submit',stepId:'q',visit:2,result:{type:'question',optionId:'a'}}] as V2Action[])expect(transitionWorkerV2(s,a,context).ok).toBe(false);const submitted=apply(s,question(s));expect(transitionWorkerV2(submitted,question(submitted),context).ok).toBe(false);});
 it('accepts an action problem as evidence and requires a reason',()=>{let s=start();s=apply(s,question(s));s=apply(s,{type:'next'});const bad={type:'submit',stepId:'task',visit:s.visit,result:{type:'action',status:'problem',reason:''}} as V2Action;expect(transitionWorkerV2(s,bad,context).ok).toBe(false);s=apply(s,{type:'submit',stepId:'task',visit:s.visit,result:{type:'action',status:'problem',reason:'Damaged beans'}});expect(s.status).toBe('in_progress');expect(s.results[1]?.result).toMatchObject({status:'problem'});});
 it('supports explicit correction and preserves prior submissions',()=>{let s=start();s=apply(s,question(s));s=apply(s,{type:'correct',stepId:'q',visit:s.visit,result:{type:'question',optionId:'a'}});expect(s.submissions).toHaveLength(2);expect(s.attempt).toBe(2);expect(s.results[0]?.result).toMatchObject({optionId:'a'});});
 it('backs up with a new visit, invalidates later results and retains history',()=>{let s=ready();const before=workerV2EvaluationEvidence(s,context);s=apply(s,{type:'back'});expect(s.results).toEqual([null,null]);expect(s.submissions).toHaveLength(2);expect(s.visit).toBe(3);expect(transitionWorkerV2(s,{type:'next'},context).ok).toBe(false);expect(before.ok).toBe(true);});
 it('respects the navigation policy',()=>{const c={...context,allowBack:false};let s=apply(initialWorkerV2State(c),{type:'start'},c);s=apply(s,question(s),c);s=apply(s,{type:'next'},c);expect(transitionWorkerV2(s,{type:'back'},c).ok).toBe(false);});
 it.each([false,true])('records final evaluation and completes, errors=%s',errors=>{let s=ready();expect(transitionWorkerV2(s,{type:'next'},context).ok).toBe(false);expect(transitionWorkerV2(s,{type:'complete'},context).ok).toBe(false);s=apply(s,{type:'evaluate',evaluation:verdict(s,errors)});s=apply(s,{type:'complete'});expect(s.completion).toBe(errors?'completed_with_errors':'passed');for(const action of [{type:'start'},{type:'next'},{type:'back'},{type:'retry'},{type:'complete'},{type:'evaluate',evaluation:verdict(ready())}] as V2Action[])expect(transitionWorkerV2(s,action,context).ok).toBe(false);});
 it('rejects stale, malformed and contradictory evaluations',()=>{const s=ready(),v=verdict(s);for(const x of [{...v,sourceRevision:v.sourceRevision-1},{...v,sessionId:'other'},{...v,findings:[]},{...v,errorCount:1},{...v,success:false},{...v,findings:[{...v.findings[0],stepId:'task'},v.findings[1]]},{...v,findings:[{...v.findings[0],evidence:'invented'},v.findings[1]]}])expect(transitionWorkerV2(s,{type:'evaluate',evaluation:x},context).ok).toBe(false);});
 it('rejects a captured evaluation after Back and recollection',()=>{let s=ready();const old=verdict(s);s=apply(s,{type:'back'});s=apply(s,question(s));s=apply(s,{type:'next'});s=apply(s,task(s));expect(transitionWorkerV2(s,{type:'evaluate',evaluation:old},context)).toEqual({ok:false,error:'stale_evidence'});});
 it('does not mutate state for technical unavailability',()=>{const s=ready(),before=JSON.stringify(s);expect(transitionWorkerV2(s,{type:'validation_unavailable'},context)).toEqual({ok:false,error:'validation_unavailable'});expect(JSON.stringify(s)).toBe(before);});
 it('permits trusted execution failure and explicit recovery',()=>{let s=start();s=apply(s,{type:'failure',reason:'Tool unavailable'});expect(s.status).toBe('failed');s=apply(s,{type:'retry'});expect(s.status).toBe('in_progress');expect(s.attempt).toBe(2);});
 it('rejects corrupted projection and changed context',()=>{const s=ready();expect(transitionWorkerV2({...s,visit:99},{type:'complete'},context).ok).toBe(false);expect(transitionWorkerV2(s,{type:'evaluate',evaluation:verdict(s)},{...context,steps:[{...context.steps[0],prompt:'Changed'},context.steps[1]]})).toEqual({ok:false,error:'invalid_state'});});
});

describe('V1 compatibility and generated sequences',()=>{
 it('defaults missing discriminator to V1 and keeps V1 replay separate',()=>{expect(workerWorkflowVersion(undefined)).toBe(1);expect(workerWorkflowVersion(2)).toBe(2);expect(workerWorkflowVersion(3)).toBeNull();expect(transition(initialWorkerState(1),{type:'start'},{steps:[{id:'one'}]}).ok).toBe(true);expect(replayWorkerEvents({sessionId:'session-1',snapshot:{id:'t',name:'T',description:'',rules:'',version:1,document:{schemaVersion:2,steps:[]}}},[]).ok).toBe(false);});
 it('checks deterministic state, rejected immutability and terminal behavior across generated paths',()=>{let evaluated=0;for(let mask=0;mask<32;mask++){let s=start();for(let i=0;i<5;i++){const before=JSON.stringify(s);const a:V2Action=(mask>>i)&1?{type:'next'}:{type:'submit',stepId:'q',visit:s.visit,result:{type:'question',optionId:'b'}};const result=transitionWorkerV2(s,a,context);expect(result).toEqual(transitionWorkerV2(s,a,context));expect(JSON.stringify(s)).toBe(before);if(result.ok)s=result.state;evaluated++;}expect(transitionWorkerV2(s,{type:'start'},context).ok).toBe(false);}expect(evaluated).toBe(160);});
 it('preserves invariants through reproducible multi-step action sequences',()=>{
  let checks=0;
  for(let seed=1;seed<=64;seed++){
   let s=initialWorkerV2State(context), random=seed;
   for(let turn=0;turn<32;turn++){
    random=(Math.imul(random,1664525)+1013904223)>>>0;
    const step=context.steps[s.stepIndex], sub:V2Action={type:'submit',stepId:step.id,visit:s.visit,result:step.type==='question'?{type:'question',optionId:'a'}:{type:'action',status:'completed'}};
    const binding=workerV2EvaluationEvidence(s,context);
    const candidates:V2Action[]=[{type:'start'},sub,{type:'next'},{type:'back'},{type:'failure',reason:'offline'},{type:'retry'},{type:'complete'},{type:'validation_unavailable'}];
    if(binding.ok)candidates.push({type:'evaluate',evaluation:verdict(s,seed%2===0)});
    const action=candidates[random%candidates.length],before=JSON.stringify(s), result=transitionWorkerV2(s,action,context);
    expect(JSON.stringify(s)).toBe(before);
    expect(result).toEqual(transitionWorkerV2(s,action,context));
    if(result.ok){s=result.state;expect(transitionWorkerV2(s,{type:'unknown'} as never,context)).toEqual({ok:false,error:s.status==='completed'?'forbidden_transition':'invalid_action'});}
    checks++;
   }
  }
  expect(checks).toBe(2048);
 });
});

describe('non-finite and malformed numeric evidence',()=>{
 it.each([Infinity,-Infinity,NaN,JSON.parse('1e400')])('never advances without a submission for %s',value=>{
  const s=start(), forged={...s,results:[value,null]} as unknown as V2State;
  const before=structuredClone(forged);
  expect(transitionWorkerV2(forged,{type:'next'},context)).toEqual({ok:false,error:'invalid_state'});
  expect(workerV2EvaluationEvidence(forged,context)).toEqual({ok:false,error:'invalid_state'});
  expect(forged).toEqual(before);
 });
 it.each([Infinity,-Infinity,NaN,JSON.parse('1e400')])('never completes without an evaluation for %s',value=>{
  const s=start(), forged={...s,evaluation:value} as unknown as V2State;
  const before=structuredClone(forged);
  expect(transitionWorkerV2(forged,{type:'complete'},context)).toEqual({ok:false,error:'invalid_state'});
  expect(forged).toEqual(before);
 });
 it('rejects overflow parsed within otherwise valid JSON state',()=>{
  const raw=JSON.stringify(start());
  for(const [field,action] of [['"evaluation":null',{type:'complete'}],['"results":[null,null]',{type:'next'}]] as const){
   const replacement=field.startsWith('"evaluation"')?'"evaluation":1e400':'"results":[1e400,null]';
   const forged=JSON.parse(raw.replace(field,replacement)) as V2State;
   expect(transitionWorkerV2(forged,action,context)).toEqual({ok:false,error:'invalid_state'});
  }
 });
 it('rejects invalid revision, index, visit and attempt counters deterministically',()=>{
  const s=start(), bad=[NaN,Infinity,-Infinity,Number.MAX_SAFE_INTEGER+1,-1,0.5];
  for(const key of ['revision','stepIndex','visit','attempt'] as const)for(const value of bad){
   const forged={...s,[key]:value};
   expect(transitionWorkerV2(forged,{type:'next'},context)).toEqual({ok:false,error:'invalid_state'});
   expect(workerV2EvaluationEvidence(forged,context)).toEqual({ok:false,error:'invalid_state'});
  }
  for(const key of ['revision','attempt'] as const)expect(transitionWorkerV2({...s,[key]:0},{type:'next'},context)).toEqual({ok:false,error:'invalid_state'});
 });
 it('rejects malformed identities and nested numeric values without normalizing them',()=>{
  const s=ready(), binding=verdict(s);
  for(const value of [NaN,Infinity,-Infinity,Number.MAX_SAFE_INTEGER+1]){
   expect(transitionWorkerV2(s,{type:'evaluate',evaluation:{...binding,sourceRevision:value}},context).ok).toBe(false);
   const forged={...s,results:[{...s.results[0]!,visit:value},s.results[1]]};
   expect(transitionWorkerV2(forged,{type:'evaluate',evaluation:binding},context)).toEqual({ok:false,error:'invalid_state'});
  }
  expect(transitionWorkerV2(s,{type:'evaluate',evaluation:{...binding,evidence:'invalid'}},context)).toEqual({ok:false,error:'stale_evidence'});
 });
 it('does not accept sparse arrays or undefined as null result evidence',()=>{
  const s=start(), sparse=new Array(2), absent={...s,results:[undefined,null]} as unknown as V2State;
  expect(transitionWorkerV2({...s,results:sparse},{type:'next'},context)).toEqual({ok:false,error:'invalid_state'});
  expect(transitionWorkerV2(absent,{type:'next'},context)).toEqual({ok:false,error:'invalid_state'});
 });
});
