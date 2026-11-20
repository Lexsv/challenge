import { describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { createTurnContextStore } from '../server/turn-context';
import { createInstructionCoordinator } from '../server/instruction-coordinator';
import { createInstructionProposalStore } from '../server/instruction-proposals';
import { createInstructionDetector } from './persistent-instruction-detector';
import { createServerInstructionDetector } from '../server/instruction-detector-config';
import { createProviderRegistry } from './provider-registry';
import type { RequestMeter } from './token-meter';
import type { ManagerLlmAdapter } from './manager-agent';
import type { PersonalizationSnapshot } from './week3-session-api';

const require=createRequire(import.meta.url);
type Profile={id:string;name:string;habits:string;revision:number;is_system:number};
const {createContextProfileRepository}=require('../server/context-profile-repository.mjs') as {createContextProfileRepository:(db:DatabaseSync)=>{create(name:string,habits:string):Profile;get(id:string):Profile|null;update(id:string,name:string,habits:string,revision:number):Profile}};
const {resolveSessionPersonalization}=require('../server/session-personalization.mjs') as {resolveSessionPersonalization:(db:DatabaseSync,id:string)=>{ok:true;data:PersonalizationSnapshot}|{ok:false;error:string}};
const refs={sessionId:'s',runId:'r',messageId:'m'};
const message='Always use examples. Answer in detail. Stop greetings.';
const add={action:'ADD',sourceQuote:'Always use examples.',newInstruction:'Use examples.'};
const update={action:'UPDATE',sourceQuote:'Answer in detail.',targetLine:'* Answer briefly.',newInstruction:'Answer in detail.'};
const remove={action:'REMOVE',sourceQuote:'Stop greetings.',targetLine:'* Use greetings.'};

function setup(operations:unknown[]=[], mode:'regular'|'general'='regular', scenario?:{habits:string;message:string}){
  const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');const profiles=createContextProfileRepository(db);
  db.exec('CREATE TABLE week3_sessions(id TEXT PRIMARY KEY,profile_id TEXT NOT NULL REFERENCES context_profiles(id)); CREATE TABLE week3_history_events(id TEXT PRIMARY KEY,sessionId TEXT NOT NULL,sequence INTEGER NOT NULL,type TEXT NOT NULL,payload TEXT NOT NULL CHECK(json_valid(payload)),UNIQUE(sessionId,sequence))');
  const profile=mode==='regular' ? profiles.create('Synthetic',scenario?.habits ?? 'legacy\n* Answer briefly.\n* Use greetings.') : profiles.get('general')!;
  db.prepare('INSERT INTO week3_sessions VALUES(?,?)').run('s',profile.id);
  const insert=(id:string,sequence:number,type:string,payload:unknown)=>db.prepare('INSERT INTO week3_history_events VALUES(?,?,?,?,?)').run(id,'s',sequence,type,JSON.stringify(payload));
  insert('u',1,'message',{id:'m',conversationId:'s',runId:'r',role:'user',type:'text',text:scenario?.message ?? message});
  insert('start',2,'run',{id:'r',conversationId:'s',status:'running',messageIds:['m']});
  insert('answer',3,'message',{id:'a',conversationId:'s',runId:'r',role:'assistant',type:'text',text:'Already completed answer'});
  insert('end',4,'run',{id:'r',conversationId:'s',status:'completed',messageIds:['m','a']});
  let time=0;const contexts=createTurnContextStore({resolve:id=>resolveSessionPersonalization(db,id),now:()=>time,ttlMs:10});
  const created=contexts.create(refs);if(!created.ok)throw Error('fixture');
  const complete=vi.fn<ManagerLlmAdapter['complete']>().mockResolvedValue({text:JSON.stringify({operations})});
  const adapter:ManagerLlmAdapter={complete,context:{assess:async()=>({tokens:1,limit:100}),summarize:async()=>''}};
  const detector=createInstructionDetector(adapter);
  const proposals=createInstructionProposalStore({now:()=>time,ttlMs:10});
  const coordinator=createInstructionCoordinator({db,profiles,resolve:resolveSessionPersonalization,contexts,detector,proposals});
  return {db,profiles,profile,contexts,proposals,complete,detector,coordinator,insert,advance:(n:number)=>{time+=n;},request:{...refs,turnToken:created.token}};
}

async function accept(coordinator:ReturnType<typeof createInstructionCoordinator>,request:ReturnType<typeof setup>['request']) {
  const proposal=await coordinator.process(request);
  if(proposal.status!=='confirmation_required')return proposal;
  return coordinator.decide({sessionId:request.sessionId,proposalId:proposal.proposalId,decision:'accept'});
}
describe('isolated instruction coordinator',()=>{
  it('offers the captured English replacement without persistence until explicit acceptance',async()=>{
    const message='From now on, always answer in long form with detailed explanations and practical examples instead of short answers.';
    const habits='* Always respond in Russian.\n* Always provide short, concise answers.';
    const operation={action:'UPDATE',sourceQuote:message,targetLine:'* Always provide short, concise answers.',newInstruction:'Provide long, detailed answers with practical examples.'};
    const f=setup([operation],'regular',{habits,message});try{
      const pending=await f.coordinator.process(f.request);
      expect(pending.status).toBe('confirmation_required');
      expect(f.profiles.get(f.profile.id)).toMatchObject({habits,revision:1});
      if(pending.status!=='confirmation_required')throw Error('missing proposal');
      expect(f.coordinator.decide({sessionId:'s',proposalId:pending.proposalId,decision:'accept'})).toEqual({status:'applied',revision:2});
      expect(f.profiles.get(f.profile.id)?.habits).toBe('* Always respond in Russian.\n* Provide long, detailed answers with practical examples.');
    }finally{f.db.close();}
  });
  it('holds the original validated result without writing until a one-time decision',async()=>{
    const f=setup([add]);try {
      const before=f.profiles.get(f.profile.id),pending=await f.coordinator.process(f.request);
      expect(pending.status).toBe('confirmation_required');expect(f.profiles.get(f.profile.id)).toEqual(before);
      if(pending.status!=='confirmation_required')throw Error('missing proposal');
      expect(f.coordinator.decide({sessionId:'wrong',proposalId:pending.proposalId,decision:'accept'})).toEqual({status:'invalid_proposal'});
      expect(f.coordinator.decide({sessionId:'s',proposalId:pending.proposalId,decision:'accept'})).toEqual({status:'applied',revision:2});
      expect(f.coordinator.decide({sessionId:'s',proposalId:pending.proposalId,decision:'accept'})).toEqual({status:'invalid_proposal'});
      expect(f.profiles.get(f.profile.id)?.revision).toBe(2);
    }finally{f.db.close();}
  });
  it('rejects or expires a proposal without changing the profile',async()=>{
    for(const action of ['reject','expire'] as const){
      const f=setup([add]);try{
        const pending=await f.coordinator.process(f.request);if(pending.status!=='confirmation_required')throw Error('missing proposal');
        if(action==='expire')f.advance(10);
        expect(f.coordinator.decide({sessionId:'s',proposalId:pending.proposalId,decision:action==='reject'?'reject':'accept'})).toEqual({status:action==='reject'?'rejected':'expired_proposal'});
        expect(f.profiles.get(f.profile.id)).toMatchObject({habits:f.profile.habits,revision:1});
      }finally{f.db.close();}
    }
  });
  it('does not apply a proposal after the profile changes',async()=>{
    const f=setup([add]);try{
      const pending=await f.coordinator.process(f.request);if(pending.status!=='confirmation_required')throw Error('missing proposal');
      f.profiles.update(f.profile.id,'Synthetic','newer',1);
      expect(f.coordinator.decide({sessionId:'s',proposalId:pending.proposalId,decision:'accept'})).toEqual({status:'conflict'});
      expect(f.profiles.get(f.profile.id)?.habits).toBe('newer');
    }finally{f.db.close();}
  });
  it('only claims one simultaneous decision',async()=>{
    const f=setup([add]);try{
      const pending=await f.coordinator.process(f.request);if(pending.status!=='confirmation_required')throw Error('missing proposal');
      const decide=()=>f.coordinator.decide({sessionId:'s',proposalId:pending.proposalId,decision:'accept'});
      const results=await Promise.all([Promise.resolve().then(decide),Promise.resolve().then(decide)]);
      expect(results).toContainEqual({status:'applied',revision:2});expect(results).toContainEqual({status:'invalid_proposal'});
    }finally{f.db.close();}
  });
  it('asks for clarification and makes no write for the captured contradictory ADD',async()=>{
    const message='С этого момента отвечай подробно. Давай развёрнутые объяснения с примерами, даже если вопрос простой.';
    const habits='* Always respond in Russian.\n* Keep answers short and concise.';
    const operation={action:'ADD',sourceQuote:message,newInstruction:'Отвечай подробно и давай развёрнутые объяснения с примерами, даже если вопрос простой.'};
    const f=setup([operation],'regular',{habits,message});try{
      const update=vi.spyOn(f.profiles,'update');
      expect(await f.coordinator.process(f.request)).toEqual({status:'clarification_required'});
      expect(update).not.toHaveBeenCalled();
      expect(f.profiles.get(f.profile.id)).toMatchObject({habits,revision:1});
    }finally{f.db.close();}
  });
  it('replaces the short-answer rule for the captured Russian instruction and preserves language',async()=>{
    const message='С этого момента отвечай подробно. Давай развёрнутые объяснения с примерами, даже если вопрос простой.';
    const habits='* Always respond in Russian.\n* Keep answers short and concise.';
    const operation={action:'UPDATE',sourceQuote:message,targetLine:'* Keep answers short and concise.',newInstruction:'Provide detailed explanations with examples, even for simple questions.'};
    const f=setup([operation],'regular',{habits,message});try{
      expect(await accept(f.coordinator,f.request)).toEqual({status:'applied',revision:2});
      expect(f.profiles.get(f.profile.id)?.habits).toBe('* Always respond in Russian.\n* Provide detailed explanations with examples, even for simple questions.');
    }finally{f.db.close();}
  });
  it('removes the requested rule while preserving the unrelated language rule',async()=>{
    const message='Stop keeping answers short.';
    const habits='* Always respond in Russian.\n* Keep answers short and concise.';
    const operation={action:'REMOVE',sourceQuote:message,targetLine:'* Keep answers short and concise.'};
    const f=setup([operation],'regular',{habits,message});try{
      expect(await accept(f.coordinator,f.request)).toEqual({status:'applied',revision:2});
      expect(f.profiles.get(f.profile.id)?.habits).toBe('* Always respond in Russian.\n');
    }finally{f.db.close();}
  });
  it('does not write when the detector returns the captured malformed bare operation',async()=>{
    const f=setup();try{
      f.complete.mockResolvedValue({text:JSON.stringify(add)});
      expect(await f.coordinator.process(f.request)).toEqual({status:'detector_failure'});
      expect(f.profiles.get(f.profile.id)).toMatchObject({habits:f.profile.habits,revision:1});
    }finally{f.db.close();}
  });
  it('runs the configured server detector through the unchanged coordinator',async()=>{
    const f=setup();try{
      const meters:RequestMeter[]=[],transport=vi.fn(async()=>({status:200,body:{output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({operations:[add]})}]}],usage:{input_tokens:10,output_tokens:5,total_tokens:15}}}));
      const detector=createServerInstructionDetector({providerId:'openai',model:'gpt-5.6-terra'},createProviderRegistry(undefined,{}, {catalogStorage:()=>undefined}),async meter=>{meters.push(meter);},transport);
      const coordinator=createInstructionCoordinator({db:f.db,profiles:f.profiles,resolve:resolveSessionPersonalization,contexts:f.contexts,detector});
      expect(await accept(coordinator,f.request)).toEqual({status:'applied',revision:2});
      expect(f.profiles.get(f.profile.id)?.habits).toContain('* Use examples.');expect(transport).toHaveBeenCalledOnce();
      expect(meters.length).toBeGreaterThan(0);expect(meters.every(meter=>meter.requestKind==='extraction')).toBe(true);
    }finally{f.db.close();}
  });
  it('leaves habits unchanged when the configured detector has no saved credential',async()=>{
    const f=setup();try{
      const detector=createServerInstructionDetector({providerId:'openai',model:'gpt-5.6-terra'},createProviderRegistry(undefined,{}, {catalogStorage:()=>undefined}),async()=>{},async()=>({status:404,body:{saved:false}}));
      const coordinator=createInstructionCoordinator({db:f.db,profiles:f.profiles,resolve:resolveSessionPersonalization,contexts:f.contexts,detector});
      expect(await coordinator.process(f.request)).toEqual({status:'detector_failure'});
      expect(f.profiles.get(f.profile.id)).toMatchObject({habits:f.profile.habits,revision:1});
    }finally{f.db.close();}
  });
  it.each([[add,'legacy\n* Answer briefly.\n* Use greetings.\n* Use examples.'],[update,'legacy\n* Answer in detail.\n* Use greetings.'],[remove,'legacy\n* Answer briefly.\n']] as const)('persists a validated proposal while leaving history intact',async(op,expected)=>{
    const f=setup([op]);try{
      const before=f.db.prepare('SELECT * FROM week3_history_events ORDER BY sequence').all();
      expect(await accept(f.coordinator,f.request)).toEqual({status:'applied',revision:2});
      expect(f.profiles.get(f.profile.id)?.habits).toBe(expected);
      expect(f.db.prepare('SELECT * FROM week3_history_events ORDER BY sequence').all()).toEqual(before);
      expect(f.complete).toHaveBeenCalledOnce();expect(f.complete.mock.calls[0][0].tools).toEqual([]);
    }finally{f.db.close();}
  });
  it('handles no instruction without a write or second assistant response',async()=>{
    const f=setup();try{expect(await f.coordinator.process(f.request)).toEqual({status:'unchanged',revision:1});expect(f.profiles.get(f.profile.id)?.revision).toBe(1);expect(f.db.prepare("SELECT count(*) AS n FROM week3_history_events WHERE type='message'").get()?.n).toBe(2);}finally{f.db.close();}
  });
  it('skips General without calling the detector',async()=>{
    const f=setup([add],'general');try{expect(await f.coordinator.process(f.request)).toEqual({status:'general_skipped'});expect(f.complete).not.toHaveBeenCalled();expect(f.profiles.get('general')?.revision).toBe(1);}finally{f.db.close();}
  });
  it('rejects reuse, expiration, mismatched references, and extra client fields',async()=>{
    const f=setup();try{
      expect(await f.coordinator.process({...f.request,runId:'wrong'})).toEqual({status:'mismatch'});
      expect(await f.coordinator.process({...f.request,messageId:'wrong'})).toEqual({status:'mismatch'});
      expect(await f.coordinator.process({...f.request,sessionId:'wrong'})).toEqual({status:'mismatch'});
      const injected={...f.request,habits:'injected'};
      expect(await f.coordinator.process(injected)).toEqual({status:'mismatch'});
      expect(await f.coordinator.process(f.request)).toMatchObject({status:'unchanged'});
      expect(await f.coordinator.process(f.request)).toEqual({status:'invalid_token'});
    }finally{f.db.close();}
    const expired=setup();try{expired.advance(10);expect(await expired.coordinator.process(expired.request)).toEqual({status:'invalid_token'});}finally{expired.db.close();}
  });
  it('rejects missing, duplicate, or inconsistent archived messages',async()=>{
    for(const kind of ['missing','duplicate','wrong-role','wrong-run'] as const){
      const f=setup([add]);try{
        if(kind==='missing')f.db.prepare("DELETE FROM week3_history_events WHERE id='u'").run();
        if(kind==='duplicate')f.insert('u2',5,'message',{id:'m',conversationId:'s',runId:'r',role:'user',type:'text',text:message});
        if(kind==='wrong-role')f.db.prepare("UPDATE week3_history_events SET payload=json_set(payload,'$.role','assistant') WHERE id='u'").run();
        if(kind==='wrong-run')f.db.prepare("UPDATE week3_history_events SET payload=json_set(payload,'$.runId','other') WHERE id='u'").run();
        expect(await f.coordinator.process(f.request)).toEqual({status:kind==='missing'?'missing_message':kind==='duplicate'?'ambiguous_message':'mismatch'});
        expect(f.complete).not.toHaveBeenCalled();expect(f.profiles.get(f.profile.id)?.revision).toBe(1);
      }finally{f.db.close();}
    }
  });
  it('requires a completed consistent run and detects multiple user messages',async()=>{
    const f=setup([add]);try{f.db.prepare("UPDATE week3_history_events SET payload=json_set(payload,'$.status','failed') WHERE id='end'").run();expect(await f.coordinator.process(f.request)).toEqual({status:'incomplete_run'});}finally{f.db.close();}
    const g=setup([add]);try{g.insert('extra-user',5,'message',{id:'another',conversationId:'s',runId:'r',role:'user',type:'text',text:'Other'});expect(await g.coordinator.process(g.request)).toEqual({status:'ambiguous_message'});}finally{g.db.close();}
    const h=setup([add]);try{h.db.prepare("DELETE FROM week3_history_events WHERE id='answer'").run();expect(await h.coordinator.process(h.request)).toEqual({status:'incomplete_run'});expect(h.complete).not.toHaveBeenCalled();}finally{h.db.close();}
  });
  it('rejects a stale snapshot before invoking the detector',async()=>{
    const f=setup([add]);try{f.profiles.update(f.profile.id,'Synthetic','newer',1);expect(await f.coordinator.process(f.request)).toEqual({status:'conflict'});expect(f.complete).not.toHaveBeenCalled();}finally{f.db.close();}
  });
  it('rejects a profile edit that occurs while detection is in flight',async()=>{
    const f=setup([add]);try{
      let release!:()=>void;let started!:()=>void;
      const waiting=new Promise<void>(resolve=>{release=resolve;}),entered=new Promise<void>(resolve=>{started=resolve;});
      f.complete.mockImplementation(async()=>{started();await waiting;return {text:JSON.stringify({operations:[add]})};});
      const pending=f.coordinator.process(f.request);await entered;
      f.profiles.update(f.profile.id,'Synthetic','newer',1);release();
      expect(await pending).toEqual({status:'conflict'});expect(f.profiles.get(f.profile.id)?.habits).toBe('newer');
    }finally{f.db.close();}
  });
  it('persists independent operations atomically and rejects duplicate proposals',async()=>{
    const f=setup([add,update,remove]);try{
      expect(await accept(f.coordinator,f.request)).toEqual({status:'applied',revision:2});
      expect(f.profiles.get(f.profile.id)?.habits).toBe('legacy\n* Answer in detail.\n* Use examples.\n');
    }finally{f.db.close();}
    const g=setup([add,add]);try{expect(await g.coordinator.process(g.request)).toEqual({status:'detector_failure'});expect(g.profiles.get(g.profile.id)?.revision).toBe(1);}finally{g.db.close();}
  });
  it('returns detector and persistence failures without altering the completed answer',async()=>{
    const f=setup([add]);try{f.complete.mockRejectedValue(new Error('private detail'));expect(await f.coordinator.process(f.request)).toEqual({status:'detector_failure'});expect(f.profiles.get(f.profile.id)?.revision).toBe(1);}finally{f.db.close();}
    const g=setup([add]);try{
      const profiles={...g.profiles,update:()=>{throw Error('write failed');}};
      const coordinator=createInstructionCoordinator({db:g.db,profiles,resolve:resolveSessionPersonalization,contexts:g.contexts,detector:g.detector});
      expect(await accept(coordinator,g.request)).toEqual({status:'persistence_failure'});expect(g.profiles.get(g.profile.id)?.revision).toBe(1);
    }finally{g.db.close();}
  });
  it('allows only one concurrent request to write',async()=>{
    const f=setup([add]);try{
      const results=await Promise.all([f.coordinator.process(f.request),f.coordinator.process(f.request)]);
      expect(results.some(result=>result.status==='confirmation_required')).toBe(true);expect(results).toContainEqual({status:'invalid_token'});
      const pending=results.find(result=>result.status==='confirmation_required');
      if(!pending || pending.status!=='confirmation_required')throw Error('missing proposal');
      expect(f.coordinator.decide({sessionId:'s',proposalId:pending.proposalId,decision:'accept'})).toEqual({status:'applied',revision:2});
      expect(f.profiles.get(f.profile.id)?.revision).toBe(2);expect(f.complete).toHaveBeenCalledOnce();
    }finally{f.db.close();}
  });
  it('reports unknown commit without retrying a successful write',async()=>{
    const f=setup([add]);try{
      const db={get isTransaction(){return f.db.isTransaction;},exec:(sql:string)=>{f.db.exec(sql);if(sql==='COMMIT')throw Error('lost response');},prepare:f.db.prepare.bind(f.db)};
      const coordinator=createInstructionCoordinator({db,profiles:f.profiles,resolve:(_db,id)=>resolveSessionPersonalization(f.db,id),contexts:f.contexts,detector:f.detector});
      expect(await accept(coordinator,f.request)).toEqual({status:'unknown_commit'});
      expect(f.profiles.get(f.profile.id)?.revision).toBe(2);
      expect(await coordinator.process(f.request)).toEqual({status:'invalid_token'});
    }finally{f.db.close();}
  });
});
