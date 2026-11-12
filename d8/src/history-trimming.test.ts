import {expect,it,vi} from 'vitest';
import {ManagerAgent,createManagerConversation,type ManagerLlmAdapter} from './manager-agent';
import {ManagerProviderError} from './manager-llm-adapter';
import {ToolRegistry} from './tool-runtime';

it('selects newest whole turns, keeps 950 instead of adding an older turn to reach 1100, and retains failed turns',async()=>{
 const state=createManagerConversation(),tools=new ToolRegistry();
 const seed=new ManagerAgent({complete:async()=>({text:'older answer'})},tools);
 await seed.run({state,userText:'older turn',onEvent:async()=>{}});
 await new ManagerAgent({complete:async()=>{throw Error('fake failure')}},tools).run({state,userText:'recent failed turn',onEvent:async()=>{}});
 state.contextEvents=[{id:'old-summary',runId:state.runs[0].id,phase:'completed',createdAt:1,summary:'DO NOT SEND',coveredRunIds:[state.runs[0].id]}];
 const assess=vi.fn(async(messages:readonly {content:string}[])=>({tokens:messages.some(m=>m.content==='older turn')?1100:messages.some(m=>m.content==='recent failed turn')?950:100,limit:10000,target:1000}));
 const summarize=vi.fn(async()=>{throw Error('must not summarize')});const complete=vi.fn(async(_input:Parameters<ManagerLlmAdapter['complete']>[0])=>({text:'Done'}));
 const result=await new ManagerAgent({context:{assess,summarize},complete},tools).run({state,userText:'current input'});
 expect(result.error).toBeUndefined();const sent=complete.mock.calls[0][0].messages;
 expect(sent.map(m=>m.content)).toEqual(['recent failed turn','current input']);expect((await assess(sent)).tokens).toBe(950);expect(summarize).not.toHaveBeenCalled();
 expect(state.messages.some(m=>m.text==='older turn')).toBe(true);
});

it('retries overflow once with a shorter payload and no summary',async()=>{
 const state=createManagerConversation(),tools=new ToolRegistry();const seed=new ManagerAgent({complete:async()=>({text:'Prior reply'})},tools);
 await seed.run({state,userText:'First turn',onEvent:async()=>{}});await seed.run({state,userText:'Second turn',onEvent:async()=>{}});
 const payloads:string[][]=[];const summarize=vi.fn(async()=>{throw Error('must not summarize')});
 const adapter:ManagerLlmAdapter={context:{assess:async messages=>({tokens:100+messages.length*10,limit:10000,target:1000}),summarize},complete:async({messages})=>{payloads.push(messages.map(m=>m.content));if(payloads.length===1)throw new ManagerProviderError({kind:'context-overflow',status:400});return{text:'Done'}}};
 const result=await new ManagerAgent(adapter,tools).run({state,userText:'Current'});
 expect(result.error).toBeUndefined();expect(payloads).toHaveLength(2);expect(payloads[0]).toContain('First turn');expect(payloads[1]).not.toContain('First turn');expect(payloads[1]).toContain('Second turn');expect(payloads[1].at(-1)).toBe('Current');expect(summarize).not.toHaveBeenCalled();
});

it('sends a short dialogue in full and blocks required input above the model budget',async()=>{
 const state=createManagerConversation(),tools=new ToolRegistry();
 await new ManagerAgent({complete:async()=>({text:'Prior reply'})},tools).run({state,userText:'Earlier',onEvent:async()=>{}});
 const complete=vi.fn(async(_request:Parameters<ManagerLlmAdapter['complete']>[0])=>({text:'Done'}));
 const summarize=vi.fn(async()=>{throw Error('must not summarize')});
 const adapter:ManagerLlmAdapter={context:{assess:async messages=>({tokens:messages.reduce((sum,m)=>sum+m.content.length,0),limit:100,target:1000}),summarize},complete};
 const okay=await new ManagerAgent(adapter,tools).run({state,userText:'Short'});
 expect(okay.error).toBeUndefined();expect(complete.mock.calls[0][0].messages.map(m=>m.content)).toEqual(['Earlier','Prior reply','Short']);
 const blocked=await new ManagerAgent(adapter,tools).run({state,userText:'Required '.repeat(30)});
 expect(blocked.error).toContain('exceeds the model input budget');expect(complete).toHaveBeenCalledTimes(1);expect(summarize).not.toHaveBeenCalled();
});

it('keeps omitted turns readable after SQLite restart and never dispatches a summary',async()=>{
 const {mkdtemp,rm}=await import('node:fs/promises');const {join}=await import('node:path');const {tmpdir}=await import('node:os');
 const {createSessionServer}=await import('../server/sessions.mjs');const {emptySession}=await import('./session-api');const {restoreHistory}=await import('./conversation-history');const {createProviderRegistry}=await import('./provider-registry');const {createManagerLlmAdapter}=await import('./manager-llm-adapter');
 const folder=await mkdtemp(join(tmpdir(),'d8-trim-history-'));let server:ReturnType<typeof createSessionServer>;let base='';
 const start=async()=>{server=createSessionServer(join(folder,'sessions.sqlite'),{credentialStore:{status:async()=>false,read:async()=>{throw Error('Empty fake store')},save:async()=>{},forget:async()=>{}}});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const a=server.address();if(!a||typeof a==='string')throw Error('No port');base=`http://127.0.0.1:${a.port}`};
 const stop=()=>new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
 const api=async(path='',method='GET',body?:unknown)=>{const r=await fetch(base+'/api/sessions'+path,{method,headers:{Origin:base,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});expect(r.ok).toBe(true);return r.json()};
 try{await start();const session=await api('','POST');const state=emptySession(session),tools=new ToolRegistry();const save=async(e:import('./conversation-history').HistoryEvent)=>{await api('/'+session.id+'/events','POST',e)};
  const seed=new ManagerAgent({complete:async()=>({text:'Earlier answer. '.repeat(300)})},tools);const original='Earlier discussion. '.repeat(300);await seed.run({state,userText:original,onEvent:save});
  const bodies:any[]=[];const fetcher=vi.fn(async(_url:unknown,init?:RequestInit)=>{bodies.push(JSON.parse(String(init?.body)));return new Response(JSON.stringify({output:[{type:'message',content:[{type:'output_text',text:'New answer.'}]}],usage:{input_tokens:20,output_tokens:5}}))}) as typeof fetch;
  const manager=new ManagerAgent(createManagerLlmAdapter({providerId:'openai',model:'gpt-4o-mini',registry:createProviderRegistry(),requestTokenLimit:200,apiKey:'placeholder',fetcher}),tools);
  const result=await manager.run({state,userText:'Continue.',onEvent:save});expect(result.error).toBeUndefined();expect(bodies).toHaveLength(1);expect(JSON.stringify(bodies[0])).not.toContain('Earlier discussion.');expect(bodies[0].input.some((m:any)=>m.role==='system')).toBe(false);expect(bodies[0]).not.toHaveProperty('max_output_tokens');
  await stop();await start();const restored=restoreHistory(emptySession(session),await api('/'+session.id+'/events'));expect(restored.messages.some(m=>m.text===original)).toBe(true);expect(restored.messages.at(-1)?.text).toBe('New answer.');expect(restored.requestMeters?.at(-1)?.sentInputTokens).toBeDefined();
 }finally{if(server!?.listening)await stop();await rm(folder,{recursive:true,force:true})}
});
