import { expect, it, vi } from 'vitest';
import type { HistoryEvent } from './conversation-history';
import { applyTopicUpdate, type TopicCandidate, type TopicRecord } from './topic-memory';
import { assessTopicCandidate, validateTopicAssessment, type SemanticAssessment } from './topic-semantic';

const message=(text:string,role:'user'|'assistant'='user',session='s'):HistoryEvent=>({id:'event',sessionId:session,sequence:4,type:'message',payload:{id:'m',conversationId:session,runId:'r',createdAt:1,role,type:'text',text}});
const candidate=(text:string,role:'user'|'assistant'='user'):TopicCandidate=>({key:'November 2 meeting',value:'16:00',status:'confirmed',sources:['m'],evidence:[{messageId:'m',role,sequence:4,quote:text,existence:'verified'}],assessment:{support:'unverified',change:'unverified'}});
const current:TopicRecord={key:'November 2 meeting',value:'13:00',status:'confirmed',sources:['old'],archiveSequence:2,history:[]};
const model=(result:SemanticAssessment)=>({context:{assess:async()=>({tokens:10,limit:10000}),summarize:async()=>''},complete:vi.fn(async()=>({text:JSON.stringify(result)}))});
const result=(text:string,classification:SemanticAssessment['classification'],factSupported:boolean,changeConfirmed:boolean):SemanticAssessment=>({classification,factSupported,changeConfirmed,evidence:[{messageId:'m',quote:text}]});

it.each([
  ['Maybe we should move the meeting to 16:00.','proposal',true,false,'defer'],
  ['Actually, the meeting was always scheduled for 16:00.','correction',true,true,'defer'],
  ["Let's move that meeting.",'ambiguous',true,false,'defer'],
  ['Hi.','noise',false,false,'reject'],
  ['Thanks.','noise',false,false,'reject'],
  ['Okay.','noise',false,false,'reject'],
  ['The meeting is at 16:00.','fact',false,false,'reject'],
] as const)('applies the deterministic policy to mocked classification of %s',async(text,classification,supported,confirmed,expected)=>{
  const events=[message(text)];const proposed=candidate(text);const semantic=await assessTopicCandidate(model(result(text,classification,supported,confirmed)),'s',events,proposed,current);
  expect(validateTopicAssessment('s',events,proposed,semantic,current).decision).toBe(expected);
});

it.each([
  ['We agreed to move the meeting from 13:00 to 16:00.','change'],
  ['Cancel our November 2 meeting.','cancellation'],
  ['The meeting is canceled.','cancellation'],
] as const)('accepts a supported identified user change: %s',async(text,classification)=>{
  const events=[message(text)];const proposed={...candidate(text),value:classification==='cancellation'?'canceled':'16:00'};
  const semantic=await assessTopicCandidate(model(result(text,classification,true,true)),'s',events,proposed,current);
  expect(validateTopicAssessment('s',events,proposed,semantic).decision).toBe('defer');
  const decision=validateTopicAssessment('s',events,proposed,semantic,current);expect(decision.decision).toBe('accept');
  if(decision.decision==='accept'){
    expect(decision.update.archiveSequence).toBeNull();
    const archive={sessionId:'s',events};const updated=applyTopicUpdate([current],decision.update,archive);expect(updated[0].value).toBe(proposed.value);expect(updated[0].history).toHaveLength(1);
    expect(applyTopicUpdate(updated,decision.update,archive)).toEqual(updated);
  }
});

it('allows assistant topic information as uncertain but never as user-confirmed change',()=>{
  const text='The meeting is at 16:00.';const events=[message(text,'assistant')];const proposed=candidate(text,'assistant');
  const fact=validateTopicAssessment('s',events,proposed,result(text,'fact',true,false));
  expect(fact.decision).toBe('accept');if(fact.decision==='accept')expect(fact.update.candidate.status).toBe('uncertain');
  expect(validateTopicAssessment('s',events,proposed,result(text,'change',true,true),current).decision).toBe('defer');
});

it('rejects unsupported quotations, forged sources and cross-session context',()=>{
  const text='The meeting is at 16:00.';const events=[message(text)];const proposed=candidate(text);
  expect(validateTopicAssessment('s',events,proposed,result('fabricated quote','change',true,true),current).decision).toBe('reject');
  expect(validateTopicAssessment('s',events,{...proposed,sources:['other']},result(text,'change',true,true),current).decision).toBe('reject');
  expect(()=>validateTopicAssessment('another',events,proposed,result(text,'fact',true,false))).toThrow('another session');
  expect(()=>applyTopicUpdate([],{action:'new',candidate:{...proposed,evidence:[],assessment:{support:'supported',change:'confirmed'}},archiveSequence:null},{sessionId:'s',events})).toThrow('valid source evidence');
});

it('rejects malformed model output and avoids dispatch when over budget',async()=>{
  const text='Hi.';const events=[message(text)];const proposed=candidate(text);
  const invalid={context:{assess:async()=>({tokens:10,limit:100}),summarize:async()=>''},complete:async()=>({text:'not json'})};
  await expect(assessTopicCandidate(invalid,'s',events,proposed)).rejects.toThrow('invalid JSON');
  const complete=vi.fn();await expect(assessTopicCandidate({complete,context:{assess:async()=>({tokens:101,limit:100}),summarize:async()=>''}},'s',events,proposed)).rejects.toThrow('input budget');expect(complete).not.toHaveBeenCalled();
});
