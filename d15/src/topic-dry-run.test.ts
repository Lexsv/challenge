import { describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createWeek3Routes } from '../server/week3-sessions.mjs';
import { createTopicRepository } from '../server/topic-repository.mjs';
import { runTopicDryRun, type TopicDryRunDependencies } from './topic-dry-run';
import { extractTopicCandidates, type TopicCandidate } from './topic-memory';
import { assessTopicCandidate, type SemanticAssessment } from './topic-semantic';
import { createLlmSemanticAssessor } from '../server/semantic-assessor';
import type { HistoryEvent } from './conversation-history';
import type { SemanticAssessor } from './semantic-assessor';

const text='We agreed to move the meeting from 13:00 to 16:00.';
const candidate:TopicCandidate={key:'Meeting',value:'16:00',status:'confirmed',sources:['m'],evidence:[{messageId:'m',role:'user',sequence:1,quote:text,existence:'verified'}],assessment:{support:'unverified',change:'unverified'}};
const evidence:SemanticAssessment={classification:'change',factSupported:true,changeConfirmed:true,evidence:[{messageId:'m',quote:text}]};
const update={action:'UPDATE' as const,targetKey:'Meeting',proposedContent:'16:00',reason:'Confirmed change'};

function fixture(hasTopic=true){
  const db=new DatabaseSync(':memory:');createWeek3Routes(db,()=>null);
  db.prepare('INSERT INTO week3_sessions(id,title,createdAt) VALUES (?,?,?)').run('s','test',1);
  const event:HistoryEvent={id:'e',sessionId:'s',sequence:1,type:'message',payload:{id:'m',conversationId:'s',runId:'r',createdAt:1,role:'user',type:'text',text}};
  db.prepare('INSERT INTO week3_history_events VALUES (?,?,?,?,?)').run(event.id,'s',1,event.type,JSON.stringify(event.payload));
  if(hasTopic)db.prepare('INSERT INTO week3_topics VALUES (?,?,?,?,?)').run('s','Meeting','13:00','confirmed',1);
  const repository=createTopicRepository(db);
  const assessor:SemanticAssessor={assess:vi.fn(async()=>({ok:true as const,recommendation:update}))};
  const deps:TopicDryRunDependencies={repository,extract:vi.fn(async()=>[candidate]),assessor,assessEvidence:vi.fn(async()=>evidence)};
  return {db,repository,deps};
}

describe('read-only topic dry run',()=>{
  it('runs real extraction, LLM recommendation, evidence assessment and validation using only mocked model responses',async()=>{
    const {db,repository,deps}=fixture(false);
    try{
      const outputs=[{topics:[{key:'Meeting',value:'16:00',status:'confirmed',evidence:[{sourceId:'m',quote:text}]}]},{action:'ADD',proposedContent:'16:00',reason:'New topic'},{...evidence,classification:'fact',changeConfirmed:false}];
      const adapter={context:{assess:async()=>({tokens:100,limit:10000}),summarize:async()=>''},complete:vi.fn(async()=>({text:JSON.stringify(outputs.shift())}))};
      deps.extract=(sessionId,events)=>extractTopicCandidates(adapter,sessionId,events);
      deps.assessor=createLlmSemanticAssessor(adapter);
      deps.assessEvidence=(sessionId,events,item,current)=>assessTopicCandidate(adapter,sessionId,events,item,current);
      const before=db.prepare('SELECT total_changes() AS n').get();db.exec('PRAGMA query_only=ON');
      const result=await runTopicDryRun('s','r',deps);
      expect(result).toMatchObject({status:'completed',candidates:[{candidateKey:'Meeting',recommendedAction:'ADD',mapping:'proposal',validation:'accept'}]});expect(adapter.complete).toHaveBeenCalledTimes(3);
      expect(db.prepare('SELECT total_changes() AS n').get()).toEqual(before);expect(repository.segment('s',['r']).completed).toBe(false);
      for(const table of ['week3_topics','week3_topic_changes','week3_topic_evidence','week3_topic_segments','week3_session_memory'])expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toMatchObject({n:0});
      expect(db.prepare('SELECT COUNT(*) AS n FROM week3_history_events').get()).toMatchObject({n:1});
    }finally{db.close();}
  });
  it('handles supported, unconfirmed and unsupported updates without mutating stored state',async()=>{
    const {db,repository,deps}=fixture();try{
      const before=repository.get('s','Meeting');db.exec('PRAGMA query_only=ON');
      expect((await runTopicDryRun('s','r',deps)).candidates[0]).toMatchObject({mapping:'proposal',validation:'accept'});
      deps.assessEvidence=async()=>({...evidence,changeConfirmed:false});expect((await runTopicDryRun('s','r',deps)).candidates[0].mapping).toBe('defer');
      deps.assessEvidence=async()=>({...evidence,factSupported:false});expect((await runTopicDryRun('s','r',deps)).candidates[0].mapping).toBe('reject');
      deps.assessEvidence=async()=>({...evidence,evidence:[{messageId:'m',quote:'invented'}]});expect((await runTopicDryRun('s','r',deps)).candidates[0].mapping).toBe('reject');
      expect(repository.get('s','Meeting')).toEqual(before);expect(repository.segment('s',['r']).completed).toBe(false);
    }finally{db.close();}
  });
  it('distinguishes no-op, empty extraction, malformed result and execution failures',async()=>{
    const {db,deps}=fixture();try{
      for(const action of ['DUPLICATE','SKIP'] as const){deps.assessor={assess:async()=>({ok:true,recommendation:action==='SKIP'?{action,reason:'No'}:{action,targetKey:'Meeting',reason:'Same'}})};expect((await runTopicDryRun('s','r',deps)).candidates[0]).toMatchObject({mapping:'no-mutation',recommendedAction:action});}
      deps.extract=async()=>[];expect(await runTopicDryRun('s','r',deps)).toMatchObject({status:'completed',candidates:[]});
      deps.extract=async()=>{throw Error('failure')};expect(await runTopicDryRun('s','r',deps)).toMatchObject({status:'failed',failure:'extraction'});
      deps.extract=async()=>[candidate];deps.assessor={assess:async()=>({ok:false,error:{code:'INVALID_JSON'}})};expect((await runTopicDryRun('s','r',deps)).candidates[0].mapping).toBe('reject');
      deps.assessor={assess:async()=>({ok:false,error:{code:'EXECUTION_FAILED'}})};expect(await runTopicDryRun('s','r',deps)).toMatchObject({status:'failed',failure:'assessment',candidates:[{mapping:'failure'}]});
      deps.assessor={assess:async()=>({ok:true,recommendation:update})};deps.assessEvidence=async()=>{throw Error('401')};expect(await runTopicDryRun('s','r',deps)).toMatchObject({status:'failed',failure:'assessment'});
    }finally{db.close();}
  });
  it('supports mixed candidates, repeated runs, missing targets and conflicting proposals',async()=>{
    const {db,deps}=fixture();try{
      deps.extract=async()=>[candidate,{...candidate,key:'Other'}];let calls=0;
      deps.assessor={assess:async()=>({ok:true,recommendation:calls++%2===0?update:{action:'SKIP',reason:'Noise'}})};
      const a=await runTopicDryRun('s','r',deps),b=await runTopicDryRun('s','r',deps);expect(a).toEqual(b);expect(a.candidates.map(x=>x.mapping)).toEqual(['proposal','no-mutation']);
      deps.extract=async()=>[candidate,candidate];deps.assessor={assess:async()=>({ok:true,recommendation:update})};expect((await runTopicDryRun('s','r',deps)).candidates.map(x=>x.mapping)).toEqual(['defer','defer']);
      deps.extract=async()=>[candidate];deps.assessor={assess:async()=>({ok:true,recommendation:{...update,targetKey:'missing'}})};expect((await runTopicDryRun('s','r',deps)).candidates[0].mapping).toBe('reject');
    }finally{db.close();}
  });
  it('fails when the source or catalog changes during assessment, and handles missing archive',async()=>{
    const {db,deps}=fixture();try{
      let reads=0;const repository=deps.repository;
      deps.repository={segment:repository.segment,catalog:(sessionId,options)=>{const page=repository.catalog(sessionId,options);return ++reads===1?page:{...page,topics:page.topics.map(topic=>({...topic,revision:topic.revision+1}))};}};
      expect(await runTopicDryRun('s','r',deps)).toMatchObject({status:'failed',failure:'stale'});
      expect(await runTopicDryRun('s','missing',deps)).toMatchObject({status:'failed',failure:'archive'});
    }finally{db.close();}
  });
  it('rejects missing revisions without any repository writes',async()=>{
    const {db,deps}=fixture();try{
      const repository=deps.repository;deps.repository={segment:repository.segment,catalog:(sessionId,options)=>{const page=repository.catalog(sessionId,options);return {...page,topics:page.topics.map(topic=>({...topic,revision:0}))};}};
      db.exec('PRAGMA query_only=ON');expect((await runTopicDryRun('s','r',deps)).candidates[0].mapping).toBe('reject');
    }finally{db.close();}
  });
  it('leaves an existing pending memory snapshot and buffer unchanged',async()=>{
    const {db,deps}=fixture();try{
      const data=JSON.stringify({summary:'prior summary',buffer:[{id:'r',messages:[{role:'user',content:text}]}],covered:[]});
      db.prepare('INSERT INTO week3_session_memory(sessionId,revision,data) VALUES (?,?,?)').run('s',3,data);
      const before=db.prepare('SELECT revision,data FROM week3_session_memory WHERE sessionId=?').get('s');db.exec('PRAGMA query_only=ON');
      expect((await runTopicDryRun('s','r',deps)).status).toBe('completed');
      expect(db.prepare('SELECT revision,data FROM week3_session_memory WHERE sessionId=?').get('s')).toEqual(before);
    }finally{db.close();}
  });
});
