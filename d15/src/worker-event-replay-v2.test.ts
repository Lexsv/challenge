import { describe,expect,it } from 'vitest';
import { initialWorkerV2State, transitionWorkerV2, workerV2EvaluationEvidence, type V2Action, type V2Context, type V2State } from './worker-state-machine-v2';
import { encodeWorkerV2Event, replayWorkerV2Events, verifyWorkerV2Projection, type V2Event } from './worker-event-replay-v2';

const context:V2Context={workflowVersion:2,sessionId:'session-1',steps:[{id:'q1',type:'question',prompt:'Which?',options:[{id:'a',text:'Java'},{id:'b',text:'Rust'}]},{id:'a1',type:'action',prompt:'Inspect'}]};
function run(actions:V2Action[]){let state=initialWorkerV2State(context);const events:V2Event[]=[];for(const action of actions){const event=encodeWorkerV2Event(context,state,`request-${events.length+1}`,events.length+1,action);if(!event.ok)throw Error(event.error);events.push(event.data);const next=transitionWorkerV2(state,action,context);if(!next.ok)throw Error(next.error);state=next.state;}return {state,events};}
const actions:V2Action[]=[{type:'start'},{type:'submit',stepId:'q1',visit:1,result:{type:'question',optionId:'b'}},{type:'next'},{type:'submit',stepId:'a1',visit:2,result:{type:'action',status:'problem',reason:'Damaged'}},{type:'back'},{type:'submit',stepId:'q1',visit:3,result:{type:'question',optionId:'a'}},{type:'next'},{type:'submit',stepId:'a1',visit:4,result:{type:'action',status:'completed'}}];
function evaluated(s:V2State):V2Action {const binding=workerV2EvaluationEvidence(s,context);if(!binding.ok)throw Error(binding.error);return {type:'evaluate',evaluation:{schemaVersion:1,sessionId:binding.sessionId,sourceRevision:binding.sourceRevision,evidence:binding.evidence,success:false,reason:'First answer is incorrect.',errorCount:1,findings:[{stepId:'q1',passed:false,reason:'Incorrect',evidence:'Java'},{stepId:'a1',passed:true,reason:'Completed',evidence:'Completed'}]}};}

describe('V2 event replay',()=>{
 it('reconstructs empty sessions at revision one',()=>expect(replayWorkerV2Events(context,[])).toEqual({ok:true,data:initialWorkerV2State(context)}));
 it('reconstructs visits, invalidated results, history, evaluation and completion',()=>{
  const initial=run(actions), complete=run([...actions,evaluated(initial.state),{type:'complete'}]);
  expect(replayWorkerV2Events(context,complete.events)).toEqual({ok:true,data:complete.state});
  expect(complete.state.completion).toBe('completed_with_errors');
  expect(complete.state.submissions).toHaveLength(4);
  expect(verifyWorkerV2Projection(complete.state,{state:'completed',stepIndex:1,attempt:1,revision:complete.state.revision})).toEqual({ok:true,data:true});
 });
 it('rejects duplicate, reordered, missing, tampered and foreign events',()=>{
  const {events}=run(actions);
  for(const corrupt of [[events[0],events[0]],[events[1],events[0]],[events[0],events[2]],[{...events[0],sessionId:'other'}],[{...events[0],stepId:'wrong'}],[{...events[0],resultingRevision:Infinity}],[{...events[0],schemaVersion:1}],[{...events[0],resultingState:'completed',completion:'passed'}]])expect(replayWorkerV2Events(context,corrupt).ok).toBe(false);
 });
 it('rejects projection mismatch and does not mutate inputs',()=>{
  const {state,events}=run(actions),before=structuredClone({context,events});
  expect(verifyWorkerV2Projection(state,{state:state.status,stepIndex:0,attempt:1,revision:state.revision})).toEqual({ok:false,error:'projection_mismatch'});
  expect(replayWorkerV2Events(context,events)).toEqual(replayWorkerV2Events(context,events));expect({context,events}).toEqual(before);
 });
 it('rejects an action after terminal completion',()=>{
  const started=run(actions), complete=run([...actions,evaluated(started.state),{type:'complete'}]);
  expect(encodeWorkerV2Event(context,complete.state,'extra',complete.state.revision,{type:'back'})).toEqual({ok:false,error:'invalid_transition'});
 });
});
