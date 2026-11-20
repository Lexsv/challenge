import { describe, expect, it } from 'vitest';
import { mapTopicAssessment, type AssessmentMapperInput } from './assessment-mapper';
import type { HistoryEvent } from './conversation-history';
import type { TopicCandidate, TopicRecord } from './topic-memory';
import type { SemanticAssessment } from './topic-semantic';

const text='We agreed to move the meeting from 13:00 to 16:00.';
const event:HistoryEvent={id:'e',sessionId:'s',sequence:4,type:'message',payload:{id:'m',conversationId:'s',runId:'r',createdAt:1,role:'user',type:'text',text}};
const candidate:TopicCandidate={key:'Meeting',value:'16:00',status:'confirmed',sources:['m'],evidence:[{messageId:'m',role:'user',sequence:4,quote:text,existence:'verified'}],assessment:{support:'unverified',change:'unverified'}};
const assessment:SemanticAssessment={classification:'change',factSupported:true,changeConfirmed:true,evidence:[{messageId:'m',quote:text}]};
const current:TopicRecord & {revision:number}={key:'Meeting',value:'13:00',status:'confirmed',revision:1,sources:['old'],archiveSequence:null,history:[]};
const base:AssessmentMapperInput={sessionId:'s',events:[event],candidate,recommendation:{action:'UPDATE',targetKey:'Meeting',proposedContent:'16:00',reason:'Change'},assessment,existingTopics:[current]};

describe('isolated topic assessment mapper',()=>{
  it('maps a supported ADD without creating evidence or granting an update',()=>{
    const result=mapTopicAssessment({...base,existingTopics:[],recommendation:{action:'ADD',proposedContent:'16:00',reason:'New'},assessment:{...assessment,classification:'fact',changeConfirmed:false}});
    expect(result).toEqual({decision:'proposal',candidate,assessment:{...assessment,classification:'fact',changeConfirmed:false}});
  });
  it('maps an evidenced confirmed UPDATE as a proposal with the original identity and sources',()=>{
    const before=structuredClone(base);const result=mapTopicAssessment(base);
    expect(result).toEqual({decision:'proposal',candidate,assessment,targetKey:'Meeting'});expect(base).toEqual(before);
    if(result.decision==='proposal'){expect(result.candidate.evidence).toEqual(candidate.evidence);expect(result.candidate.status).toBe(candidate.status);expect(result.candidate).not.toBe(candidate);}
  });
  it('defers unconfirmed, ambiguous, assistant-only and historically corrected updates',()=>{
    for(const variation of [{...assessment,changeConfirmed:false},{...assessment,classification:'ambiguous' as const},{...assessment,classification:'correction' as const},{...assessment,classification:'fact' as const}])expect(mapTopicAssessment({...base,assessment:variation})).toMatchObject({decision:'defer'});
    const assistantEvent:HistoryEvent={...event,payload:{...event.payload,role:'assistant'}} as HistoryEvent;
    const assistantCandidate:TopicCandidate={...candidate,evidence:[{...candidate.evidence[0],role:'assistant'}]};
    expect(mapTopicAssessment({...base,events:[assistantEvent],candidate:assistantCandidate})).toMatchObject({decision:'defer'});
  });
  it('rejects unsupported content and invalid targets; defers mismatched value or identity',()=>{
    expect(mapTopicAssessment({...base,assessment:{...assessment,factSupported:false}})).toMatchObject({decision:'reject'});
    expect(mapTopicAssessment({...base,recommendation:{action:'UPDATE',targetKey:'Missing',proposedContent:'16:00',reason:'x'}})).toMatchObject({decision:'reject'});
    expect(mapTopicAssessment({...base,recommendation:{action:'UPDATE',targetKey:'Meeting',proposedContent:'17:00',reason:'x'}})).toMatchObject({decision:'defer'});
    expect(mapTopicAssessment({...base,candidate:{...candidate,key:'Other'}})).toMatchObject({decision:'defer'});
    expect(mapTopicAssessment({...base,recommendation:{action:'ADD',proposedContent:'16:00',reason:'x'}})).toMatchObject({decision:'defer'});
  });
  it('returns explicit no-mutation results for DUPLICATE and SKIP',()=>{
    expect(mapTopicAssessment({...base,assessment:undefined,recommendation:{action:'DUPLICATE',targetKey:'Meeting',reason:'same'}})).toEqual({decision:'no-mutation',reason:'duplicate'});
    expect(mapTopicAssessment({...base,assessment:undefined,recommendation:{action:'SKIP',reason:'noise'}})).toEqual({decision:'no-mutation',reason:'skip'});
    expect(mapTopicAssessment({...base,recommendation:{action:'DUPLICATE',targetKey:'Other',reason:'x'}})).toMatchObject({decision:'reject'});
  });
  it('rejects missing or inconsistent archive evidence and never invents confirmation',()=>{
    expect(mapTopicAssessment({...base,candidate:{...candidate,evidence:[]}})).toMatchObject({decision:'reject'});
    expect(mapTopicAssessment({...base,candidate:{...candidate,evidence:[{...candidate.evidence[0],quote:'fabricated'}]}})).toMatchObject({decision:'reject'});
    expect(mapTopicAssessment({...base,assessment:{...assessment,evidence:[{messageId:'m',quote:'different'}]}})).toMatchObject({decision:'reject'});
    expect(mapTopicAssessment({...base,assessment:undefined})).toMatchObject({decision:'defer'});
    expect(mapTopicAssessment({...base,sessionId:'another'})).toMatchObject({decision:'reject'});
  });
  it('rejects malformed recommendations and missing candidate data without side effects',()=>{
    const before=structuredClone(base);
    expect(mapTopicAssessment({...base,candidate:{...candidate,key:''}})).toMatchObject({decision:'reject'});
    expect(mapTopicAssessment({...base,recommendation:{action:'DELETE',reason:'x'} as never})).toMatchObject({decision:'reject'});
    expect(base).toEqual(before);
  });
});
