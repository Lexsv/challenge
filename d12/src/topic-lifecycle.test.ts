import { expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWeek3Routes } from '../server/week3-sessions.mjs';
import { createTopicRepository } from '../server/topic-repository.mjs';
import { createTopicLifecycle } from './topic-lifecycle';
import { MemoryProcessor, SessionMemory, type MemorySnapshot } from './session-memory';
import type { TopicCandidate } from './topic-memory';
import type { SemanticAssessment } from './topic-semantic';
import type { HistoryEvent } from './conversation-history';

function setup(db:DatabaseSync){createWeek3Routes(db,()=>null);db.prepare('INSERT INTO week3_sessions(id,title,createdAt) VALUES (?,?,?)').run('a','A',1);db.prepare('INSERT INTO week3_sessions(id,title,createdAt) VALUES (?,?,?)').run('b','B',1);const insert=db.prepare('INSERT INTO week3_history_events VALUES (?,?,?,?,?)');for(const [id,role,text,seq] of [['u','user','Alpha decision.',1],['v','assistant','Beta explanation.',2]] as const)insert.run(`event-${id}`,'a',seq,'message',JSON.stringify({id,conversationId:'a',runId:'run-1',createdAt:1,role,type:'text',text}));}
function proposal(key:string,id:string,role:'user'|'assistant',sequence:number,text:string){const candidate:TopicCandidate={key,value:text,status:'confirmed',sources:[id],evidence:[{messageId:id,role,sequence,quote:text,existence:'verified'}],assessment:{support:'unverified',change:'unverified'}};const assessment:SemanticAssessment={classification:'fact',factSupported:true,changeConfirmed:false,evidence:[{messageId:id,quote:text}]};return {candidate,assessment};}
const entries=[proposal('Alpha','u','user',1,'Alpha decision.'),proposal('Beta','v','assistant',2,'Beta explanation.')];
const group={id:'run-1',sourceIds:['u'],messages:[{role:'user' as const,content:'caller-substituted text '.repeat(80)}]};

it('uses trusted archived messages and atomically commits multiple topics and completion',async()=>{
  const db=new DatabaseSync(':memory:');try{setup(db);const repo=createTopicRepository(db);const seen=vi.fn(async (events:readonly HistoryEvent[])=>{expect(events.map(e=>e.type==='message'?e.payload.text:'')).toEqual(['Alpha decision.','Beta explanation.']);return entries;});const process=createTopicLifecycle(repo,'a',seen);
    await process([group]);expect(seen).toHaveBeenCalledTimes(1);expect(repo.segment('a',['run-1']).completed).toBe(true);expect(repo.get('a','Alpha')).toMatchObject({value:'Alpha decision.'});expect(repo.get('a','Beta')).toMatchObject({status:'uncertain'});
    await process([group,group]);expect(seen).toHaveBeenCalledTimes(1);expect(repo.get('b','Alpha')).toBeNull();expect(()=>repo.segment('b',['run-1'])).toThrow('unavailable');
  }finally{db.close();}
});

it('rolls back all topics and completion when the final write fails',async()=>{
  const db=new DatabaseSync(':memory:');try{setup(db);const repo=createTopicRepository(db);db.exec("CREATE TRIGGER fail_beta BEFORE INSERT ON week3_topic_evidence WHEN NEW.message_id='v' BEGIN SELECT RAISE(ABORT,'last write fails'); END");
    await expect(createTopicLifecycle(repo,'a',async()=>entries)([group])).rejects.toThrow('last write fails');expect(repo.get('a','Alpha')).toBeNull();expect(repo.get('a','Beta')).toBeNull();expect(repo.segment('a',['run-1']).completed).toBe(false);
  }finally{db.close();}
});

it('persists an empty completed segment and skips reassessment after reopening SQLite',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'d11-segment-'));const path=join(dir,'test.sqlite');let db=new DatabaseSync(path);
  try{setup(db);let repo=createTopicRepository(db);const assess=vi.fn(async()=>[]);await createTopicLifecycle(repo,'a',assess)([group]);db.close();db=new DatabaseSync(path);repo=createTopicRepository(db);await createTopicLifecycle(repo,'a',assess)([group]);expect(assess).toHaveBeenCalledTimes(1);expect(repo.segment('a',['run-1']).completed).toBe(true);expect(repo.get('a','Alpha')).toBeNull();}finally{db.close();await rm(dir,{recursive:true,force:true});}
});

it('records completion after rejected and deferred candidates without writing topics',async()=>{
  const db=new DatabaseSync(':memory:');try{setup(db);const repo=createTopicRepository(db);
    const invalid={...entries[0],candidate:{...entries[0].candidate,evidence:[{...entries[0].candidate.evidence[0],quote:'not in archive'}]}};
    const deferred={...entries[1],assessment:{...entries[1].assessment,classification:'proposal' as const}};
    await createTopicLifecycle(repo,'a',async()=>[invalid,deferred])([group]);expect(repo.segment('a',['run-1']).completed).toBe(true);expect(repo.get('a','Alpha')).toBeNull();expect(repo.get('a','Beta')).toBeNull();
  }finally{db.close();}
});

it('retains the buffer on failed assessment or compression and skips committed reassessment on retry',async()=>{
  const db=new DatabaseSync(':memory:');try{setup(db);const repo=createTopicRepository(db);const assess=vi.fn().mockRejectedValueOnce(Error('offline')).mockResolvedValue(entries);const lifecycle=createTopicLifecycle(repo,'a',assess);
    let saved:MemorySnapshot={revision:0,data:null};const store={load:async()=>structuredClone(saved),save:async(value:MemorySnapshot)=>{saved={revision:value.revision+1,data:structuredClone(value.data)};return structuredClone(saved);}};
    const processor=new MemoryProcessor({complete:async()=>({text:'{"facts":[]}'}),context:{assess:async()=>({tokens:1,limit:10000}),summarize:async()=>''}});const compress=vi.spyOn(processor,'compress').mockRejectedValueOnce(Error('summary offline')).mockResolvedValue('Summary.');
    const memory=new SessionMemory(store,processor,'gpt-4o-mini',60,lifecycle);
    await expect(memory.prepare([group],[{role:'user',content:'Next?'}],'next')).rejects.toThrow('offline');expect(compress).not.toHaveBeenCalled();expect(saved.data?.buffer).toHaveLength(1);expect(repo.segment('a',['run-1']).completed).toBe(false);
    await expect(memory.prepare([group],[{role:'user',content:'Next?'}],'next')).rejects.toThrow('summary offline');expect(repo.segment('a',['run-1']).completed).toBe(true);expect(saved.data?.covered).toEqual([]);
    await memory.prepare([group],[{role:'user',content:'Next?'}],'next');expect(assess).toHaveBeenCalledTimes(2);expect(saved.data?.covered).toEqual(['run-1']);expect((repo.get('a','Alpha') as {history:unknown[]}).history).toHaveLength(1);
  }finally{db.close();}
});

it('allows only one completed transaction for concurrent duplicate attempts',async()=>{
  const db=new DatabaseSync(':memory:');try{setup(db);const repo=createTopicRepository(db);let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);const assess=vi.fn(async()=>{await gate;return entries;});const process=createTopicLifecycle(repo,'a',assess);const first=process([group]);const second=process([group]);release();await Promise.all([first,second]);expect((repo.get('a','Alpha') as {history:unknown[]}).history).toHaveLength(1);expect(repo.segment('a',['run-1']).completed).toBe(true);}finally{db.close();}
});

it('keeps the SessionMemory buffer and coverage unchanged when the topic transaction fails',async()=>{
  const db=new DatabaseSync(':memory:');try{setup(db);const repo=createTopicRepository(db);db.exec("CREATE TRIGGER fail_beta BEFORE INSERT ON week3_topic_evidence WHEN NEW.message_id='v' BEGIN SELECT RAISE(ABORT,'persist failed'); END");
    let saved:MemorySnapshot={revision:0,data:null};const store={load:async()=>structuredClone(saved),save:async(value:MemorySnapshot)=>{saved={revision:value.revision+1,data:structuredClone(value.data)};return structuredClone(saved);}};
    const processor=new MemoryProcessor({complete:async()=>({text:'{"facts":[]}'}),context:{assess:async()=>({tokens:1,limit:10000}),summarize:async()=>''}});const compress=vi.spyOn(processor,'compress').mockResolvedValue('Summary.');
    await expect(new SessionMemory(store,processor,'gpt-4o-mini',60,createTopicLifecycle(repo,'a',async()=>entries)).prepare([group],[{role:'user',content:'Next?'}],'next')).rejects.toThrow('persist failed');
    expect(compress).not.toHaveBeenCalled();expect(saved.data?.buffer).toHaveLength(1);expect(saved.data?.covered).toEqual([]);expect(repo.get('a','Alpha')).toBeNull();
  }finally{db.close();}
});

it('allows retry after a failed assessment and reopening the database',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'d11-segment-retry-'));const path=join(dir,'test.sqlite');let db=new DatabaseSync(path);
  try{setup(db);let repo=createTopicRepository(db);await expect(createTopicLifecycle(repo,'a',async()=>{throw Error('interrupted');})([group])).rejects.toThrow('interrupted');expect(repo.segment('a',['run-1']).completed).toBe(false);db.close();db=new DatabaseSync(path);repo=createTopicRepository(db);await createTopicLifecycle(repo,'a',async()=>entries)([group]);expect(repo.segment('a',['run-1']).completed).toBe(true);expect(repo.get('a','Alpha')).toMatchObject({value:'Alpha decision.'});}finally{db.close();await rm(dir,{recursive:true,force:true});}
});

it('changes segment identity when an archived run gains a message and rejects a stale commit',async()=>{
  const db=new DatabaseSync(':memory:');try{setup(db);const repo=createTopicRepository(db);const before=repo.segment('a',['run-1']);
    db.prepare('INSERT INTO week3_history_events VALUES (?,?,?,?,?)').run('event-late','a',3,'message',JSON.stringify({id:'late',conversationId:'a',runId:'run-1',createdAt:2,role:'assistant',type:'text',text:'Later saved message.'}));
    const after=repo.segment('a',['run-1']);expect(after.segmentId).not.toBe(before.segmentId);
    expect(()=>repo.commitSegment('a',['run-1'],[],before.segmentId)).toThrow('changed during processing');expect(repo.segment('a',['run-1']).completed).toBe(false);
  }finally{db.close();}
});
