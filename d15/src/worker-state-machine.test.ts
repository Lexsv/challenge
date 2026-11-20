import { describe, expect, it } from 'vitest';
import { deriveWorkerReport, initialWorkerState, transition, type WorkerAction, type WorkerContext, type WorkerState } from './worker-state-machine';

const context:WorkerContext={steps:[{id:'one'},{id:'two'},{id:'three'}]};
const apply=(state:WorkerState,action:WorkerAction,ctx=context):WorkerState=>{const result=transition(state,action,ctx);if(!result.ok)throw Error(result.error);return result.state;};
const validate=(state:WorkerState,outcome:'accepted'|'rejected'|'unavailable',ctx=context):WorkerAction=>({type:'validate',answer:'answer',result:{stepId:ctx.steps[state.stepIndex].id,visit:state.visit,attempt:state.attempt,outcome,feedback:outcome}});
const started=()=>apply(initialWorkerState(3),{type:'start'});
const finish=(s:WorkerState)=>{let state=s;while(state.stepIndex<2){state=apply(state,validate(state,'accepted'));state=apply(state,{type:'next'});}state=apply(state,validate(state,'accepted'));return apply(state,{type:'complete'});};

describe('Worker state machine',()=>{
 it('starts once and completes successfully with all steps resolved',()=>{const s=started();expect(transition(s,{type:'start'},context)).toEqual({ok:false,error:'forbidden_transition'});const done=finish(s);expect(done.status).toBe('completed');expect(done.completion).toBe('passed');expect(deriveWorkerReport(done,context)).toMatchObject({totalSteps:3,successfulSteps:3,acceptedErrorSteps:0,validationAttempts:3,rejectedAttempts:0,retries:0});});
 it('forbids every action after completion',()=>{const done=finish(started());for(const action of [{type:'start'},{type:'next'},{type:'back'},{type:'retry'},{type:'continue'},{type:'complete'},{type:'failure',reason:'x'},validate(done,'accepted')] as WorkerAction[])expect(transition(done,action,context)).toEqual({ok:false,error:'forbidden_transition'});});
 it('retains rejected attempts after retry and passes without a final error',()=>{let s=started();s=apply(s,validate(s,'rejected'));expect(transition(s,{type:'next'},context).ok).toBe(false);s=apply(s,{type:'retry'});expect(s.attempt).toBe(2);s=finish(s);const report=deriveWorkerReport(s,context);expect(report).toMatchObject({completion:'passed',rejectedAttempts:1,retries:1,successfulSteps:3,acceptedErrorSteps:0});expect(report.historicalErrors[0]).toMatchObject({answer:'answer',disposition:'retried',feedback:'rejected'});});
 it('continues explicitly after rejection and reports multiple accepted errors',()=>{let s=started();for(let i=0;i<3;i++){s=apply(s,validate(s,i<2?'rejected':'accepted'));if(i<2){expect(transition(s,{type:'next'},context).ok).toBe(false);s=apply(s,{type:'continue'});}if(i<2)s=apply(s,{type:'next'});}s=apply(s,{type:'complete'});expect(deriveWorkerReport(s,context)).toMatchObject({completion:'completed_with_errors',successfulSteps:1,acceptedErrorSteps:2,rejectedAttempts:2,retries:0});});
 it('counts multiple retries and preserves every answer',()=>{let s=started();for(let i=0;i<3;i++){s=apply(s,validate(s,'rejected'));s=apply(s,{type:'retry'});}s=finish(s);expect(deriveWorkerReport(s,context)).toMatchObject({validationAttempts:6,rejectedAttempts:3,retries:3,completion:'passed'});});
 it('does not consume an attempt or record unavailable validation',()=>{const s=started();expect(transition(s,validate(s,'unavailable'),context)).toEqual({ok:false,error:'validation_unavailable'});expect(s.attempt).toBe(1);expect(s.history).toHaveLength(0);expect(transition(s,{type:'next'},context).ok).toBe(false);});
 it('allows Back by default and invalidates revisited and later evidence',()=>{let s=started();s=apply(s,validate(s,'accepted'));s=apply(s,{type:'next'});s=apply(s,validate(s,'accepted'));s=apply(s,{type:'next'});s=apply(s,{type:'back'});expect(s.resolutions).toEqual(['passed',null,null]);expect(s.visit).toBe(4);expect(s.history).toHaveLength(2);expect(transition(s,{type:'next'},context).ok).toBe(false);s=apply(s,{type:'back'});expect(s.resolutions).toEqual([null,null,null]);expect(transition(s,{type:'complete'},context).ok).toBe(false);});
 it('forbids Back under template policy',()=>{let s=started();s=apply(s,validate(s,'accepted'));s=apply(s,{type:'next'});expect(transition(s,{type:'back'},{...context,allowBack:false}).ok).toBe(false);});
 it('separates execution failure from domain rejection and recovers explicitly',()=>{let s=started();s=apply(s,{type:'failure',reason:'tool unavailable'});expect(s.status).toBe('failed');expect(transition(s,{type:'next'},context).ok).toBe(false);s=apply(s,{type:'retry'});expect(s.status).toBe('in_progress');expect(s.attempt).toBe(2);expect(deriveWorkerReport(s,context).retries).toBe(1);});
 it('rejects invalid index, malformed or stale validation and unsupported actions',()=>{const s=started();expect(transition({...s,stepIndex:3},{type:'next'},context)).toEqual({ok:false,error:'invalid_state'});expect(transition(s,{type:'unknown'} as never,context)).toEqual({ok:false,error:'invalid_action'});expect(transition(s,{type:'validate',answer:'x',result:{stepId:'one',visit:1,attempt:1,outcome:'other',feedback:''}} as never,context)).toEqual({ok:false,error:'invalid_validation'});expect(transition(s,{type:'validate',answer:'x',result:{stepId:'two',visit:1,attempt:1,outcome:'accepted',feedback:''}},context)).toEqual({ok:false,error:'identity_mismatch'});expect(transition(s,{type:'validate',answer:'x',result:{stepId:'one',visit:1,attempt:2,outcome:'accepted',feedback:''}},context)).toEqual({ok:false,error:'identity_mismatch'});});
 it('is deterministic and never mutates inputs',()=>{const s=started();const a=validate(s,'rejected');const before=JSON.stringify({s,a,context});expect(transition(s,a,context)).toEqual(transition(s,a,context));expect(JSON.stringify({s,a,context})).toBe(before);});
});

describe('untrusted state boundaries',()=>{
 it('rejects changed context, fabricated resolutions, and changed visits',()=>{
  let s=started();s=apply(s,validate(s,'accepted'));
  expect(transition(s,{type:'next'},{steps:[{id:'changed'},{id:'two'},{id:'three'}]})).toEqual({ok:false,error:'identity_mismatch'});
  expect(transition({...started(),resolutions:['passed',null,null]},{type:'next'},context).ok).toBe(false);
  expect(transition({...s,visits:[{...s.visits[0],stepId:'wrong'}]},{type:'next'},context).ok).toBe(false);
  expect(transition({...s,resolutions:['bogus',null,null]} as never,{type:'next'},context).ok).toBe(false);
 });
 it('rejects stale evidence after Back without erasing history',()=>{
  let s=started();s=apply(s,validate(s,'accepted'));s=apply(s,{type:'next'});s=apply(s,validate(s,'accepted'));s=apply(s,{type:'back'});
  const forged={...s,resolutions:['passed','passed',null] as const};
  expect(transition(forged,{type:'next'},context).ok).toBe(false);
  expect(s.history).toHaveLength(2);
 });
 it('rejects malformed, incomplete, mismatched and inconsistent attempt history',()=>{
  const s=started();
  for(const history of [[null],[{}],[{stepId:'one'}],[{stepId:'wrong',stepIndex:0,visit:1,attempt:1,answer:'x',outcome:'accepted',feedback:'',disposition:'accepted'}],[{stepId:'one',stepIndex:0,visit:1,attempt:2,answer:'x',outcome:'accepted',feedback:'',disposition:'accepted'}],[{stepId:'one',stepIndex:0,visit:1,attempt:1,answer:'x',outcome:'bogus',feedback:'',disposition:'accepted'}]]){
   const input={...s,history} as never;
   expect(()=>transition(input,{type:'failure',reason:'test'},context)).not.toThrow();
   expect(transition(input,{type:'failure',reason:'test'},context).ok).toBe(false);
   expect(()=>deriveWorkerReport(input,context)).toThrow(RangeError);
  }
 });
 it('rejects unsafe counters and sparse or undefined steps without throwing',()=>{
  const s=started();
  for(const n of [-1,0.5,Number.MAX_SAFE_INTEGER+1])expect(transition({...s,attempt:n},{type:'retry'},context).ok).toBe(false);
  expect(transition({...s,attempt:Number.MAX_SAFE_INTEGER,status:'failed'},{type:'retry'},context)).toEqual({ok:false,error:'counter_overflow'});
  for(const steps of [new Array(1),[undefined]]){const ctx={steps} as never;expect(()=>transition(initialWorkerState(1),{type:'start'},ctx)).not.toThrow();expect(transition(initialWorkerState(1),{type:'start'},ctx).ok).toBe(false);expect(()=>deriveWorkerReport(initialWorkerState(1),ctx)).toThrow(RangeError);}
 });
 it('returns deterministic errors for identical malformed inputs',()=>{const s={...started(),history:[null]} as never;expect(transition(s,{type:'next'},context)).toEqual(transition(s,{type:'next'},context));});
});

describe('state consistency and reachable transitions',()=>{
  const one:WorkerContext={steps:[{id:'one'}]};
  const oneStart=()=>apply(initialWorkerState(1),{type:'start'},one);
  it('rejects approval attached to a changed active attempt',()=>{
    const s=oneStart(),approved=apply(s,validate(s,'accepted',one),one),forged={...approved,attempt:2};
    expect(transition(forged,{type:'complete'},one).ok).toBe(false);
    expect(()=>deriveWorkerReport(forged,one)).toThrow(RangeError);
  });
  it('rejects missing failure evidence, unconsumed failures and fabricated retries',()=>{
    const s=oneStart(),failure=apply(s,{type:'failure',reason:'offline'},one);
    for(const invalid of [{...s,status:'failed' as const},{...failure,status:'in_progress' as const}]){
      expect(transition(invalid,validate(invalid,'accepted',one),one).ok).toBe(false);
      expect(()=>deriveWorkerReport(invalid,one)).toThrow(RangeError);
    }
    const rejected=apply(s,validate(s,'rejected',one),one);
    const forged={...rejected,history:[{...rejected.history[0],disposition:'retried' as const}]};
    expect(transition(forged,{type:'retry'},one).ok).toBe(false);
    expect(()=>deriveWorkerReport(forged,one)).toThrow(RangeError);
  });
  it('recovers from repeated failures and preserves valid reports',()=>{
    let s=oneStart();for(let i=0;i<3;i++){s=apply(s,{type:'failure',reason:`failure ${i}`},one);s=apply(s,{type:'retry'},one);expect(()=>deriveWorkerReport(s,one)).not.toThrow();}
    s=apply(s,validate(s,'accepted',one),one);s=apply(s,{type:'complete'},one);
    expect(deriveWorkerReport(s,one)).toMatchObject({completion:'passed',retries:3});
  });
  it('revalidates a revisited step after rejection and retry',()=>{
    let s=started();s=apply(s,validate(s,'accepted'));s=apply(s,{type:'next'});s=apply(s,validate(s,'accepted'));s=apply(s,{type:'back'});
    s=apply(s,validate(s,'rejected'));const earlier=JSON.stringify(s.history);s=apply(s,{type:'retry'});expect(JSON.parse(earlier).at(-1).disposition).toBe('pending');
    s=apply(s,validate(s,'accepted'));s=apply(s,{type:'next'});s=apply(s,validate(s,'accepted'));s=apply(s,{type:'next'});s=apply(s,validate(s,'accepted'));s=apply(s,{type:'complete'});
    expect(deriveWorkerReport(s,context)).toMatchObject({completion:'passed',rejectedAttempts:1,retries:1});
  });
  it('generates deterministic multi-step sequences and checks every accepted output',()=>{
    let seed=92713;const random=()=>{seed=(seed*1664525+1013904223)>>>0;return seed;};let evaluations=0,successes=0;
    for(let sequence=0;sequence<150;sequence++){
      let state=initialWorkerState(3);
      for(let depth=0;depth<60;depth++){
        const a:WorkerAction[]=[{type:'start'},{type:'next'},{type:'back'},{type:'retry'},{type:'continue'},{type:'complete'},{type:'failure',reason:'tool failed'},validate(state,'accepted'),validate(state,'rejected'),validate(state,'unavailable')];
        const action=a[random()%a.length], before=JSON.stringify(state),result=transition(state,action,context);evaluations++;
        expect(JSON.stringify(state)).toBe(before);expect(transition(state,action,context)).toEqual(result);
        if(result.ok){successes++;expect(()=>deriveWorkerReport(result.state,context)).not.toThrow();state=result.state;}
        if(state.status==='completed')for(const terminal of a)expect(transition(state,terminal,context).ok).toBe(false);
      }
    }
    expect(evaluations).toBe(9000);expect(successes).toBeGreaterThan(100);
  });
});
