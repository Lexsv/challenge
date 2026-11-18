import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWeek3Routes } from '../server/week3-sessions.mjs';
import { createTopicRepository, type ControlledTopicProposal } from '../server/topic-repository.mjs';
import type { TopicCandidate } from './topic-memory';
import type { SemanticAssessment } from './topic-semantic';

const message='The meeting is at 16:00 and the project uses SQLite.';
function setup(db:DatabaseSync){createWeek3Routes(db,()=>null);db.prepare('INSERT INTO week3_sessions(id,title,createdAt) VALUES (?,?,?)').run('s','Test',1);db.prepare('INSERT INTO week3_sessions(id,title,createdAt) VALUES (?,?,?)').run('other','Other',1);db.prepare('INSERT INTO week3_history_events VALUES (?,?,?,?,?)').run('event','s',1,'message',JSON.stringify({id:'m',conversationId:'s',runId:'r',createdAt:1,role:'user',type:'text',text:message}));}
function candidate(key:string,value:string):TopicCandidate{return {key,value,status:'confirmed',sources:['m'],evidence:[{messageId:'m',role:'user',sequence:1,quote:message,existence:'verified'}],assessment:{support:'unverified',change:'unverified'}};}
function assessment(kind:'fact'|'change'='fact',confirmed=false):SemanticAssessment{return {classification:kind,factSupported:true,changeConfirmed:confirmed,evidence:[{messageId:'m',quote:message}]};}
function add(key='Project',value='SQLite'):ControlledTopicProposal{return {candidate:candidate(key,value),recommendation:{action:'ADD',proposedContent:value,reason:'New topic'},assessment:assessment(),expectedTopicRevision:0};}
function update():ControlledTopicProposal{return {candidate:candidate('Meeting','16:00'),recommendation:{action:'UPDATE',targetKey:'Meeting',proposedContent:'16:00',reason:'Change'},assessment:assessment('change',true),expectedTopicRevision:1};}
function request(repo:ReturnType<typeof createTopicRepository>,proposals:ControlledTopicProposal[]){return {...repo.controlledSnapshot('s','r'),authorized:true as const,analysisComplete:true as const,candidateCount:proposals.length,proposals};}
function counts(db:DatabaseSync){return Object.fromEntries(['week3_topics','week3_topic_changes','week3_topic_evidence','week3_topic_segments'].map(table=>[table,(db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {n:number}).n]));}

describe('isolated controlled topic transaction',()=>{
  it('commits supported additions and marker together and repeats idempotently',()=>{
    const db=new DatabaseSync(':memory:');try{setup(db);const repo=createTopicRepository(db),req=request(repo,[add()]);
      expect(repo.commitControlledSegment('s','r',req)).toEqual({completed:true,alreadyCompleted:false});expect(repo.get('s','Project')).toMatchObject({value:'SQLite',revision:1});expect(counts(db)).toEqual({week3_topics:1,week3_topic_changes:1,week3_topic_evidence:1,week3_topic_segments:1});
      expect(repo.commitControlledSegment('s','r',req)).toEqual({completed:true,alreadyCompleted:true});expect((repo.get('s','Project') as {history:unknown[]}).history).toHaveLength(1);expect(repo.get('other','Project')).toBeNull();
    }finally{db.close();}
  });
  it('applies a confirmed update and keeps the previous value and source',()=>{
    const db=new DatabaseSync(':memory:');try{setup(db);db.prepare('INSERT INTO week3_topics VALUES (?,?,?,?,?)').run('s','Meeting','13:00','confirmed',1);const repo=createTopicRepository(db);
      repo.commitControlledSegment('s','r',request(repo,[update()]));expect(repo.get('s','Meeting')).toMatchObject({value:'16:00',revision:2,history:[{kind:'update',previousValue:'13:00',newValue:'16:00',evidence:[{messageId:'m',quote:message}]}]});
    }finally{db.close();}
  });
  it('blocks unconfirmed, unsupported, forged and mixed outcomes without any writes',()=>{
    for(const change of [{...assessment('change',true),changeConfirmed:false},{...assessment('change',true),factSupported:false},{...assessment('change',true),evidence:[{messageId:'m',quote:'invented'}]}]){
      const db=new DatabaseSync(':memory:');try{setup(db);db.prepare('INSERT INTO week3_topics VALUES (?,?,?,?,?)').run('s','Meeting','13:00','confirmed',1);const repo=createTopicRepository(db);const before=counts(db);
        expect(()=>repo.commitControlledSegment('s','r',request(repo,[add(),{...update(),assessment:change}]))).toThrow();expect(counts(db)).toEqual(before);expect(repo.get('s','Project')).toBeNull();expect(repo.segment('s',['r']).completed).toBe(false);
      }finally{db.close();}
    }
  });
  it('treats duplicates and skips as no-ops and refuses missing analysis or same-key conflicts',()=>{
    const db=new DatabaseSync(':memory:');try{setup(db);db.prepare('INSERT INTO week3_topics VALUES (?,?,?,?,?)').run('s','Meeting','13:00','confirmed',1);const repo=createTopicRepository(db);
      const duplicate:ControlledTopicProposal={candidate:candidate('Meeting','16:00'),recommendation:{action:'DUPLICATE',targetKey:'Meeting',reason:'Already represented'},expectedTopicRevision:1};
      const skip:ControlledTopicProposal={candidate:candidate('Ignored','ignored'),recommendation:{action:'SKIP',reason:'Noise'},expectedTopicRevision:0};
      expect(()=>repo.commitControlledSegment('s','r',{...request(repo,[add(),add()]),candidateCount:1})).toThrow();
      expect(()=>repo.commitControlledSegment('s','r',request(repo,[add(),add()]))).toThrow('Conflicting topic proposals');expect(repo.get('s','Project')).toBeNull();
      repo.commitControlledSegment('s','r',request(repo,[duplicate,skip]));expect(counts(db)).toEqual({week3_topics:1,week3_topic_changes:0,week3_topic_evidence:0,week3_topic_segments:1});
    }finally{db.close();}
  });
  it('fails closed when authorization, complete analysis, or evidence assessment is missing',()=>{
    const db=new DatabaseSync(':memory:');try{setup(db);const repo=createTopicRepository(db);const req=request(repo,[add()]);
      expect(()=>repo.commitControlledSegment('s','r',{...req,authorized:false} as never)).toThrow('unauthorized');
      expect(()=>repo.commitControlledSegment('s','r',{...req,analysisComplete:false} as never)).toThrow('unauthorized');
      expect(()=>repo.commitControlledSegment('s','r',request(repo,[{...add(),assessment:undefined}]))).toThrow('rejected or deferred');
      expect(counts(db)).toEqual({week3_topics:0,week3_topic_changes:0,week3_topic_evidence:0,week3_topic_segments:0});
    }finally{db.close();}
  });
  it('rejects stale catalog, topic revision, and changed source content',()=>{
    for(const mutation of ['catalog','topic','source'] as const){const db=new DatabaseSync(':memory:');try{setup(db);db.prepare('INSERT INTO week3_topics VALUES (?,?,?,?,?)').run('s','Meeting','13:00','confirmed',1);const repo=createTopicRepository(db);const req=request(repo,[update()]);
      if(mutation==='catalog')db.prepare('INSERT INTO week3_topics VALUES (?,?,?,?,?)').run('s','Other','x','confirmed',1);
      if(mutation==='topic')req.proposals[0].expectedTopicRevision=2;
      if(mutation==='source')db.prepare('UPDATE week3_history_events SET payload=? WHERE id=?').run(JSON.stringify({id:'m',conversationId:'s',runId:'r',createdAt:1,role:'user',type:'text',text:message+' extra'}),'event');
      const before=counts(db);expect(()=>repo.commitControlledSegment('s','r',req)).toThrow();expect(counts(db)).toEqual(before);expect(repo.segment('s',['r']).completed).toBe(false);
    }finally{db.close();}}
  });
  it('rolls back every mutation and the marker when the final evidence write fails',()=>{
    const db=new DatabaseSync(':memory:');try{setup(db);const repo=createTopicRepository(db);db.exec("CREATE TRIGGER fail_evidence BEFORE INSERT ON week3_topic_evidence WHEN NEW.topic_key='Second' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
      expect(()=>repo.commitControlledSegment('s','r',request(repo,[add(),add('Second','Another value')]))).toThrow('synthetic failure');expect(counts(db)).toEqual({week3_topics:0,week3_topic_changes:0,week3_topic_evidence:0,week3_topic_segments:0});
    }finally{db.close();}
  });
  it('restores retryability after interruption and completed markers after reopen',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'d11-controlled-'));const path=join(dir,'test.sqlite');let db=new DatabaseSync(path);
    try{setup(db);let repo=createTopicRepository(db);const req=request(repo,[add()]);db.close();db=new DatabaseSync(path);repo=createTopicRepository(db);expect(repo.segment('s',['r']).completed).toBe(false);
      repo.commitControlledSegment('s','r',req);db.close();db=new DatabaseSync(path);repo=createTopicRepository(db);expect(repo.commitControlledSegment('s','r',req)).toMatchObject({alreadyCompleted:true});expect(counts(db)).toEqual({week3_topics:1,week3_topic_changes:1,week3_topic_evidence:1,week3_topic_segments:1});
    }finally{db.close();await rm(dir,{recursive:true,force:true});}
  });
  it('handles competing SQLite writers without duplicate commits',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'d11-controlled-race-'));const path=join(dir,'test.sqlite');const first=new DatabaseSync(path);let second:DatabaseSync|undefined;
    try{setup(first);const a=createTopicRepository(first);second=new DatabaseSync(path);const b=createTopicRepository(second);const req=request(a,[add()]);
      first.exec('BEGIN IMMEDIATE');expect(()=>b.commitControlledSegment('s','r',req)).toThrow();expect(a.segment('s',['r']).completed).toBe(false);first.exec('ROLLBACK');
      expect(b.commitControlledSegment('s','r',req)).toMatchObject({alreadyCompleted:false});expect(a.commitControlledSegment('s','r',req)).toMatchObject({alreadyCompleted:true});expect(counts(first)).toEqual({week3_topics:1,week3_topic_changes:1,week3_topic_evidence:1,week3_topic_segments:1});
    }finally{second?.close();first.close();await rm(dir,{recursive:true,force:true});}
  });
});
