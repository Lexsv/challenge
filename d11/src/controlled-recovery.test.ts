import { describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createWeek3Routes } from '../server/week3-sessions.mjs';
import { createTopicRepository } from '../server/topic-repository.mjs';
import { createControlledTopicOrchestrator } from '../server/controlled-topic-orchestrator';
import { MemoryProcessor, SessionMemory, type MemorySnapshot } from './session-memory';
import type { TopicCandidate } from './topic-memory';
import type { SemanticAssessment } from './topic-semantic';
import type { SemanticAssessor } from './semantic-assessor';

const text='The project uses SQLite.';
const item:TopicCandidate={key:'Project',value:'SQLite',status:'confirmed',sources:['m'],evidence:[{messageId:'m',role:'user',sequence:1,quote:text,existence:'verified'}],assessment:{support:'unverified',change:'unverified'}};
const assessment:SemanticAssessment={classification:'fact',factSupported:true,changeConfirmed:false,evidence:[{messageId:'m',quote:text}]};
function fixture(){const db=new DatabaseSync(':memory:');createWeek3Routes(db,()=>null);db.prepare('INSERT INTO week3_sessions(id,title,createdAt) VALUES (?,?,?)').run('s','test',1);db.prepare('INSERT INTO week3_history_events VALUES (?,?,?,?,?)').run('e','s',1,'message',JSON.stringify({id:'m',conversationId:'s',runId:'r',createdAt:1,role:'user',type:'text',text}));const repository=createTopicRepository(db);const assessor:SemanticAssessor={assess:async()=>({ok:true,recommendation:{action:'ADD',proposedContent:'SQLite',reason:'new'}})};return {db,repository,extract:vi.fn(async()=>[item]),assessor,assessEvidence:async()=>assessment};}
const policy={enabled:true,authorize:()=>true};
const count=(db:DatabaseSync,table:string)=>(db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {n:number}).n;

describe('controlled recovery boundaries',()=>{
  it.each(['week3_topics','week3_topic_changes','week3_topic_evidence','week3_topic_segments'])('rolls back a failure inserting into %s',async table=>{
    const f=fixture();try{f.db.exec(`CREATE TRIGGER synthetic_failure BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'synthetic'); END`);const result=await createControlledTopicOrchestrator(f,policy).process('s','r');
      expect(result.status).toBe('unknown');for(const name of ['week3_topics','week3_topic_changes','week3_topic_evidence','week3_topic_segments'])expect(count(f.db,name)).toBe(0);expect(count(f.db,'week3_history_events')).toBe(1);
    }finally{f.db.close();}
  });
  it('reports uncertain confirmation after commit and reconciles by marker on repeat',async()=>{
    const f=fixture();try{const real=f.repository.commitControlledSegment;const repo={...f.repository,commitControlledSegment:(...args:Parameters<typeof real>)=>{real(...args);throw Error('response lost');}};
      const first=await createControlledTopicOrchestrator({...f,repository:repo},policy).process('s','r');expect(first.status).toBe('unknown');expect(count(f.db,'week3_topic_segments')).toBe(1);
      const repeat=await createControlledTopicOrchestrator(f,policy).process('s','r');expect(repeat.status).toBe('alreadyCompleted');expect(count(f.db,'week3_topic_changes')).toBe(1);expect(count(f.db,'week3_topic_evidence')).toBe(1);expect(f.extract).toHaveBeenCalledTimes(1);
    }finally{f.db.close();}
  });
  it('retains the buffer on pre-commit failure and after committed topics followed by summary failure',async()=>{
    const f=fixture();try{
      let snapshot:MemorySnapshot={revision:0,data:null};const store={load:async()=>structuredClone(snapshot),save:async(value:MemorySnapshot)=>{snapshot={revision:value.revision+1,data:structuredClone(value.data)};return structuredClone(snapshot);}};
      const processor=new MemoryProcessor({complete:async()=>({text:'{"facts":[]}'}),context:{assess:async()=>({tokens:1,limit:10000}),summarize:async()=>''}});const compress=vi.spyOn(processor,'compress').mockRejectedValueOnce(Error('summary unavailable')).mockResolvedValue('summary');
      let enabled=false;const hook=async()=>{const result=await createControlledTopicOrchestrator(f,{enabled,authorize:()=>true}).process('s','r');if(result.status!=='completed' && result.status!=='alreadyCompleted')throw Error('topic unavailable');};
      const memory=new SessionMemory(store,processor,'gpt-4o-mini',60,hook);const groups=[{id:'r',sourceIds:['m'],messages:[{role:'user' as const,content:text.repeat(30)}]}];const question=[{role:'user' as const,content:'Next?'}];
      await expect(memory.prepare(groups,question,'next')).rejects.toThrow('topic unavailable');expect(compress).not.toHaveBeenCalled();expect(count(f.db,'week3_topic_segments')).toBe(0);expect(snapshot.data?.buffer).toHaveLength(1);
      enabled=true;await expect(memory.prepare(groups,question,'next')).rejects.toThrow('summary unavailable');expect(count(f.db,'week3_topic_segments')).toBe(1);expect(snapshot.data?.buffer).toHaveLength(1);expect(snapshot.data?.covered).toEqual([]);
      await memory.prepare(groups,question,'next');expect(snapshot.data?.covered).toContain('r');expect(count(f.db,'week3_topic_changes')).toBe(1);expect(f.extract).toHaveBeenCalledTimes(1);
    }finally{f.db.close();}
  });
  it('preserves a persisted buffer after a post-topic snapshot-save failure and retries without duplicate history',async()=>{
    const f=fixture();try{
      let snapshot:MemorySnapshot={revision:0,data:null};let saves=0;
      const store={load:async()=>structuredClone(snapshot),save:async(value:MemorySnapshot)=>{saves++;if(saves===2)throw Error('synthetic snapshot failure');snapshot={revision:value.revision+1,data:structuredClone(value.data)};return structuredClone(snapshot);}};
      const processor=new MemoryProcessor({complete:async()=>({text:'{"facts":[]}'}),context:{assess:async()=>({tokens:1,limit:10000}),summarize:async()=>''}});vi.spyOn(processor,'compress').mockResolvedValue('summary');
      const coordinator=createControlledTopicOrchestrator(f,policy);const hook=async()=>{const result=await coordinator.process('s','r');if(result.status!=='completed' && result.status!=='alreadyCompleted')throw Error('topic failed');};
      const group={id:'r',sourceIds:['m'],messages:[{role:'user' as const,content:text.repeat(30)}]};
      await expect(new SessionMemory(store,processor,'gpt-4o-mini',60,hook).prepare([group],[{role:'user',content:'Next?'}],'next')).rejects.toThrow('snapshot failure');
      expect(snapshot.data?.buffer).toHaveLength(1);expect(snapshot.data?.covered).toEqual([]);expect(count(f.db,'week3_topic_segments')).toBe(1);
      // Reconstruct the facade to simulate a browser-side restart against the retained snapshot.
      await new SessionMemory(store,processor,'gpt-4o-mini',60,hook).prepare([group],[{role:'user',content:'Next?'}],'next');
      expect(snapshot.data?.buffer).toHaveLength(0);expect(snapshot.data?.covered).toContain('r');expect(count(f.db,'week3_topic_changes')).toBe(1);expect(f.extract).toHaveBeenCalledTimes(1);expect(count(f.db,'week3_history_events')).toBe(1);
    }finally{f.db.close();}
  });
});
