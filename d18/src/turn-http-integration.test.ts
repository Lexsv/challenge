import { afterEach, expect, it, vi } from 'vitest';
import { createSessionServer } from '../server/sessions.mjs';
import { createInstructionDetectorStartup } from '../server/instruction-detector-startup';
import { restoreHistory } from './conversation-history';
import { aggregateSessionStats } from './session-stats';

const servers:ReturnType<typeof createSessionServer>[]=[];
afterEach(async()=>{await Promise.all(servers.splice(0).map(server=>new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()))));});
const responseBody=JSON.stringify({operations:[{action:'ADD',sourceQuote:'Always use examples.',newInstruction:'Use examples.'}]});
const successTransport=()=>vi.fn(async()=>({status:200,body:{output:[{type:'message',content:[{type:'output_text',text:responseBody}]}],usage:{input_tokens:10,output_tokens:5,total_tokens:15}}}));
async function start(options:NonNullable<Parameters<typeof createSessionServer>[1]>={}){
  const server=createSessionServer(':memory:',options);servers.push(server);
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();if(!address || typeof address==='string')throw Error('address');
  const base=`http://127.0.0.1:${address.port}`;
  const request=(path:string,body?:unknown)=>fetch(base+path,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  return {request};
}
async function fixture(options:NonNullable<Parameters<typeof createSessionServer>[1]>={},general=false){
  const app=await start(options);
  const profile=general?{id:'general'}:await (await app.request('/api/users',{name:'Synthetic',habits:''})).json();
  const session=await (await app.request('/api/week3/sessions',{profileId:profile.id})).json();
  const root=`/api/week3/sessions/${session.id}`;
  const refs={runId:'test-run',messageId:'test-message'};
  const prepare=()=>app.request(`${root}/turn-context`,refs);
  const archive=async(status='completed')=>{
    const events=[
      {id:'event-message',sessionId:session.id,type:'message',payload:{id:refs.messageId,conversationId:session.id,runId:refs.runId,createdAt:1,role:'user',type:'text',text:'Always use examples.'}},
      {id:'event-answer',sessionId:session.id,type:'message',payload:{id:'test-answer',conversationId:session.id,runId:refs.runId,createdAt:2,role:'assistant',type:'text',text:'Completed answer.'}},
      {id:'event-run',sessionId:session.id,type:'run',payload:{id:refs.runId,conversationId:session.id,agentId:'manager',status,startedAt:1,endedAt:2,messageIds:[refs.messageId,'test-answer'],toolExecutionIds:[]}},
    ];
    for(const event of events)expect((await app.request(`${root}/events`,event)).status).toBe(201);
  };
  return {...app,profile,session,root,refs,prepare,archive};
}

it('prepares a bound context and completes exactly once through the configured coordinator',async()=>{
  const transport=successTransport(),meters:unknown[]=[];
  const f=await fixture({instructionDetector:{providerId:'openai',model:'gpt-5.6-terra'},instructionDetectorTransport:transport,instructionDetectorMeter:async meter=>{meters.push(meter);}});
  const prepared=await f.prepare();expect(prepared.status).toBe(201);const context=await prepared.json();
  expect(context.snapshot).toMatchObject({sessionId:f.session.id,profileId:f.profile.id,profileRevision:1,habits:''});
  expect((await f.prepare()).status).toBe(409);
  await f.archive();
  const body={...f.refs,turnToken:context.token};
  const results=await Promise.all([f.request(`${f.root}/turn-completion`,body),f.request(`${f.root}/turn-completion`,body)]);
  const values=await Promise.all(results.map(response=>response.json()));
  const proposal=values.find(value=>value.status==='confirmation_required');
  expect(proposal).toMatchObject({status:'confirmation_required',proposalId:expect.any(String),expiresInMs:expect.any(Number),changes:[{action:'ADD',after:'Use examples.'}]});
  expect(Object.keys(proposal).sort()).toEqual(['changes','expiresInMs','proposalId','status']);
  expect(values).toContainEqual({status:'invalid_token'});
  expect(transport).toHaveBeenCalledOnce();expect(meters.length).toBeGreaterThan(0);
  expect(meters.every(value=>(value as {meter:{requestKind:string}}).meter.requestKind==='extraction')).toBe(true);
  expect(await (await f.request(`/api/users/${f.profile.id}`)).json()).toMatchObject({habits:'',revision:1});
  const decisions=await Promise.all([f.request(`${f.root}/instruction-decision`,{proposalId:proposal.proposalId,decision:'accept'}),f.request(`${f.root}/instruction-decision`,{proposalId:proposal.proposalId,decision:'accept'})]);
  const outcomes=await Promise.all(decisions.map(response=>response.json()));
  expect(outcomes).toContainEqual({status:'applied',revision:2});expect(outcomes).toContainEqual({status:'invalid_proposal'});
  expect(await (await f.request(`/api/users/${f.profile.id}`)).json()).toMatchObject({habits:'* Use examples.',revision:2});
  expect((await f.prepare()).status).toBe(409);
  expect((await f.request(`${f.root}/profile`)).status).toBe(200);
});

it('rejects invalid shapes and mismatched references without consuming a valid token',async()=>{
  const f=await fixture();
  for(const body of [{...f.refs,profileId:'other'}, {...f.refs,habits:'injected'}, {runId:'',messageId:'x'}, {runId:'same',messageId:'same'}])expect((await f.request(`${f.root}/turn-context`,body)).status).toBe(400);
  const context=await (await f.prepare()).json();await f.archive();
  for(const body of [{...f.refs,turnToken:context.token,operations:[]},{...f.refs,turnToken:context.token,apiKey:'placeholder'}])expect((await f.request(`${f.root}/turn-completion`,body)).status).toBe(400);
  expect(await (await f.request(`${f.root}/turn-completion`,{...f.refs,runId:'other',turnToken:context.token})).json()).toEqual({status:'mismatch'});
  const other=await (await f.request('/api/week3/sessions',{})).json();
  expect(await (await f.request(`/api/week3/sessions/${other.id}/turn-completion`,{...f.refs,turnToken:context.token})).json()).toEqual({status:'mismatch'});
  expect(await (await f.request(`${f.root}/turn-completion`,{...f.refs,turnToken:context.token})).json()).toEqual({status:'detector_failure'});
  expect((await f.request('/api/week3/sessions/missing/turn-context',f.refs)).status).toBe(404);
});

it('rejects missing and incomplete archived turns',async()=>{
  const f=await fixture();const context=await (await f.prepare()).json();
  expect(await (await f.request(`${f.root}/turn-completion`,{...f.refs,turnToken:context.token})).json()).toEqual({status:'missing_message'});
  const g=await fixture();const second=await (await g.prepare()).json();await g.archive('failed');
  expect(await (await g.request(`${g.root}/turn-completion`,{...g.refs,turnToken:second.token})).json()).toEqual({status:'incomplete_run'});
});

it('rejects expired tokens without calling a provider',async()=>{
  let now=0;const transport=successTransport();
  const f=await fixture({turnContextOptions:{now:()=>now,ttlMs:10},instructionDetector:{providerId:'openai',model:'gpt-5.6-terra'},instructionDetectorTransport:transport,instructionDetectorMeter:async()=>{}});
  const context=await (await f.prepare()).json();await f.archive();now=10;
  expect(await (await f.request(`${f.root}/turn-completion`,{...f.refs,turnToken:context.token})).json()).toEqual({status:'invalid_token'});expect(transport).not.toHaveBeenCalled();
});

it('skips General and preserves stale or unconfigured profiles',async()=>{
  const general=await fixture({},true);const context=await (await general.prepare()).json();await general.archive();
  expect(await (await general.request(`${general.root}/turn-completion`,{...general.refs,turnToken:context.token})).json()).toEqual({status:'general_skipped'});
  expect(await (await general.request('/api/users/general')).json()).toMatchObject({habits:'',revision:1});
  const stale=await fixture();const old=await (await stale.prepare()).json();await stale.archive();
  const changed=await fetch(`${(await stale.request('/')).url}api/users/${stale.profile.id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Synthetic',habits:'newer',expectedRevision:1})});expect(changed.status).toBe(200);
  expect(await (await stale.request(`${stale.root}/turn-completion`,{...stale.refs,turnToken:old.token})).json()).toEqual({status:'conflict'});
  const unconfigured=await fixture();const token=await (await unconfigured.prepare()).json();await unconfigured.archive();
  expect(await (await unconfigured.request(`${unconfigured.root}/turn-completion`,{...unconfigured.refs,turnToken:token.token})).json()).toEqual({status:'detector_failure'});
  expect(await (await unconfigured.request(`/api/users/${unconfigured.profile.id}`)).json()).toMatchObject({habits:'',revision:1});
});

it('reports provider failure without writing habits',async()=>{
  const f=await fixture({instructionDetector:{providerId:'openai',model:'gpt-5.6-terra'},instructionDetectorTransport:async()=>({status:503,body:{error:'provider unavailable'}}),instructionDetectorMeter:async()=>{}});
  const context=await (await f.prepare()).json();await f.archive();
  expect(await (await f.request(`${f.root}/turn-completion`,{...f.refs,turnToken:context.token})).json()).toEqual({status:'detector_failure'});
  expect(await (await f.request(`/api/users/${f.profile.id}`)).json()).toMatchObject({habits:'',revision:1});
});

it('fails closed when the server detector configuration is unsupported',async()=>{
  const transport=successTransport();
  const f=await fixture({instructionDetector:{providerId:'openai',model:'unsupported'},instructionDetectorTransport:transport,instructionDetectorMeter:async()=>{}});
  const context=await (await f.prepare()).json();await f.archive();
  expect(await (await f.request(`${f.root}/turn-completion`,{...f.refs,turnToken:context.token})).json()).toEqual({status:'detector_failure'});
  expect(transport).not.toHaveBeenCalled();expect(await (await f.request(`/api/users/${f.profile.id}`)).json()).toMatchObject({habits:'',revision:1});
});

it('requires an explicit valid OpenAI startup configuration and disables without restarting',()=>{
  const disabled=createInstructionDetectorStartup();
  expect(disabled.config).toBeUndefined();expect(disabled.isEnabled()).toBe(false);
  for(const pair of [['openai',undefined],['other','x'],['opencode-go','kimi-k3'],['openai','unsupported']] as const)
    expect(()=>createInstructionDetectorStartup(...pair)).toThrow();
  const enabled=createInstructionDetectorStartup('openai','gpt-5.6-terra');
  expect(enabled.isEnabled()).toBe(true);enabled.disable();expect(enabled.isEnabled()).toBe(false);
});

it('persists extraction meters with the correct turn and keeps answer accounting separate',async()=>{
  const control=createInstructionDetectorStartup('openai','gpt-5.6-terra');
  const f=await fixture({instructionDetector:control.config,instructionDetectorEnabled:control.isEnabled,instructionDetectorTransport:successTransport()});
  const context=await (await f.prepare()).json();await f.archive();
  expect(await (await f.request(`${f.root}/turn-completion`,{...f.refs,turnToken:context.token})).json()).toMatchObject({status:'confirmation_required'});
  const events=await (await f.request(`${f.root}/events`)).json();
  const meters=events.filter((event:{type:string})=>event.type==='metering');
  expect(meters).toHaveLength(2);
  expect(meters.every((event:{payload:{sessionId:string;runId:string;requestKind:string}})=>event.payload.sessionId===f.session.id && event.payload.runId===f.refs.runId && event.payload.requestKind==='extraction')).toBe(true);
  expect(meters[1].payload).toMatchObject({status:'completed',actualInputTokens:10,actualOutputTokens:5});
  expect(meters[0].payload.id).toBe(meters[1].payload.id);
  const state=restoreHistory({conversation:{id:f.session.id},messages:[],runs:[],toolExecutions:[]} as never,events);
  const stats=aggregateSessionStats(state);expect(stats.requestCount).toBe(1);expect(stats.lastAnswer).toBeUndefined();
});

it('does not start new detector operations after disable, while an admitted operation finishes',async()=>{
  const control=createInstructionDetectorStartup('openai','gpt-5.6-terra');
  let release!:()=>void,started!:()=>void;
  const begun=new Promise<void>(resolve=>{started=resolve;});
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const transport=vi.fn(async()=>{started();await gate;return {status:200,body:{output:[{type:'message',content:[{type:'output_text',text:responseBody}]}]}};});
  const options={instructionDetector:control.config,instructionDetectorEnabled:control.isEnabled,instructionDetectorTransport:transport};
  const first=await fixture(options);const context=await (await first.prepare()).json();await first.archive();
  const pending=first.request(`${first.root}/turn-completion`,{...first.refs,turnToken:context.token});
  await begun;control.disable();release();
  expect(await (await pending).json()).toMatchObject({status:'confirmation_required'});
  const second=await fixture(options);const token=await (await second.prepare()).json();await second.archive();
  expect(await (await second.request(`${second.root}/turn-completion`,{...second.refs,turnToken:token.token})).json()).toEqual({status:'detector_failure'});
  expect(transport).toHaveBeenCalledOnce();
});

it('rejects or expires proposals and disallows client-supplied changes',async()=>{
  let now=0;
  for(const mode of ['reject','expire'] as const){
    now=0;
    const f=await fixture({instructionDetector:{providerId:'openai',model:'gpt-5.6-terra'},instructionDetectorTransport:successTransport(),instructionDetectorMeter:async()=>{},instructionProposalOptions:{now:()=>now,ttlMs:10}});
    const context=await (await f.prepare()).json();await f.archive();
    const proposal=await (await f.request(`${f.root}/turn-completion`,{...f.refs,turnToken:context.token})).json();
    expect(proposal.status).toBe('confirmation_required');
    for(const body of [{proposalId:proposal.proposalId,decision:'yes'},{proposalId:proposal.proposalId,decision:'accept',habits:'injected'},{proposalId:'bad',decision:'accept'}])
      expect((await f.request(`${f.root}/instruction-decision`,body)).status).toBe(400);
    const other=await (await f.request('/api/week3/sessions',{})).json();
    expect(await (await f.request(`/api/week3/sessions/${other.id}/instruction-decision`,{proposalId:proposal.proposalId,decision:'accept'})).json()).toEqual({status:'invalid_proposal'});
    if(mode==='expire')now=10;
    expect(await (await f.request(`${f.root}/instruction-decision`,{proposalId:proposal.proposalId,decision:mode==='reject'?'reject':'accept'})).json()).toEqual({status:mode==='reject'?'rejected':'expired_proposal'});
    expect(await (await f.request(`/api/users/${f.profile.id}`)).json()).toMatchObject({habits:'',revision:1});
  }
});

it('rejects stale proposals without overwriting a profile edit',async()=>{
  const f=await fixture({instructionDetector:{providerId:'openai',model:'gpt-5.6-terra'},instructionDetectorTransport:successTransport(),instructionDetectorMeter:async()=>{}});
  const context=await (await f.prepare()).json();await f.archive();
  const proposal=await (await f.request(`${f.root}/turn-completion`,{...f.refs,turnToken:context.token})).json();
  const changed=await fetch(`${(await f.request('/')).url}api/users/${f.profile.id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Synthetic',habits:'newer',expectedRevision:1})});
  expect(changed.status).toBe(200);
  expect(await (await f.request(`${f.root}/instruction-decision`,{proposalId:proposal.proposalId,decision:'accept'})).json()).toEqual({status:'conflict'});
  expect(await (await f.request(`/api/users/${f.profile.id}`)).json()).toMatchObject({habits:'newer',revision:2});
});

it('fails safely when saved credentials are missing and records the failed extraction',async()=>{
  const fetcher=vi.fn();
  const credentialStore={status:async()=>false,save:async()=>{},forget:async()=>{},read:async()=>{throw Error('unexpected read');}};
  const f=await fixture({instructionDetector:{providerId:'openai',model:'gpt-5.6-terra'},credentialStore,fetcher});
  const context=await (await f.prepare()).json();await f.archive();
  expect(await (await f.request(`${f.root}/turn-completion`,{...f.refs,turnToken:context.token})).json()).toEqual({status:'detector_failure'});
  expect(fetcher).not.toHaveBeenCalled();
  expect(await (await f.request(`/api/users/${f.profile.id}`)).json()).toMatchObject({habits:'',revision:1});
  const events=await (await f.request(`${f.root}/events`)).json();
  expect(events.filter((event:{type:string})=>event.type==='metering').at(-1).payload).toMatchObject({status:'failed',requestKind:'extraction',sessionId:f.session.id,runId:f.refs.runId});
});

it('fails detection without a provider call if extraction accounting cannot be recorded',async()=>{
  const transport=successTransport();
  const f=await fixture({instructionDetector:{providerId:'openai',model:'gpt-5.6-terra'},instructionDetectorTransport:transport,instructionDetectorMeter:async()=>{throw Error('fixture accounting failure');}});
  const context=await (await f.prepare()).json();await f.archive();
  expect(await (await f.request(`${f.root}/turn-completion`,{...f.refs,turnToken:context.token})).json()).toEqual({status:'detector_failure'});
  expect(transport).not.toHaveBeenCalled();
  expect(await (await f.request(`/api/users/${f.profile.id}`)).json()).toMatchObject({habits:'',revision:1});
});
