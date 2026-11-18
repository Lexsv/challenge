import { afterEach, expect, it, vi } from 'vitest';
import { createSessionServer } from '../server/sessions.mjs';
import { prepareProfileTurn, finishProfileTurn, instructionOutcomeNotice } from './instruction-turn-flow';
import { createSession, loadPersonalizationSnapshot, emptySession, saveHistoryEvent, loadSessionMemory, saveSessionMemory, completeInstructionTurn, decideInstructionProposal } from './week3-session-api';
import { ManagerAgent, type ManagerLlmAdapter } from './manager-agent';
import { createBuiltInToolRegistry } from './tool-runtime';
import { MemoryProcessor, SessionMemory } from './session-memory';
import { submitSession } from './session-send';

const servers:ReturnType<typeof createSessionServer>[]=[];
afterEach(async()=>{vi.unstubAllGlobals();await Promise.all(servers.splice(0).map(server=>new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()))));});
const add={action:'ADD',sourceQuote:'Always use examples.',newInstruction:'Use examples.'};
const update={action:'UPDATE',sourceQuote:'Answer in detail.',targetLine:'* Answer briefly.',newInstruction:'Answer in detail.'};
const remove={action:'REMOVE',sourceQuote:'Stop greetings.',targetLine:'* Use greetings.'};

it('handles typed confirmation previews and explicit decisions without sending change data',async()=>{
  const proposalId='a'.repeat(43),fetcher=vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({status:'confirmation_required',proposalId,expiresInMs:1000,changes:[{action:'UPDATE',before:'Old',after:'New'}]}),{status:200}))
    .mockResolvedValueOnce(new Response(JSON.stringify({status:'applied',revision:2}),{status:200}))
    .mockResolvedValueOnce(new Response(JSON.stringify({status:'expired_proposal'}),{status:200}));
  vi.stubGlobal('fetch',fetcher);
  expect(await completeInstructionTurn('s',{runId:'r',messageId:'m'},'b'.repeat(43))).toMatchObject({status:'confirmation_required',changes:[{action:'UPDATE',before:'Old',after:'New'}]});
  expect(await decideInstructionProposal('s',proposalId,'accept')).toEqual({status:'applied',revision:2});
  expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({proposalId,decision:'accept'});
  expect(await decideInstructionProposal('s',proposalId,'reject')).toEqual({status:'expired_proposal'});
});

it('holds proposed changes after completed answers while preserving history, memory and another profile',async()=>{
  const queue=[[add],[update],[remove]],meters:unknown[]=[];
  const transport=vi.fn(async()=>({status:200,body:{output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({operations:queue.shift()})}]}]}}));
  const server=createSessionServer(':memory:',{instructionDetector:{providerId:'openai',model:'gpt-5.6-terra'},instructionDetectorTransport:transport,instructionDetectorMeter:async meter=>{meters.push(meter);}});servers.push(server);
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address || typeof address==='string')throw Error('address');
  const base=`http://127.0.0.1:${address.port}`,realFetch=globalThis.fetch;
  vi.stubGlobal('fetch',vi.fn((resource:string|URL|Request,init?:RequestInit)=>realFetch(typeof resource==='string' && resource.startsWith('/')?base+resource:resource,init)));
  const createProfile=async(name:string,habits:string)=>await (await fetch('/api/users',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,habits})})).json();
  const profile=await createProfile('First','* Answer briefly.\n* Use greetings.'),other=await createProfile('Other','* Other preference.');
  const session=await createSession(profile.id),otherSession=await createSession(other.id),state=emptySession(session);
  const observed:string[]=[],adapter:ManagerLlmAdapter={complete:async ({messages})=>{observed.push(messages.find(item=>item.role==='developer')?.content ?? '');return {text:'Normal answer'};}};
  const processor=new MemoryProcessor(adapter);vi.spyOn(processor,'extract').mockResolvedValue([]);
  const memory=new SessionMemory({load:()=>loadSessionMemory(session.id),save:snapshot=>saveSessionMemory(session.id,snapshot)},processor,'gpt-4o-mini');
  for(const [index,question] of ['Always use examples.','Answer in detail.','Stop greetings.'].entries()){
    const prepared=await prepareProfileTurn(await loadPersonalizationSnapshot(session.id));
    expect(prepared.ids).toBeDefined();expect(prepared.token).toBeDefined();
    const result=await new ManagerAgent(adapter,createBuiltInToolRegistry()).run({state,userText:question,turnIds:prepared.ids,personalizationSnapshot:prepared.snapshot,sessionMemory:memory,onEvent:async event=>{await saveHistoryEvent(event);}});
    expect(result.finalResponse).toBe('Normal answer');expect(result.run.status).toBe('completed');
    const messages=state.messages.filter(item=>item.runId===result.run.id);
    await memory.finishCurrent(messages[0].id,messages.map(item=>({role:item.role,content:item.text})));
    const outcome=await finishProfileTurn(prepared);
    expect(outcome.applied).toBe(false);
    if(index===0)expect(outcome.proposal?.status).toBe('confirmation_required');
    else expect(outcome.notice).toBeTruthy();
    if(index===0)expect(observed[0]).not.toContain('Use examples.');
    if(index===1)expect(observed[1]).not.toContain('Use examples.');
    if(index===2)expect(observed[2]).not.toContain('Answer in detail.');
  }
  const final=await loadPersonalizationSnapshot(session.id),untouched=await loadPersonalizationSnapshot(otherSession.id);
  expect(final.habits).toBe('* Answer briefly.\n* Use greetings.');expect(final.profileRevision).toBe(1);
  expect(untouched.habits).toBe('* Other preference.');expect(untouched.profileRevision).toBe(1);
  const events=await (await fetch(`/api/week3/sessions/${session.id}/events`)).json();
  expect(events.filter((event:{type:string;payload:{role?:string}})=>event.type==='message' && event.payload.role==='user')).toHaveLength(3);
  expect(events.filter((event:{type:string;payload:{role?:string}})=>event.type==='message' && event.payload.role==='assistant')).toHaveLength(3);
  expect((await loadSessionMemory(session.id)).data?.short.length).toBeGreaterThan(0);
  expect(transport).toHaveBeenCalledTimes(3);expect(meters.length).toBeGreaterThan(0);
});

it('skips General without preparing or completing a detector turn',async()=>{
  const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
  const snapshot={sessionId:'s',profileId:'general',profileRevision:1,habits:''};
  const prepared=await prepareProfileTurn(snapshot);expect(prepared).toEqual({snapshot});
  expect(await finishProfileTurn(prepared)).toEqual({applied:false});expect(fetcher).not.toHaveBeenCalled();
});

it('reports structured failures without claiming a save',()=>{
  expect(instructionOutcomeNotice({status:'unchanged',revision:1})).toBeUndefined();
  for(const status of ['conflict','detector_failure','persistence_failure','unknown_commit','invalid_token'] as const)expect(instructionOutcomeNotice({status})).toBeTruthy();
  expect(instructionOutcomeNotice({status:'unknown_commit'})).toContain('could not be confirmed');
});

it.each(['unchanged','detector_failure','conflict','clarification_required','persistence_failure','unknown_commit','invalid_token'] as const)('maps a completion status of %s without retries',async status=>{
  const body=status==='unchanged'?{status,revision:1}:{status};
  const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}}));vi.stubGlobal('fetch',fetcher);
  const result=await finishProfileTurn({snapshot:{sessionId:'s',profileId:'p',profileRevision:1,habits:''},ids:{runId:'r',messageId:'m'},token:'x'.repeat(43)});
  expect(result.applied).toBe(false);expect(!!result.notice).toBe(status!=='unchanged');expect(fetcher).toHaveBeenCalledOnce();
});

it('blocks a mismatched profile association rather than using the prior snapshot',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({token:'x'.repeat(43),snapshot:{sessionId:'s',profileId:'other',profileRevision:1,habits:''}}),{status:200})));
  await expect(prepareProfileTurn({sessionId:'s',profileId:'p',profileRevision:1,habits:''})).rejects.toMatchObject({code:'invalid_association'});
});

it('does not retry an uncertain completion and retains the send lock until it settles',async()=>{
  const snapshot={sessionId:'s',profileId:'p',profileRevision:1,habits:''};let release!:()=>void,started!:()=>void;
  const entered=new Promise<void>(resolve=>{started=resolve;}),wait=new Promise<void>(resolve=>{release=resolve;});
  const fetcher=vi.fn(async()=>{started();await wait;throw Error('response lost');});vi.stubGlobal('fetch',fetcher);
  const lock={current:false};let notice='';
  const pending=submitSession({lock,draft:'Question',ready:true,model:'model',hasCredential:true,onBlocked:()=>{},onAccepted:()=>{},onSettled:()=>{},run:async()=>{const result=await finishProfileTurn({snapshot,ids:{runId:'r',messageId:'m'},token:'x'.repeat(43)});notice=result.notice ?? '';}});
  await entered;expect(lock.current).toBe(true);release();expect(await pending).toBe(true);expect(lock.current).toBe(false);
  expect(fetcher).toHaveBeenCalledOnce();expect(notice).toContain('could not be confirmed');
});

it('continues with the preflight snapshot when preparation is unavailable',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockRejectedValue(new Error('offline')));
  const snapshot={sessionId:'s',profileId:'p',profileRevision:3,habits:'* Original.'};
  const prepared=await prepareProfileTurn(snapshot);
  expect(prepared.snapshot).toBe(snapshot);expect(prepared.ids).toBeDefined();expect(prepared.token).toBeUndefined();
  expect(await finishProfileTurn(prepared)).toMatchObject({applied:false,notice:expect.stringContaining('could not be prepared')});
});
