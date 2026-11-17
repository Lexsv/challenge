import { expect, it, vi } from 'vitest';
import { ManagerAgent, createManagerConversation, type ManagerLlmAdapter } from './manager-agent';
import { createManagerLlmAdapter, ManagerProviderError } from './manager-llm-adapter';
import { ProviderRegistry } from './provider-registry';
import { createBuiltInToolRegistry } from './tool-runtime';
import { SessionMemory, MemoryProcessor, type MemorySnapshot, type MemoryStore } from './session-memory';
import type { PersonalizationSnapshot } from './week3-session-api';

const snapshot=(sessionId:string,revision=1,habits='synthetic-profile-habit'):PersonalizationSnapshot=>Object.freeze({sessionId,profileId:'synthetic-profile-id',profileRevision:revision,habits});

it('passes one frozen snapshot through a tool loop without writing it to history',async()=>{
  const state=createManagerConversation(), context=snapshot(state.conversation.id), events:unknown[]=[];
  const complete=vi.fn<ManagerLlmAdapter['complete']>().mockResolvedValueOnce({toolCalls:[{id:'call',toolId:'builtin.tax_calculator',arguments:{amount:100,taxRate:15}}]}).mockResolvedValueOnce({text:'Done'});
  const result=await new ManagerAgent({complete},createBuiltInToolRegistry()).run({state,userText:'Calculate',personalizationSnapshot:context,onEvent:async event=>{events.push(event);}});
  expect(result.finalResponse).toBe('Done');expect(complete).toHaveBeenCalledTimes(2);
  const first=complete.mock.calls[0][0].personalizationSnapshot,second=complete.mock.calls[1][0].personalizationSnapshot;
  expect(first).toEqual(context);expect(Object.isFrozen(first)).toBe(true);expect(second).toBe(first);
  for(const [input] of complete.mock.calls) {
    expect(input.messages.filter(message=>message.role==='developer')).toHaveLength(1);
    expect(input.messages[0].content).toContain(context.habits);
  }
  expect(JSON.stringify(events)).not.toContain(context.habits);expect(JSON.stringify(state)).not.toContain(context.profileId);
});

it('retains the snapshot through an overflow retry without placing it in memory',async()=>{
  const state=createManagerConversation(), context=snapshot(state.conversation.id), events:unknown[]=[];
  const prepare=vi.fn(async (_groups:unknown,current:readonly {role:'user';content:string}[])=>[{role:'system' as const,content:'Existing context'},...current]);
  const recover=vi.fn(async (current:readonly {role:'user';content:string}[])=>[...current]);
  const memory={prepare,recover,facts:async()=>[]} as unknown as SessionMemory;
  const complete=vi.fn<ManagerLlmAdapter['complete']>().mockRejectedValueOnce(new ManagerProviderError({kind:'context-overflow',status:400})).mockResolvedValueOnce({text:'Recovered'});
  const adapter:ManagerLlmAdapter={complete,context:{assess:async messages=>({tokens:messages.length*20,limit:1000,target:1000}),summarize:async()=>''}};
  const result=await new ManagerAgent(adapter,createBuiltInToolRegistry()).run({state,userText:'Question',sessionMemory:memory,personalizationSnapshot:context,onEvent:async event=>{events.push(event);}});
  expect(result.finalResponse).toBe('Recovered');expect(complete).toHaveBeenCalledTimes(2);expect(recover).toHaveBeenCalledOnce();
  expect(complete.mock.calls[1][0].personalizationSnapshot).toBe(complete.mock.calls[0][0].personalizationSnapshot);
  expect(JSON.stringify(prepare.mock.calls)).not.toContain(context.habits);expect(JSON.stringify(recover.mock.calls)).not.toContain(context.profileId);
  expect(JSON.stringify(events)).not.toContain(context.habits);
  for(const [input] of complete.mock.calls)expect(input.messages.filter(message=>message.role==='developer' && message.content.includes(context.habits))).toHaveLength(1);
});

it('includes habits in each budget assessment and blocks oversized input',async()=>{
  const state=createManagerConversation(), context=snapshot(state.conversation.id), assessed:readonly {role:string;content:string}[][]=[];
  const complete=vi.fn<ManagerLlmAdapter['complete']>().mockResolvedValue({text:'unexpected'});
  const agent=new ManagerAgent({complete,context:{assess:async messages=>{(assessed as {role:string;content:string}[][]).push([...messages]);return {tokens:200,limit:100};},summarize:async()=>''}},createBuiltInToolRegistry());
  const result=await agent.run({state,userText:'Question',personalizationSnapshot:context});
  expect(result.run.status).toBe('failed');expect(complete).not.toHaveBeenCalled();
  expect(assessed.length).toBeGreaterThan(0);
  for(const messages of assessed)expect(messages.filter(message=>message.role==='developer' && message.content.includes(context.habits))).toHaveLength(1);
});

it('keeps empty habits out of the request',async()=>{
  const state=createManagerConversation(),complete=vi.fn<ManagerLlmAdapter['complete']>().mockResolvedValue({text:'Done'});
  await new ManagerAgent({complete},createBuiltInToolRegistry()).run({state,userText:'Hello',personalizationSnapshot:snapshot(state.conversation.id,1,'')});
  expect(complete.mock.calls[0][0].messages).toEqual([{role:'user',content:'Hello'}]);
});

it.each([99,100,101])('handles a %i-token request against a 100-token limit',async tokens=>{
  const state=createManagerConversation(), context=snapshot(state.conversation.id), events:unknown[]=[];
  const complete=vi.fn<ManagerLlmAdapter['complete']>().mockResolvedValue({text:'Done'});
  const assess=vi.fn(async (messages:readonly {role:string;content:string}[])=>{
    expect(messages.filter(message=>message.role==='developer' && message.content.includes(context.habits))).toHaveLength(1);
    return {tokens,limit:100};
  });
  const result=await new ManagerAgent({complete,context:{assess,summarize:async()=>''}},createBuiltInToolRegistry()).run({state,userText:'Question',personalizationSnapshot:context,onEvent:async event=>{events.push(event);}});
  if(tokens<=100){expect(result.run.status).toBe('completed');expect(complete).toHaveBeenCalledOnce();}
  else {expect(result.run.status).toBe('failed');expect(result.error).toMatch(/exceeds.*budget/i);expect(complete).not.toHaveBeenCalled();expect(JSON.stringify(events)).toContain('failed');}
  expect(assess.mock.calls.length).toBeLessThanOrEqual(3);
});

it.each(['openai','opencode-console','opencode-go'] as const)('formats and accounts for habits in %s answer requests',async providerId=>{
  const bodies:Record<string,unknown>[]=[], registry=new ProviderRegistry();
  const transport=vi.fn(async (_provider:string,body:Record<string,unknown>)=>{
    bodies.push(body);
    return {status:200,body:providerId==='openai' ? {output:[{type:'message',content:[{type:'output_text',text:'Done'}]}]} : {choices:[{message:{content:'Done'}}]}};
  });
  const adapter=createManagerLlmAdapter({providerId,model:providerId==='openai'?'gpt-4o-mini':'kimi-k3',apiKey:'',registry,transport});
  const state=createManagerConversation(),context=snapshot(state.conversation.id,1,'Prefer thorough technical examples.');
  const result=await new ManagerAgent(adapter,createBuiltInToolRegistry()).run({state,userText:'Question',personalizationSnapshot:context});
  expect(result.run.status).toBe('completed');expect(bodies).toHaveLength(1);
  const messages=(providerId==='openai'?bodies[0].input:bodies[0].messages) as {role:string;content:string}[];
  const instructions=messages.filter(message=>typeof message.content==='string' && message.content.includes(context.habits));
  expect(instructions).toHaveLength(1);
  expect(instructions[0].role).toBe(providerId==='openai'?'developer':'system');
  expect(instructions[0].content).toContain('higher-priority instructions');
  expect(messages.indexOf(instructions[0])).toBeLessThan(messages.findIndex(message=>message.role==='user'));
  const plain=await adapter.context!.assess([{role:'user',content:'Question'}],[]);
  const personalized=await adapter.context!.assess([{role:'developer',content:instructions[0].content},{role:'user',content:'Question'}],[]);
  expect(personalized.tokens!).toBeGreaterThan(plain.tokens!);
});

it('keeps an in-flight revision unchanged and accepts a fresh snapshot next turn',async()=>{
  const state=createManagerConversation();let release!:()=>void;
  const wait=new Promise<void>(resolve=>{release=resolve;});
  const seen:PersonalizationSnapshot[]=[], requests:readonly {role:string;content:string}[][]=[];
  const adapter:ManagerLlmAdapter={complete:async input=>{seen.push(input.personalizationSnapshot!);(requests as {role:string;content:string}[][]).push([...input.messages]);if(seen.length===1)await wait;return {text:'Done'};}};
  const agent=new ManagerAgent(adapter,createBuiltInToolRegistry());
  const first={sessionId:state.conversation.id,profileId:'p',profileRevision:1,habits:'old'};
  const pending=agent.run({state,userText:'First',personalizationSnapshot:first});
  first.profileRevision=2;first.habits='new';release();await pending;
  expect(seen[0].profileRevision).toBe(1);expect(seen[0].habits).toBe('old');expect(Object.isFrozen(seen[0])).toBe(true);
  await agent.run({state,userText:'Second',personalizationSnapshot:snapshot(state.conversation.id,2,'new')});
  expect(seen[1].profileRevision).toBe(2);expect(seen[1].habits).toBe('new');
  expect(requests[0][0].content).toContain('old');expect(requests[1][0].content).toContain('new');
});

it('keeps legacy callers compatible and rejects a snapshot for another session',async()=>{
  const state=createManagerConversation(),complete=vi.fn<ManagerLlmAdapter['complete']>().mockResolvedValue({text:'Done'}),agent=new ManagerAgent({complete},createBuiltInToolRegistry());
  expect((await agent.run({state,userText:'Legacy'})).finalResponse).toBe('Done');
  expect(complete.mock.calls[0][0]).not.toHaveProperty('personalizationSnapshot');
  const previousMessages=state.messages.length;
  await expect(agent.run({state,userText:'Wrong session',personalizationSnapshot:snapshot('other')})).rejects.toThrow('another session');
  expect(state.messages).toHaveLength(previousMessages);expect(complete).toHaveBeenCalledTimes(1);
});

it('does not put the snapshot in saved SessionMemory or archived events',async()=>{
  let saved:MemorySnapshot={revision:0,data:null};
  const store:MemoryStore={load:async()=>structuredClone(saved),save:async value=>{saved={revision:value.revision+1,data:structuredClone(value.data)};return structuredClone(saved);}};
  const processor=new MemoryProcessor({complete:async()=>({text:''})});
  vi.spyOn(processor,'extract').mockResolvedValue([]);
  const state=createManagerConversation(), context=snapshot(state.conversation.id), events:unknown[]=[];
  const memory=new SessionMemory(store,processor,'gpt-4o-mini');
  await new ManagerAgent({complete:async()=>({text:'Answer'})},createBuiltInToolRegistry()).run({state,userText:'Question',sessionMemory:memory,personalizationSnapshot:context,onEvent:async event=>{events.push(event);}});
  expect(saved.revision).toBeGreaterThan(0);
  for(const record of [saved,events,state]){
    expect(JSON.stringify(record)).not.toContain(context.habits);
    expect(JSON.stringify(record)).not.toContain(context.profileId);
    expect(JSON.stringify(record)).not.toContain('profileRevision');
  }
});
