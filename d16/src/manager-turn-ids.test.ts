import { expect, it, vi } from 'vitest';
import { ManagerAgent, createManagerConversation, type ManagerLlmAdapter } from './manager-agent';
import { ManagerProviderError } from './manager-llm-adapter';
import { createBuiltInToolRegistry } from './tool-runtime';
import type { HistoryEvent } from './conversation-history';
import type { SessionMemory } from './session-memory';

const turnIds={runId:'run-123',messageId:'message-456'};

it('preserves generated identifiers when no turn IDs are supplied',async()=>{
  const state=createManagerConversation(),result=await new ManagerAgent({complete:async()=>({text:'Done'})},createBuiltInToolRegistry()).run({state,userText:'Hello'});
  expect(result.run.id).toMatch(/^[a-zA-Z0-9-]+$/);expect(state.messages[0].id).toMatch(/^[a-zA-Z0-9-]+$/);
  expect(state.messages[0].runId).toBe(result.run.id);
});

it('retains supplied IDs across tool iterations and emits one associated user event',async()=>{
  const state=createManagerConversation(),events:HistoryEvent[]=[];
  const complete=vi.fn<ManagerLlmAdapter['complete']>().mockResolvedValueOnce({toolCalls:[{id:'tool',toolId:'builtin.tax_calculator',arguments:{amount:100,taxRate:15}}]}).mockResolvedValueOnce({text:'115'});
  const result=await new ManagerAgent({complete},createBuiltInToolRegistry()).run({state,userText:'Calculate',turnIds,onEvent:async event=>{events.push(event);}});
  expect(result.run.id).toBe(turnIds.runId);expect(state.messages[0]).toMatchObject({id:turnIds.messageId,runId:turnIds.runId});
  expect(state.messages.every(message=>message.runId===turnIds.runId)).toBe(true);
  expect(state.toolExecutions.every(execution=>execution.runId===turnIds.runId)).toBe(true);
  const userEvents=events.filter(event=>event.type==='message' && event.payload.role==='user');
  expect(userEvents).toHaveLength(1);expect(userEvents[0]).toMatchObject({sessionId:state.conversation.id,payload:{id:turnIds.messageId,runId:turnIds.runId}});
  expect(complete).toHaveBeenCalledTimes(2);
});

it.each([
  {runId:'',messageId:'message'}, {runId:'bad id',messageId:'message'}, {runId:'r'.repeat(101),messageId:'message'},
  {runId:'run',messageId:'bad/id'}, {runId:'same',messageId:'same'}, {runId:'run'}, null,
])('rejects malformed IDs before mutation or provider calls',async ids=>{
  const state=createManagerConversation(),before=structuredClone(state),complete=vi.fn(),events=vi.fn();
  const agent=new ManagerAgent({complete},createBuiltInToolRegistry());
  await expect(agent.run({state,userText:'Hello',turnIds:ids as typeof turnIds,onEvent:events})).rejects.toThrow('Invalid turn identifiers.');
  expect(state).toEqual(before);expect(complete).not.toHaveBeenCalled();expect(events).not.toHaveBeenCalled();
});

it.each(['runId','messageId'] as const)('rejects collisions with existing %s',async key=>{
  const state=createManagerConversation(),complete=vi.fn().mockResolvedValue({text:'Done'}),agent=new ManagerAgent({complete},createBuiltInToolRegistry());
  await agent.run({state,userText:'Previous',turnIds});const before=structuredClone(state);
  const next={runId:'new-run',messageId:'new-message',[key]:turnIds[key]};
  await expect(agent.run({state,userText:'Again',turnIds:next})).rejects.toThrow('Turn identifier already exists.');
  expect(state).toEqual(before);expect(complete).toHaveBeenCalledTimes(1);
});

it('checks identifier lists even when corresponding objects are absent',async()=>{
  const state=createManagerConversation(),complete=vi.fn(),agent=new ManagerAgent({complete},createBuiltInToolRegistry());
  state.conversation.runIds.push('listed-run');state.conversation.messageIds.push('listed-message');
  await expect(agent.run({state,userText:'Hi',turnIds:{runId:'listed-run',messageId:'new-message'}})).rejects.toThrow('already exists');
  await expect(agent.run({state,userText:'Hi',turnIds:{runId:'new-run',messageId:'listed-message'}})).rejects.toThrow('already exists');
  expect(complete).not.toHaveBeenCalled();expect(state.messages).toHaveLength(0);
});

it('rejects cross-kind collisions instead of reusing another entity ID',async()=>{
  const state=createManagerConversation(),agent=new ManagerAgent({complete:async()=>({text:'Done'})},createBuiltInToolRegistry());
  await agent.run({state,userText:'Previous',turnIds});
  await expect(agent.run({state,userText:'Again',turnIds:{runId:turnIds.messageId,messageId:'new-message'}})).rejects.toThrow('already exists');
  await expect(agent.run({state,userText:'Again',turnIds:{runId:'new-run',messageId:turnIds.runId}})).rejects.toThrow('already exists');
});

it('preserves the supplied IDs during memory recovery and retry',async()=>{
  const state=createManagerConversation(),events:HistoryEvent[]=[];
  const prepare=vi.fn(async (_groups:unknown,current:readonly {role:'user';content:string}[],currentId:string)=>{expect(currentId).toBe(turnIds.messageId);return [{role:'system' as const,content:'Old memory'},...current];});
  const recover=vi.fn(async (current:readonly {role:'user';content:string}[])=>[...current]);
  const sessionMemory={prepare,recover,facts:async()=>[]} as unknown as SessionMemory;
  const complete=vi.fn<ManagerLlmAdapter['complete']>().mockRejectedValueOnce(new ManagerProviderError({kind:'context-overflow',status:400})).mockResolvedValueOnce({text:'Recovered'});
  const adapter:ManagerLlmAdapter={complete,context:{assess:async messages=>({tokens:messages.length*20,limit:1000}),summarize:async()=>''}};
  const result=await new ManagerAgent(adapter,createBuiltInToolRegistry()).run({state,userText:'Question',turnIds,sessionMemory,onEvent:async event=>{events.push(event);}});
  expect(result.run.id).toBe(turnIds.runId);expect(result.finalResponse).toBe('Recovered');expect(recover).toHaveBeenCalledOnce();
  expect(complete).toHaveBeenCalledTimes(2);expect(events.filter(event=>event.type==='message' && event.payload.role==='user')).toHaveLength(1);
  expect(events.filter(event=>event.type==='message').every(event=>event.type==='message' && event.payload.runId===turnIds.runId)).toBe(true);
});
