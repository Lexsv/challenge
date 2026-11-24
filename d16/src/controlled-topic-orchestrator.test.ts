import { describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createWeek3Routes } from '../server/week3-sessions.mjs';
import { createTopicRepository } from '../server/topic-repository.mjs';
import { createControlledTopicOrchestrator } from '../server/controlled-topic-orchestrator';
import type { TopicCandidate } from './topic-memory';
import type { SemanticAssessment } from './topic-semantic';
import type { SemanticAssessor } from './semantic-assessor';
import { extractTopicCandidates } from './topic-memory';
import { assessTopicCandidate } from './topic-semantic';
import { createLlmSemanticAssessor } from '../server/semantic-assessor';

const text='Meeting is at 16:00. The project uses SQLite.';
const candidate=(key='Meeting',value='16:00'):TopicCandidate=>({key,value,status:'confirmed',sources:['m'],evidence:[{messageId:'m',role:'user',sequence:1,quote:text,existence:'verified'}],assessment:{support:'unverified',change:'unverified'}});
const evidence=(classification:'fact'|'change'='fact',changeConfirmed=false):SemanticAssessment=>({classification,factSupported:true,changeConfirmed,evidence:[{messageId:'m',quote:text}]});
function fixture(existing=false){
  const db=new DatabaseSync(':memory:');createWeek3Routes(db,()=>null);db.prepare('INSERT INTO week3_sessions(id,title,createdAt) VALUES (?,?,?)').run('s','test',1);
  db.prepare('INSERT INTO week3_history_events VALUES (?,?,?,?,?)').run('e','s',1,'message',JSON.stringify({id:'m',conversationId:'s',runId:'r',createdAt:1,role:'user',type:'text',text}));
  if(existing)db.prepare('INSERT INTO week3_topics VALUES (?,?,?,?,?)').run('s','Meeting','13:00','confirmed',1);
  db.prepare('INSERT INTO week3_session_memory VALUES (?,?,?)').run('s',2,JSON.stringify({summary:'prior',buffer:[{id:'r'}],covered:[]}));
  const repository=createTopicRepository(db);const extract=vi.fn(async()=>[candidate()]);
  const assessor:SemanticAssessor={assess:vi.fn(async()=>({ok:true as const,recommendation:{action:'ADD' as const,proposedContent:'16:00',reason:'New'}}))};
  const assessEvidence=vi.fn(async()=>evidence());return {db,repository,extract,assessor,assessEvidence};
}
const policy={enabled:true,authorize:()=>true};
const count=(db:DatabaseSync,table:string)=>(db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {n:number}).n;

describe('isolated controlled topic orchestration',()=>{
  it('uses the actual extraction, recommendation and evidence adapters with mocked model output',async()=>{
    const f=fixture();try{
      const outputs=[{topics:[{key:'Meeting',value:'16:00',status:'confirmed',evidence:[{sourceId:'m',quote:text}]}]},{action:'ADD',proposedContent:'16:00',reason:'New'},evidence()];
      const adapter={context:{assess:async()=>({tokens:100,limit:10000}),summarize:async()=>''},complete:vi.fn(async()=>({text:JSON.stringify(outputs.shift())}))};
      const deps={repository:f.repository,extract:(id:string,events:Parameters<typeof extractTopicCandidates>[2])=>extractTopicCandidates(adapter,id,events),assessor:createLlmSemanticAssessor(adapter),assessEvidence:(id:string,events:Parameters<typeof assessTopicCandidate>[2],item:TopicCandidate,current?:Parameters<typeof assessTopicCandidate>[4])=>assessTopicCandidate(adapter,id,events,item,current)};
      expect((await createControlledTopicOrchestrator(deps,policy).process('s','r')).status).toBe('completed');expect(adapter.complete).toHaveBeenCalledTimes(3);expect(f.repository.get('s','Meeting')).toMatchObject({value:'16:00'});
    }finally{f.db.close();}
  });
  it('commits an ADD once, without changing SessionMemory',async()=>{
    const f=fixture();try{const before=f.db.prepare('SELECT * FROM week3_session_memory').all();const coordinator=createControlledTopicOrchestrator(f,policy);
      expect(await coordinator.process('s','r')).toMatchObject({status:'completed'});expect(f.repository.get('s','Meeting')).toMatchObject({value:'16:00',revision:1});
      expect(await coordinator.process('s','r')).toMatchObject({status:'alreadyCompleted'});expect(f.extract).toHaveBeenCalledTimes(1);expect(count(f.db,'week3_topic_changes')).toBe(1);expect(f.db.prepare('SELECT * FROM week3_session_memory').all()).toEqual(before);
    }finally{f.db.close();}
  });
  it('commits a confirmed UPDATE but leaves an unconfirmed one unresolved',async()=>{
    for(const confirmed of [false,true]){const f=fixture(true);try{
      f.assessor.assess=async()=>({ok:true,recommendation:{action:'UPDATE',targetKey:'Meeting',proposedContent:'16:00',reason:'Changed'}});
      f.assessEvidence.mockResolvedValue(evidence('change',confirmed));const result=await createControlledTopicOrchestrator(f,policy).process('s','r');
      expect(result.status).toBe(confirmed?'completed':'unresolved');expect((f.repository.get('s','Meeting') as {value:string}).value).toBe(confirmed?'16:00':'13:00');expect(count(f.db,'week3_topic_segments')).toBe(confirmed?1:0);
    }finally{f.db.close();}}
  });
  it('commits only a marker for duplicate, skip and successful empty extraction',async()=>{
    for(const mode of ['DUPLICATE','SKIP','EMPTY'] as const){const f=fixture(true);try{
      if(mode==='EMPTY')f.extract.mockResolvedValue([]);else f.assessor.assess=async()=>({ok:true,recommendation:mode==='SKIP'?{action:'SKIP',reason:'Noise'}:{action:'DUPLICATE',targetKey:'Meeting',reason:'Same'}});
      expect((await createControlledTopicOrchestrator(f,policy).process('s','r')).status).toBe('completed');expect(count(f.db,'week3_topic_segments')).toBe(1);expect(count(f.db,'week3_topic_changes')).toBe(0);expect(f.assessEvidence).not.toHaveBeenCalled();
    }finally{f.db.close();}}
  });
  it('handles multiple valid candidates atomically and rejects conflicts or mixed deferral',async()=>{
    for(const mode of ['valid','conflict','defer'] as const){const f=fixture();try{
      f.extract.mockResolvedValue([candidate('Meeting','16:00'),candidate(mode==='conflict'?'Meeting':'Project',mode==='conflict'?'16:00':'SQLite')]);let i=0;
      f.assessor.assess=async()=>{const index=i++;return {ok:true,recommendation:{action:'ADD',proposedContent:mode==='defer' && index===1?'different':mode==='conflict'?'16:00':index===0?'16:00':'SQLite',reason:'new'}};};
      const result=await createControlledTopicOrchestrator(f,policy).process('s','r');
      expect(result.status).toBe(mode==='valid'?'completed':'unresolved');expect(count(f.db,'week3_topics')).toBe(mode==='valid'?2:0);expect(count(f.db,'week3_topic_segments')).toBe(mode==='valid'?1:0);
    }finally{f.db.close();}}
  });
  it('commits a valid proposal alongside a resolved skip without extra history',async()=>{
    const f=fixture();try{f.extract.mockResolvedValue([candidate(),candidate('Noise','hello')]);let index=0;
      f.assessor.assess=async()=>({ok:true,recommendation:index++===0?{action:'ADD',proposedContent:'16:00',reason:'new'}:{action:'SKIP',reason:'noise'}});
      expect((await createControlledTopicOrchestrator(f,policy).process('s','r')).status).toBe('completed');expect(count(f.db,'week3_topic_changes')).toBe(1);expect(count(f.db,'week3_topic_segments')).toBe(1);expect(f.assessEvidence).toHaveBeenCalledTimes(1);
    }finally{f.db.close();}
  });
  it('fails closed for extraction, provider, malformed recommendation and missing evidence',async()=>{
    for(const mode of ['extract','provider','malformed','evidence'] as const){const f=fixture();try{
      if(mode==='extract')f.extract.mockRejectedValue(Error('private'));
      if(mode==='provider')f.assessor.assess=async()=>({ok:false,error:{code:'EXECUTION_FAILED'}});
      if(mode==='malformed')f.assessor.assess=async()=>({ok:false,error:{code:'INVALID_JSON'}});
      if(mode==='evidence')f.assessEvidence.mockResolvedValue(undefined as never);
      const result=await createControlledTopicOrchestrator(f,policy).process('s','r');expect(result.status).toBe(mode==='malformed'?'rejected':mode==='evidence'?'unresolved':'failed');expect(JSON.stringify(result)).not.toContain('private');expect(count(f.db,'week3_topic_segments')).toBe(0);
    }finally{f.db.close();}}
  });
  it('is disabled by default and never accepts client authorization flags',async()=>{
    const f=fixture();try{const coordinator=createControlledTopicOrchestrator(f);expect(await coordinator.process('s','r')).toEqual({status:'disabled'});expect(await coordinator.process('s','r',{authorized:true,analysisComplete:true})).toEqual({status:'failed'});expect(f.extract).not.toHaveBeenCalled();expect(count(f.db,'week3_topic_segments')).toBe(0);
      expect((await createControlledTopicOrchestrator(f,{enabled:true,authorize:()=>false}).process('s','r')).status).toBe('disabled');expect(count(f.db,'week3_topic_segments')).toBe(0);
    }finally{f.db.close();}
  });
  it('rejects model-supplied authorization fields instead of treating them as policy',async()=>{
    const f=fixture();try{
      f.assessor.assess=async()=>({ok:true,recommendation:{action:'ADD',proposedContent:'16:00',reason:'new',authorized:true,analysisComplete:true} as never});
      const authorize=vi.fn(()=>true);expect((await createControlledTopicOrchestrator(f,{enabled:true,authorize}).process('s','r')).status).toBe('rejected');
      expect(authorize).not.toHaveBeenCalled();expect(count(f.db,'week3_topic_segments')).toBe(0);
    }finally{f.db.close();}
  });
  it('derives completion and authorization only after every candidate has been analyzed',async()=>{
    const f=fixture();try{
      const commit=vi.spyOn(f.repository,'commitControlledSegment');const authorize=vi.fn(()=>true);
      expect((await createControlledTopicOrchestrator(f,{enabled:true,authorize}).process('s','r')).status).toBe('completed');
      expect(authorize).toHaveBeenCalledOnce();expect(commit).toHaveBeenCalledOnce();expect(commit.mock.calls[0][2]).toMatchObject({authorized:true,analysisComplete:true,candidateCount:1,proposals:[{candidate:{key:'Meeting'},recommendation:{action:'ADD'},expectedTopicRevision:0}]});
    }finally{f.db.close();}
  });
  it('rejects forged evidence and maps a transaction revision conflict to stale',async()=>{
    const f=fixture();try{
      f.extract.mockResolvedValue([{...candidate(),evidence:[{...candidate().evidence[0],quote:'not in archive'}]}]);
      expect((await createControlledTopicOrchestrator(f,policy).process('s','r')).status).toBe('rejected');expect(count(f.db,'week3_topic_segments')).toBe(0);
      f.extract.mockResolvedValue([candidate()]);vi.spyOn(f.repository,'commitControlledSegment').mockImplementation(()=>{throw Error('Topic revision conflict.');});
      expect((await createControlledTopicOrchestrator(f,policy).process('s','r')).status).toBe('stale');expect(count(f.db,'week3_topic_segments')).toBe(0);
    }finally{f.db.close();}
  });
  it('rejects stale catalog or source and rolls back transaction failures',async()=>{
    for(const mode of ['catalog','source','rollback'] as const){const f=fixture();try{
      if(mode==='rollback')f.db.exec("CREATE TRIGGER fail_evidence BEFORE INSERT ON week3_topic_evidence BEGIN SELECT RAISE(ABORT,'synthetic'); END");
      const authorize=()=>{if(mode==='catalog')f.db.prepare('INSERT INTO week3_topics VALUES (?,?,?,?,?)').run('s','Other','value','confirmed',1);if(mode==='source')f.db.prepare('UPDATE week3_history_events SET payload=? WHERE id=?').run(JSON.stringify({id:'m',conversationId:'s',runId:'r',createdAt:1,role:'user',type:'text',text:text+' changed'}),'e');return true;};
      const result=await createControlledTopicOrchestrator(f,{enabled:true,authorize}).process('s','r');expect(result.status).toBe(mode==='rollback'?'unknown':'stale');expect(count(f.db,'week3_topic_segments')).toBe(0);expect(f.repository.get('s','Meeting')).toBeNull();
    }finally{f.db.close();}}
  });
  it('concurrent duplicate executions commit only one segment and one history record',async()=>{
    const f=fixture();try{let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);let entered=0;f.extract.mockImplementation(async()=>{if(++entered===2)release();await gate;return [candidate()];});
      const coordinator=createControlledTopicOrchestrator(f,policy);const result=await Promise.all([coordinator.process('s','r'),coordinator.process('s','r')]);expect(result.map(x=>x.status).sort()).toEqual(['alreadyCompleted','completed']);expect(count(f.db,'week3_topic_segments')).toBe(1);expect(count(f.db,'week3_topic_changes')).toBe(1);
    }finally{f.db.close();}
  });
});
