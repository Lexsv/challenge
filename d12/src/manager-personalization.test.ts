import { expect, it, vi } from 'vitest';
import { ManagerAgent, createManagerConversation, type ManagerLlmAdapter } from './manager-agent';
import { ManagerProviderError } from './manager-llm-adapter';
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
  for(const [input] of complete.mock.calls) expect(JSON.stringify(input.messages)).not.toContain(context.habits);
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
  for(const [input] of complete.mock.calls)expect(JSON.stringify(input.messages)).not.toContain(context.habits);
});

it('keeps an in-flight revision unchanged and accepts a fresh snapshot next turn',async()=>{
  const state=createManagerConversation();let release!:()=>void;
  const wait=new Promise<void>(resolve=>{release=resolve;});
  const seen:PersonalizationSnapshot[]=[];
  const adapter:ManagerLlmAdapter={complete:async input=>{seen.push(input.personalizationSnapshot!);if(seen.length===1)await wait;return {text:'Done'};}};
  const agent=new ManagerAgent(adapter,createBuiltInToolRegistry());
  const first={sessionId:state.conversation.id,profileId:'p',profileRevision:1,habits:'old'};
  const pending=agent.run({state,userText:'First',personalizationSnapshot:first});
  first.profileRevision=2;first.habits='new';release();await pending;
  expect(seen[0].profileRevision).toBe(1);expect(seen[0].habits).toBe('old');expect(Object.isFrozen(seen[0])).toBe(true);
  await agent.run({state,userText:'Second',personalizationSnapshot:snapshot(state.conversation.id,2,'new')});
  expect(seen[1].profileRevision).toBe(2);expect(seen[1].habits).toBe('new');
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
