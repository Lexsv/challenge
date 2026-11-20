import { expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWeek3Routes } from '../server/week3-sessions.mjs';
import { createTopicRepository } from '../server/topic-repository.mjs';
import type { HistoryEvent } from './conversation-history';
import type { TopicCandidate, TopicRecord } from './topic-memory';
import { persistAssessedTopic } from './topic-persistence';
import type { SemanticAssessment } from './topic-semantic';

const event=(sessionId:string,id:string,text:string,sequence:number):HistoryEvent=>({id:`event-${sessionId}-${id}`,sessionId,sequence,type:'message',payload:{id,conversationId:sessionId,runId:'r',createdAt:1,role:'user',type:'text',text}});
const candidate=(id:string,text:string,sequence:number,value:string):TopicCandidate=>({key:'Meeting',value,status:'confirmed',sources:[id],evidence:[{messageId:id,role:'user',sequence,quote:text,existence:'verified'}],assessment:{support:'unverified',change:'unverified'}});
const assessment=(id:string,text:string,classification:SemanticAssessment['classification']):SemanticAssessment=>({classification,factSupported:true,changeConfirmed:classification==='change',evidence:[{messageId:id,quote:text}]});
const current=(value:string):TopicRecord=>({key:'Meeting',value,status:'confirmed',sources:['original'],archiveSequence:null,history:[]});

it('persists accepted topic changes atomically and restores isolated sessions with evidence',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'d11-topic-repo-'));const path=join(dir,'test.sqlite');let db=new DatabaseSync(path);
  try {
    createWeek3Routes(db,()=>null);db.prepare('INSERT INTO week3_sessions(id,title,createdAt) VALUES (?,?,?)').run('a','A',1);db.prepare('INSERT INTO week3_sessions(id,title,createdAt) VALUES (?,?,?)').run('b','B',1);
    const events=[event('a','original','Meeting is at 13:00.',1),event('a','change','We agreed to move the meeting to 16:00.',2),event('a','later','We agreed to move the meeting to 17:00.',3)];
    const insert=db.prepare('INSERT INTO week3_history_events VALUES (?,?,?,?,?)');for(const e of events)insert.run(e.id,e.sessionId,e.sequence!,e.type,JSON.stringify(e.payload));
    let repository=createTopicRepository(db);
    const first=candidate('original','Meeting is at 13:00.',1,'13:00');
    expect(persistAssessedTopic(repository,'a',events,first,assessment('original','Meeting is at 13:00.','fact'),0).decision).toBe('accept');
    const second=candidate('change','We agreed to move the meeting to 16:00.',2,'16:00');const decision=assessment('change','We agreed to move the meeting to 16:00.','change');
    expect(persistAssessedTopic(repository,'a',events,second,decision,1,current('13:00')).decision).toBe('accept');
    expect(persistAssessedTopic(repository,'a',events,second,decision,2,current('16:00')).decision).toBe('accept');
    const third=candidate('later','We agreed to move the meeting to 17:00.',3,'17:00');
    expect(persistAssessedTopic(repository,'a',events,third,assessment('later','We agreed to move the meeting to 17:00.','change'),2,current('16:00')).decision).toBe('accept');
    expect(repository.catalog('a')).toEqual({topics:[{key:'Meeting',value:'17:00',status:'confirmed',revision:3}],nextCursor:null});
    expect(()=>persistAssessedTopic(repository,'a',events,third,assessment('later','We agreed to move the meeting to 17:00.','change'),1,current('16:00'))).toThrow('revision conflict');
    expect(repository.get('b','Meeting')).toBeNull();db.close();db=new DatabaseSync(path);repository=createTopicRepository(db);
    const restored=repository.get('a','Meeting');expect(restored).toMatchObject({key:'Meeting',value:'17:00',revision:3,historyOrder:'processing_order_not_verified_chronology',history:[{ordinal:1,kind:'creation',previousValue:null,newValue:'13:00'},{ordinal:2,kind:'update',previousValue:'13:00',newValue:'16:00',evidence:[{messageId:'change',role:'user',sequence:2}]},{ordinal:3,previousValue:'16:00',newValue:'17:00'}]});
    expect(db.prepare('SELECT COUNT(*) AS count FROM week3_history_events').get()).toMatchObject({count:3});
  } finally {db.close();await rm(dir,{recursive:true,force:true});}
});

it('defers proposals and rolls back when an evidence write fails',async()=>{
  const db=new DatabaseSync(':memory:');try {
    createWeek3Routes(db,()=>null);db.prepare('INSERT INTO week3_sessions(id,title,createdAt) VALUES (?,?,?)').run('a','A',1);
    const original=event('a','original','Meeting is at 13:00.',1),proposal=event('a','proposal','Maybe move it to 16:00.',2),update=event('a','update','We agreed to move the meeting to 16:00.',3);const events=[original,proposal,update];
    const insert=db.prepare('INSERT INTO week3_history_events VALUES (?,?,?,?,?)');for(const e of events)insert.run(e.id,e.sessionId,e.sequence!,e.type,JSON.stringify(e.payload));
    const repository=createTopicRepository(db);persistAssessedTopic(repository,'a',events,candidate('original','Meeting is at 13:00.',1,'13:00'),assessment('original','Meeting is at 13:00.','fact'),0);
    expect(persistAssessedTopic(repository,'a',events,candidate('proposal','Maybe move it to 16:00.',2,'16:00'),assessment('proposal','Maybe move it to 16:00.','proposal'),1,current('13:00')).decision).toBe('defer');
    expect(persistAssessedTopic(repository,'a',events,candidate('update','We agreed to move the meeting to 16:00.',3,'16:00'),{...assessment('update','We agreed to move the meeting to 16:00.','change'),factSupported:false},1,current('13:00')).decision).toBe('reject');
    expect(persistAssessedTopic(repository,'a',events,candidate('update','We agreed to move the meeting to 16:00.',3,'16:00'),assessment('update','We agreed to move the meeting to 16:00.','correction'),1,current('13:00')).decision).toBe('defer');
    expect(()=>persistAssessedTopic(repository,'other',events,candidate('update','We agreed to move the meeting to 16:00.',3,'16:00'),assessment('update','We agreed to move the meeting to 16:00.','change'),0)).toThrow('another session');
    const before=repository.get('a','Meeting');db.exec("CREATE TRIGGER fail_topic_evidence BEFORE INSERT ON week3_topic_evidence WHEN NEW.message_id='update' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
    expect(()=>persistAssessedTopic(repository,'a',events,candidate('update','We agreed to move the meeting to 16:00.',3,'16:00'),assessment('update','We agreed to move the meeting to 16:00.','change'),1,current('13:00'))).toThrow('synthetic failure');
    expect(repository.get('a','Meeting')).toEqual(before);
  } finally {db.close();}
});
