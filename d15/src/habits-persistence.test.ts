import { describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { createHabitsPersistence, type HabitsPersistenceInput } from '../server/habits-persistence';
import { createInstructionDetector, parseInstructionProposals } from './persistent-instruction-detector';
import type { ManagerLlmAdapter } from './manager-agent';

const require=createRequire(import.meta.url);
type Profile={id:string;name:string;habits:string;revision:number;is_system:number};
const {createContextProfileRepository}=require('../server/context-profile-repository.mjs') as {createContextProfileRepository:(db:DatabaseSync)=>{create(name:string,habits:string):Profile;get(id:string):Profile|null;update(id:string,name:string,habits:string,revision:number):Profile}};
const {resolveSessionPersonalization}=require('../server/session-personalization.mjs') as {resolveSessionPersonalization:(db:DatabaseSync,id:string)=>{ok:true;data:{sessionId:string;profileId:string;profileRevision:number;habits:string}}|{ok:false;error:string}};
const message='Always use examples. Answer in detail. Stop greetings.';
const add={action:'ADD',sourceQuote:'Always use examples.',newInstruction:'Use examples.'};
const update={action:'UPDATE',sourceQuote:'Answer in detail.',targetLine:'* Answer briefly.',newInstruction:'Answer in detail.'};
const remove={action:'REMOVE',sourceQuote:'Stop greetings.',targetLine:'* Use greetings.'};

function fixture() {
  const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');
  const profiles=createContextProfileRepository(db);
  db.exec('CREATE TABLE week3_sessions(id TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES context_profiles(id))');
  const profile=profiles.create('Test','legacy\n* Answer briefly.\n* Use greetings.');
  db.prepare('INSERT INTO week3_sessions VALUES (?,?)').run('session',profile.id);
  db.prepare('INSERT INTO week3_sessions VALUES (?,?)').run('general-session','general');
  const snapshot={sessionId:'session',profileId:profile.id,profileRevision:profile.revision,habits:profile.habits};
  const service=createHabitsPersistence({db,profiles,resolve:resolveSessionPersonalization});
  return {db,profiles,profile,snapshot,service};
}
async function detect(habits:string,operations:unknown[],userMessage=message) {
  const adapter:ManagerLlmAdapter={complete:async()=>({text:JSON.stringify({operations})}),context:{assess:async()=>({tokens:1,limit:100}),summarize:async()=>''}};
  return createInstructionDetector(adapter).detect({userMessage,habits});
}
async function request(f:ReturnType<typeof fixture>,operations:unknown[]):Promise<HabitsPersistenceInput> {
  return {sessionId:'session',userMessage:message,snapshot:f.snapshot,detectorResult:await detect(f.snapshot.habits,operations)};
}

describe('isolated revision-safe habits persistence',()=>{
  it.each([[add,'legacy\n* Answer briefly.\n* Use greetings.\n* Use examples.'],[update,'legacy\n* Answer in detail.\n* Use greetings.'],[remove,'legacy\n* Answer briefly.\n']] as const)('applies a validated operation and preserves unrelated text',async(op,expected)=>{
    const f=fixture();try{expect(f.service.apply(await request(f,[op]))).toEqual({status:'applied',revision:2});expect(f.profiles.get(f.profile.id)).toMatchObject({name:'Test',habits:expected,revision:2});}finally{f.db.close();}
  });
  it('commits independent operations together',async()=>{
    const f=fixture();try{expect(f.service.apply(await request(f,[add,update,remove]))).toEqual({status:'applied',revision:2});expect(f.profiles.get(f.profile.id)?.habits).toBe('legacy\n* Answer in detail.\n* Use examples.\n');}finally{f.db.close();}
  });
  it('protects General and rejects session/profile substitution',async()=>{
    const f=fixture();try{
      const snapshot={sessionId:'general-session',profileId:'general',profileRevision:1,habits:''};
      const result=await detect('',[add]);
      expect(f.service.apply({sessionId:'general-session',userMessage:message,snapshot,detectorResult:result})).toEqual({status:'error',code:'general_immutable'});
      expect(f.service.apply({...await request(f,[add]),sessionId:'general-session',snapshot:{...f.snapshot,sessionId:'general-session'}})).toEqual({status:'error',code:'invalid_session'});
      expect(f.profiles.get('general')).toMatchObject({habits:'',revision:1});
    }finally{f.db.close();}
  });
  it('rejects stale and concurrent profile edits rather than replaying proposals',async()=>{
    const f=fixture();try{const req=await request(f,[add]);f.profiles.update(f.profile.id,'Renamed','Newer text',1);expect(f.service.apply(req)).toEqual({status:'conflict'});expect(f.profiles.get(f.profile.id)).toMatchObject({name:'Renamed',habits:'Newer text',revision:2});}finally{f.db.close();}
  });
  it('rejects a stale habits snapshot even when its revision is unchanged',async()=>{
    const f=fixture();try{
      const snapshot={...f.snapshot,habits:'Different old text'};
      const detectorResult=await detect(snapshot.habits,[add]);
      expect(f.service.apply({sessionId:'session',userMessage:message,snapshot,detectorResult})).toEqual({status:'conflict'});
      expect(f.profiles.get(f.profile.id)?.habits).toBe(f.snapshot.habits);
    }finally{f.db.close();}
  });
  it('reports unchanged for successful empty extraction',async()=>{
    const f=fixture();try{expect(f.service.apply(await request(f,[]))).toEqual({status:'unchanged',revision:1});expect(f.profiles.get(f.profile.id)?.revision).toBe(1);}finally{f.db.close();}
  });
  it('rejects parsed or forged results and failed, duplicate or conflicting detection',async()=>{
    const f=fixture();try{
      const forged=parseInstructionProposals({userMessage:message,habits:f.snapshot.habits},JSON.stringify({operations:[add]}));
      expect(f.service.apply({sessionId:'session',userMessage:message,snapshot:f.snapshot,detectorResult:forged})).toEqual({status:'error',code:'invalid_proposal'});
      for(const ops of [[add,add],[update,{...remove,targetLine:update.targetLine}],[{...add,sourceQuote:'invented'}]])expect(f.service.apply(await request(f,ops))).toEqual({status:'error',code:'invalid_proposal'});
      const valid=await request(f,[add]);expect(f.service.apply({...valid,userMessage:'different'})).toEqual({status:'error',code:'invalid_proposal'});
      if(valid.detectorResult.ok){expect(Object.isFrozen(valid.detectorResult)).toBe(true);expect(Object.isFrozen(valid.detectorResult.operations[0])).toBe(true);}
      expect(f.profiles.get(f.profile.id)?.revision).toBe(1);
    }finally{f.db.close();}
  });
  it('fails safely if a transaction cannot begin',async()=>{
    const f=fixture();try{
      const db={isTransaction:false,exec:()=>{throw new Error('locked');}};
      const service=createHabitsPersistence({db,profiles:f.profiles,resolve:(_db,id)=>resolveSessionPersonalization(f.db,id)});
      expect(service.apply(await request(f,[add]))).toEqual({status:'error',code:'storage_failure'});
      expect(f.profiles.get(f.profile.id)?.revision).toBe(1);
    }finally{f.db.close();}
  });
  it('rolls back a write that throws after the update',async()=>{
    const f=fixture();try{
      const profiles={...f.profiles,update:(...args:Parameters<typeof f.profiles.update>)=>{f.profiles.update(...args);throw new Error('write failed');}};
      const service=createHabitsPersistence({db:f.db,profiles,resolve:resolveSessionPersonalization});
      expect(service.apply(await request(f,[add]))).toEqual({status:'error',code:'storage_failure'});
      expect(f.profiles.get(f.profile.id)).toMatchObject({habits:f.snapshot.habits,revision:1});
    }finally{f.db.close();}
  });
  it('rereads an uncertain commit and never claims success merely from matching state',async()=>{
    const f=fixture();try{
      const db={get isTransaction(){return f.db.isTransaction;},exec:(sql:string)=>{f.db.exec(sql);if(sql==='COMMIT')throw new Error('lost confirmation');}};
      const get=vi.fn(f.profiles.get),service=createHabitsPersistence({db,profiles:{...f.profiles,get},resolve:(_db,id)=>resolveSessionPersonalization(f.db,id)});
      expect(service.apply(await request(f,[add]))).toEqual({status:'error',code:'unknown_commit',reconciliation:'matches'});
      expect(get).toHaveBeenCalledTimes(2);expect(f.profiles.get(f.profile.id)?.revision).toBe(2);
    }finally{f.db.close();}
  });
  it('retains unknown outcome when rereading fails',async()=>{
    const f=fixture();try{
      const db={get isTransaction(){return f.db.isTransaction;},exec:(sql:string)=>{f.db.exec(sql);if(sql==='COMMIT')throw new Error('lost confirmation');}};
      let reads=0;const profiles={...f.profiles,get:(id:string)=>{if(++reads===2)throw new Error('offline');return f.profiles.get(id);}};
      const service=createHabitsPersistence({db,profiles,resolve:(_db,id)=>resolveSessionPersonalization(f.db,id)});
      expect(service.apply(await request(f,[add]))).toEqual({status:'error',code:'unknown_commit',reconciliation:'unavailable'});
    }finally{f.db.close();}
  });
});
