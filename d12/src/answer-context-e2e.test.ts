import { expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { createSessionServer } from '../server/sessions.mjs';
import { ManagerAgent } from './manager-agent';
import { createManagerLlmAdapter, managerContextBudget } from './manager-llm-adapter';
import { createBuiltInToolRegistry } from './tool-runtime';
import { createProviderRegistry } from './provider-registry';
import { emptySession } from './session-api';
import { restoreHistory, type HistoryEvent } from './conversation-history';
import { aggregateSessionStats, sessionContextReduction } from './session-stats';
import { SessionStatsContent } from './session-stats-panel';
import { estimateContextInput } from './token-meter';
import { sessionLimitOnClose } from './session-limit';
import { buildWeek2Timeline } from './week2-agent-tool-lab';

it('saves only valid on-close limits', () => {
 for(const draft of ['', ' ', '-1', '1.1', 'NaN', 'Infinity']) expect(sessionLimitOnClose(draft,1000)).toBe(1000);
 expect(sessionLimitOnClose('0',1000)).toBe(0);
 expect(sessionLimitOnClose('1000',0)).toBe(1000);
});

it('runs real Manager compaction under 1,000 tokens, persists answer metrics, resets reduction and blocks oversized input', async () => {
 const folder=await mkdtemp(join(tmpdir(),'d8-answer-context-'));
 let server: ReturnType<typeof createSessionServer>;
 let base='';
 const start=async()=>{
  server=createSessionServer(join(folder,'sessions.sqlite'),{credentialStore:{status:async()=>false,read:async()=>{throw Error('Fake store empty')},save:async()=>{},forget:async()=>{}}});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address(); if(!address || typeof address==='string')throw Error('No port');
  base=`http://127.0.0.1:${address.port}`;
 };
 const stop=()=>new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
 const api=async(path='',method='GET',body?:unknown)=>{
  const response=await fetch(base+'/api/sessions'+path,{method,headers:{Origin:base,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  expect(response.ok).toBe(true);return response.json();
 };
 try {
  await start();
  const session=await api('','POST');const other=await api('','POST');
  expect(session.requestTokenLimit).toBe(0);
  await api('/'+session.id,'PATCH',{requestTokenLimit:1000});
  const state=emptySession({...session,requestTokenLimit:1000});
  const onEvent=async(event:HistoryEvent)=>{await api('/'+session.id+'/events','POST',event)};
  const tools=createBuiltInToolRegistry();
  const seed=new ManagerAgent({complete:async()=>({text:'Saved explanation.'})},tools);
  for(let i=0;i<5;i++)await seed.run({state,userText:i<3?'Earlier discussion of the conversion and its meaning. '.repeat(200):'Keep this recent turn.',onEvent});
  const originalMessages=state.messages.length;
  const registry=createProviderRegistry();
  const requests: Record<string,any>[]=[];
  const fetcher=vi.fn(async(_url:unknown,init?:RequestInit)=>{
   const body=JSON.parse(String(init?.body));requests.push(body);
   const summary=body.input.some((m:any)=>m.role==='system');
   return new Response(JSON.stringify({model:'gpt-4o-mini',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:summary?'Previous conversion discussion completed.':'Continued answer.'}]}],...(!summary?{usage:{input_tokens:777,output_tokens:12,total_tokens:789}}:{usage:{input_tokens:100,output_tokens:10,total_tokens:110}})}),{status:200});
  }) as typeof fetch;
  const config={providerId:'openai' as const,model:'gpt-4o-mini',registry,requestTokenLimit:1000};
  const manager=new ManagerAgent(createManagerLlmAdapter({...config,apiKey:'placeholder-only',fetcher}),tools);
  const result=await manager.run({state,userText:'Continue from the recent turn.',onEvent});
  expect(result.error).toBeUndefined();
  const answer=requests.at(-1)!;
  expect(requests).toHaveLength(1);
  expect(JSON.stringify(answer)).not.toContain('Saved conversation summary');
  expect(JSON.stringify(answer)).toContain('Keep this recent turn.');
  const actualEstimate=(await estimateContextInput(config.model,answer)).estimatedInputTokens!;
  expect(actualEstimate).toBeLessThanOrEqual(1000);
  const stats=aggregateSessionStats(state);const last=stats.lastAnswer!;
  expect(state.requestMeters!.filter(m=>m.requestKind==='summary')).toHaveLength(0);
  expect(state.requestMeters!.filter(m=>m.requestKind==='answer')).toHaveLength(1);
  expect(last.requestKind).toBe('answer');expect(last.afterInputTokens).toBe(actualEstimate);
  expect(last.sentInputTokens).toBe(actualEstimate);expect(last.beforeInputTokens).toBeGreaterThan(actualEstimate);
  const percent=Math.round((last.beforeInputTokens!-actualEstimate)/last.beforeInputTokens!*100);
  expect(sessionContextReduction(undefined,stats)).toBe(0);
  expect(state.messages.length).toBe(originalMessages+2);
  const render=(s:typeof state)=>renderToStaticMarkup(createElement(SessionStatsContent,{stats:aggregateSessionStats(s),context:managerContextBudget(config)}));
  expect(render(state)).toContain(`≈${actualEstimate}`);
  expect(render(state)).not.toContain('Reduction');
  await stop();await start();
  const list=await api();expect(list.find((s:any)=>s.id===session.id).requestTokenLimit).toBe(1000);expect(list.find((s:any)=>s.id===other.id).requestTokenLimit).toBe(0);
  const restored=restoreHistory(emptySession(session),await api('/'+session.id+'/events'));
  expect(render(restored)).not.toContain('Reduction');
  expect(render(restored)).toContain(`≈${actualEstimate}`);
  console.info(`Answer context: before=${last.beforeInputTokens}, after=${actualEstimate}, reported=777, Reduction=${percent}%, summaries=${requests.length-1}`);
  const plain=emptySession(other);
  await manager.run({state:plain,userText:'Short question',onEvent:async e=>{await api('/'+other.id+'/events','POST',e)}});
  expect(sessionContextReduction(undefined,aggregateSessionStats(plain))).toBe(0);
  const plainRestored=restoreHistory(emptySession(other),await api('/'+other.id+'/events'));
  expect(sessionContextReduction(undefined,aggregateSessionStats(plainRestored))).toBe(0);
  expect(render(plainRestored)).toContain('Last request');
  const beforeBlocked=requests.length;
  const blocked=await manager.run({state:emptySession(other),userText:'Required input '.repeat(3000)});
  expect(blocked.error).toBeUndefined();expect(requests).toHaveLength(beforeBlocked+1);
  // Missing provider usage uses the actual sent-payload estimate, independently of summary usage.
  const noUsage=createManagerLlmAdapter({...config,apiKey:'placeholder-only',fetcher:async()=>new Response(JSON.stringify({output:[{type:'message',content:[{type:'output_text',text:'No usage.'}]}]}))});
  const fallback=emptySession(other);await new ManagerAgent(noUsage,tools).run({state:fallback,userText:'Short question'});
  expect(render(fallback)).toMatch(/Last request<\/dt><dd[^>]*>≈/);
 } finally {if(server!?.listening)await stop();await rm(folder,{recursive:true,force:true});}
});

it('uses Console catalog window for Auto, including after model switches and unknown-window custom enforcement', async()=>{
 const registry=createProviderRegistry();
 const catalogFetch=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify({data:[{id:'deepseek-v4.1-flash',limit:{context:128000,output:8192}},{id:'small-model',limit:{context:32000,output:4096}}]})));
 try {await registry.get('opencode-console')!.discover!();}finally{catalogFetch.mockRestore();}
 const first=managerContextBudget({providerId:'opencode-console',model:'deepseek-v4.1-flash',registry});
 const second=managerContextBudget({providerId:'opencode-console',model:'small-model',registry});
 expect(first.contextWindow).toBe(128000);expect(first.requestTokenLimit).toBe(0);expect(second.contextWindow).toBe(32000);
 const html=renderToStaticMarkup(createElement(SessionStatsContent,{context:first}));expect(html).toContain('128,000 (Auto)');expect(html).not.toContain('Reduction');
 const provider=vi.fn(async()=>new Response(JSON.stringify({choices:[{message:{content:'Accepted above target.'}}]})));
 const adapter=createManagerLlmAdapter({providerId:'opencode-console',model:'unknown',registry,requestTokenLimit:1000,apiKey:'placeholder-only',fetcher:provider});
 const result=await new ManagerAgent(adapter,createBuiltInToolRegistry()).run({state:emptySession({id:'unknown',title:'Unknown',createdAt:1}),userText:'Required input '.repeat(3000)});
 expect(result.error).toBeUndefined();expect(provider).toHaveBeenCalledOnce();
});

for (const mode of ['fits', 'large-recent-turns', 'hard-budget'] as const) it(`Console summary succeeds: ${mode}`, async () => {
 const blocked=mode!=='fits'; const hardBlocked=mode==='hard-budget';
 const folder = await mkdtemp(join(tmpdir(), 'd8-console-budget-'));
 const server = createSessionServer(join(folder, 'sessions.sqlite'), {credentialStore:{status:async()=>false,read:async()=>{throw Error('Fake store empty')},save:async()=>{},forget:async()=>{}}});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const address=server.address(); if(!address || typeof address==='string')throw Error('No port');
 const base=`http://127.0.0.1:${address.port}`;
 const api=async(path='',method='GET',body?:unknown)=>{
  const response=await fetch(base+'/api/sessions'+path,{method,headers:{Origin:base,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  expect(response.ok).toBe(true); return response.json();
 };
 try {
  const session=await api('','POST'); const state=emptySession(session);
  const onEvent=async(event:HistoryEvent)=>{await api('/'+session.id+'/events','POST',event)};
  const tools=createBuiltInToolRegistry();
  const seed=new ManagerAgent({complete:async()=>({text:'Saved response.'})},tools);
  for(let i=0;i<5;i++)await seed.run({state,userText:i<3?'Older explanatory dialogue. '.repeat(blocked?2000:4400):blocked?'Retained recent discussion. '.repeat(3000):'Recent turn kept intact.',onEvent});
  const registry=createProviderRegistry();
  const discover=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify({data:[{id:'deepseek-v4.1-flash',limit:{context:1000000,output:32000}}]})));
  try {await registry.get('opencode-console')!.discover!();}finally{discover.mockRestore();}
  const requests: {summary:boolean;body:any}[]=[];
  const fetcher=vi.fn(async(_url:unknown,init?:RequestInit)=>{
   const body=JSON.parse(String(init?.body));const summary=body.messages.some((m:any)=>m.role==='system');requests.push({summary,body});
   return new Response(JSON.stringify({choices:[{message:{role:'assistant',content:summary?'Earlier discussion summarized.':'Answer after compaction.'}}],usage:{prompt_tokens:summary?100:321,completion_tokens:20,total_tokens:summary?120:341}}),{status:200});
  }) as typeof fetch;
  // First record an answer without compaction. A subsequent blocked run must not replace it.
  const plainConfig={providerId:'opencode-console' as const,model:'deepseek-v4.1-flash',registry,requestTokenLimit:0,apiKey:'placeholder-only',fetcher};
  const prior=await new ManagerAgent(createManagerLlmAdapter(plainConfig),tools).run({state,userText:'Record a prior answer.',onEvent});
  expect(prior.error).toBeUndefined();
  const priorAnswer=aggregateSessionStats(state).lastAnswer!;
  expect(sessionContextReduction(undefined,aggregateSessionStats(state))).toBe(0);
  requests.length=0;
  if(hardBlocked)registry.get('opencode-console')!.limits=()=>({contextWindow:20000,maxOutputTokens:32000});
  const config={...plainConfig,requestTokenLimit:hardBlocked?20000:10000};
  const result=await new ManagerAgent(createManagerLlmAdapter(config),tools).run({state,userText:hardBlocked?'Required content '.repeat(10000):'Continue the discussion.',onEvent});
  const summaries=requests.filter(r=>r.summary); const answers=requests.filter(r=>!r.summary);
  expect(summaries).toHaveLength(0);
  for(const r of requests){expect(r.body).not.toHaveProperty('max_completion_tokens');expect(r.body).not.toHaveProperty('max_output_tokens');}
  const restored=restoreHistory(emptySession(session),await api('/'+session.id+'/events'));
  expect(restored.messages).toEqual(state.messages);
  const stats=aggregateSessionStats(restored);
  if(hardBlocked){
   expect(result.error).toContain('model input budget');expect(answers).toHaveLength(0);
   expect(stats.lastAnswer).toEqual(priorAnswer);expect(sessionContextReduction(undefined,stats)).toBe(0);
   expect(restored.messages.some(m=>m.text.includes('Required content'))).toBe(true);
   return;
  }
   expect(result.error).toBeUndefined();expect(answers).toHaveLength(1);
   expect(JSON.stringify(answers[0].body.messages)).not.toContain('Saved conversation summary');

   const estimate=(await estimateContextInput(config.model,answers[0].body)).estimatedInputTokens!;
   expect(estimate).toBeLessThanOrEqual(10000);
   expect(estimate).toBeLessThanOrEqual(895904);
   expect(stats.lastAnswer!.sentInputTokens).toBe(estimate);expect(stats.lastAnswer!.afterInputTokens).toBe(estimate);
   const reduction=Math.round((stats.lastAnswer!.beforeInputTokens!-estimate)/stats.lastAnswer!.beforeInputTokens!*100);
   expect(sessionContextReduction(undefined,stats)).toBe(0);expect(stats.lastAnswer!.actualInputTokens).toBe(321);
   console.info(`Console ${blocked?'large recent turns':'fitting'}: before=${stats.lastAnswer!.beforeInputTokens}, after=${estimate}, summary requests=${summaries.length}, answer requests=1, Last request=321, Reduction=${reduction}%`);
 }finally{await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));await rm(folder,{recursive:true,force:true});}
});

it('persists a completed answer longer than the input limit and compacts it before the next request',async()=>{
 const folder=await mkdtemp(join(tmpdir(),'d8-long-answer-'));
 let server:ReturnType<typeof createSessionServer>;let base='';
 const start=async()=>{server=createSessionServer(join(folder,'sessions.sqlite'),{credentialStore:{status:async()=>false,read:async()=>{throw Error('Empty fake store')},save:async()=>{},forget:async()=>{}}});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const addr=server.address();if(!addr||typeof addr==='string')throw Error('No address');base=`http://127.0.0.1:${addr.port}`;};
 const stop=()=>new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
 const api=async(path='',method='GET',body?:unknown)=>{const r=await fetch(base+'/api/sessions'+path,{method,headers:{Origin:base,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});expect(r.ok).toBe(true);return r.json()};
 try{
  await start();const session=await api('','POST');const state=emptySession(session);
  const {ToolRegistry}=await import('./tool-runtime');const tools=new ToolRegistry();const bodies:any[]=[];
  const longAnswer='A complete detailed answer about the discussion. '.repeat(250);
  const fetcher=vi.fn(async(_url:unknown,init?:RequestInit)=>{const body=JSON.parse(String(init?.body));bodies.push(body);const summary=body.input.some((m:any)=>m.role==='system');const answers=bodies.filter(b=>!b.input.some((m:any)=>m.role==='system')).length;return new Response(JSON.stringify({output:[{type:'message',content:[{type:'output_text',text:summary?'The prior answer discussed the topic.':answers===1?longAnswer:'Follow-up answer.'}]}],usage:{input_tokens:17,output_tokens:summary?10:answers===1?1500:12,total_tokens:1517}}))}) as typeof fetch;
  const config={providerId:'openai' as const,model:'gpt-4o-mini',registry:createProviderRegistry(),requestTokenLimit:200,apiKey:'placeholder',fetcher};
  const manager=new ManagerAgent(createManagerLlmAdapter(config),tools);const onEvent=async(e:HistoryEvent)=>{await api('/'+session.id+'/events','POST',e)};
  const first=await manager.run({state,userText:'Explain.',onEvent});expect(first.error).toBeUndefined();expect(first.run.status).toBe('completed');
  const meter=aggregateSessionStats(state).lastAnswer!;const firstEstimate=meter.sentInputTokens;expect(firstEstimate).toBeLessThan(200);expect(meter.actualOutputTokens).toBe(1500);
  await stop();await start();const restored=restoreHistory(emptySession(session),await api('/'+session.id+'/events'));
  expect(restored.messages.at(-1)?.text).toBe(longAnswer);expect(restored.runs.at(-1)?.status).toBe('completed');
  expect(aggregateSessionStats(restored).lastAnswer?.sentInputTokens).toBe(firstEstimate);expect(aggregateSessionStats(restored).output.knownTokens).toBe(1500);
  const statsHtml=renderToStaticMarkup(createElement(SessionStatsContent,{stats:aggregateSessionStats(restored),context:managerContextBudget(config)}));
  expect(statsHtml).toMatch(/Last request<\/dt><dd[^>]*>≈35/);expect(statsHtml).toMatch(/Output<\/dt><dd[^>]*>1,500/);
  const {ChatRunLog}=await import('./chat-run-log');const chatHtml=renderToStaticMarkup(createElement(ChatRunLog,{events:buildWeek2Timeline(restored,tools)}));expect(chatHtml).toContain(longAnswer.trim());
  const dialogue=await estimateContextInput(config.model,restored.messages.map(m=>({role:m.role,content:m.text})));expect(dialogue.estimatedInputTokens).toBeGreaterThan(200);
  const follow=await manager.run({state:restored,userText:'Continue.',onEvent});expect(follow.error).toBeUndefined();
  expect(bodies.some(b=>b.input.some((m:any)=>m.role==='system'))).toBe(false);
  const answer=bodies.at(-1);expect(JSON.stringify(answer)).not.toContain('Saved conversation summary');
  expect((await estimateContextInput(config.model,answer)).estimatedInputTokens).toBeLessThanOrEqual(200);
  expect(restored.messages.some(m=>m.text===longAnswer)).toBe(true);
  const afterFollow=restoreHistory(emptySession(session),await api('/'+session.id+'/events'));expect(afterFollow.messages.some(m=>m.text===longAnswer)).toBe(true);
  console.info(`Long answer: input=${firstEstimate}, output=1500, dialogue=${dialogue.estimatedInputTokens}, follow-up=${(await estimateContextInput(config.model,answer)).estimatedInputTokens}`);
 }finally{if(server!?.listening)await stop();await rm(folder,{recursive:true,force:true});}
});

it('sends above the custom target when the model budget allows it',async()=>{
 const state=emptySession({id:'soft',title:'Soft',createdAt:1});const tools=createBuiltInToolRegistry();const bodies:any[]=[];
 const fetcher=vi.fn(async(_url:unknown,init?:RequestInit)=>{bodies.push(JSON.parse(String(init?.body)));return new Response(JSON.stringify({output:[{type:'message',content:[{type:'output_text',text:'Completed answer.'}]}],usage:{input_tokens:17,output_tokens:25}}))}) as typeof fetch;
 const result=await new ManagerAgent(createManagerLlmAdapter({providerId:'openai',model:'gpt-4o-mini',registry:createProviderRegistry(),requestTokenLimit:200,apiKey:'placeholder',fetcher}),tools).run({state,userText:'Continue.'});
 expect(result.error).toBeUndefined();expect(result.run.status).toBe('completed');expect(bodies).toHaveLength(1);
 expect(aggregateSessionStats(state).lastAnswer!.sentInputTokens).toBeGreaterThan(200);
});

it('shortens only dispatched current input and keeps the original in SQLite',async()=>{
 const folder=await mkdtemp(join(tmpdir(),'d8-short-input-'));const server=createSessionServer(join(folder,'sessions.sqlite'),{credentialStore:{status:async()=>false,read:async()=>{throw Error('Empty fake store')},save:async()=>{},forget:async()=>{}}});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const addr=server.address();if(!addr||typeof addr==='string')throw Error('No address');const base=`http://127.0.0.1:${addr.port}`;
 const api=async(path='',method='GET',body?:unknown)=>{const r=await fetch(base+'/api/sessions'+path,{method,headers:{Origin:base,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});expect(r.ok).toBe(true);return r.json()};
 try{
  const session=await api('','POST');const state=emptySession(session);const tools=createBuiltInToolRegistry();const registry=createProviderRegistry();registry.get('opencode-console')!.limits=()=>({contextWindow:6000,maxOutputTokens:4096});const requests:any[]=[];
  const fetcher=vi.fn(async(_url:unknown,init?:RequestInit)=>{requests.push(JSON.parse(String(init?.body)));return new Response(JSON.stringify({choices:[{message:{content:'Complete.'},finish_reason:'stop'}],usage:{prompt_tokens:30,completion_tokens:10}}))}) as typeof fetch;
  const config={providerId:'opencode-console' as const,model:'deepseek-v4.1-flash',registry,requestTokenLimit:200,apiKey:'placeholder',fetcher};
  const original='Long current request with important details. '.repeat(2000);
  const result=await new ManagerAgent(createManagerLlmAdapter(config),tools).run({state,userText:original,onEvent:async e=>{await api('/'+session.id+'/events','POST',e)}});
  expect(result.error).toContain('model input budget');expect(requests).toHaveLength(0);
  const restored=restoreHistory(emptySession(session),await api('/'+session.id+'/events'));expect(restored.messages[0].text).toBe(original);

 }finally{await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));await rm(folder,{recursive:true,force:true})}
});
