import { expect, it, vi } from 'vitest';
import { createManagerConversation, ManagerAgent, type ManagerLlmAdapter, type ManagerLlmMessage } from './manager-agent';
import { ToolRegistry, createBuiltInToolRegistry } from './tool-runtime';
import type { FactStore } from './key-facts-context';

function fixture(limit = 10000) {
  let saved: Awaited<ReturnType<FactStore['load']>> = {facts:[],coveredMessageId:null};
  const requests: ManagerLlmMessage[][] = [];
  const summarize = vi.fn(async () => {throw Error('Summary is forbidden');});
  const complete = vi.fn(async ({messages}: Parameters<ManagerLlmAdapter['complete']>[0]) => {
    requests.push(structuredClone([...messages]));
    if (messages[0]?.content.startsWith('Extract only facts')) return {text:JSON.stringify({facts:[{subject:'Project',attribute:'budget',value:'$100'}]})};
    return {text:'answer'};
  });
  const adapter:ManagerLlmAdapter = {complete,context:{summarize,assess:async messages=>({tokens:messages.reduce((n,m)=>n+m.content.length,0),limit})}};
  const store: FactStore = {recentMessages:10,load:async()=>structuredClone(saved),save:async value=>{expect(value.expectedCoveredMessageId).toBe(saved.coveredMessageId); saved={facts:value.facts,coveredMessageId:value.coveredMessageId};}};
  return {adapter,store,requests,summarize,getSaved:()=>saved};
}

it('extracts messages 1–11 at message 21 and reuses coverage on restart',async()=>{
 const f=fixture(),state=createManagerConversation(),tools=new ToolRegistry();
 const seed=new ManagerAgent({complete:async()=>({text:'answer'})},tools);
 for(let i=1;i<=9;i++)await seed.run({state,userText:`question ${i}`});
 const manager=new ManagerAgent(f.adapter,tools);
 const twenty=structuredClone(state);
 await new ManagerAgent({complete:async()=>{throw Error('mock failure');}},tools).run({state:twenty,userText:'prior question'});
 expect((await manager.run({state:twenty,userText:'question 10',keyFacts:f.store})).error).toBeUndefined();
 expect(f.requests).toHaveLength(1);expect(f.requests[0].map(m=>m.content)).toContain('question 1');
 await seed.run({state,userText:'question 10'});
 expect((await manager.run({state,userText:'question 11',keyFacts:f.store})).error).toBeUndefined();
 expect(f.requests).toHaveLength(3);
 expect(f.requests[1][0].content).toContain('Extract only facts');
 expect(f.requests[1][1].content).toContain('question 1');expect(f.requests[1][1].content).toContain('question 6');expect(f.requests[1][1].content).not.toContain('question 7');
 expect(f.requests[2].map(m=>m.content)).not.toContain('question 1');
 expect(f.requests[2].map(m=>m.content)).toContain('question 7');expect(f.requests[2].at(-1)?.content).toBe('question 11');
 const before=f.getSaved().coveredMessageId;f.requests.length=0;
 expect((await new ManagerAgent(f.adapter,tools).run({state,userText:'question 12',keyFacts:f.store})).error).toBeUndefined();
 expect(f.requests).toHaveLength(1);expect(f.getSaved().coveredMessageId).toBe(before);expect(f.requests[0].map(m=>m.content)).not.toContain('question 1');
 expect(f.summarize).not.toHaveBeenCalled();
});

it('retains facts and coverage when extraction or saving fails',async()=>{
 for(const failure of ['extract','save'] as const){
  const f=fixture(),state=createManagerConversation(),tools=new ToolRegistry(),seed=new ManagerAgent({complete:async()=>({text:'answer'})},tools);
  for(let i=0;i<10;i++)await seed.run({state,userText:`question ${i}`});
  if(failure==='extract') vi.mocked(f.adapter.complete).mockResolvedValueOnce({text:'not json'});
  else f.store.save=async()=>{throw Error('save failed');};
  const result=await new ManagerAgent(f.adapter,tools).run({state,userText:'current',keyFacts:f.store});
  expect(result.error).toBeTruthy();expect(f.getSaved()).toEqual({facts:[],coveredMessageId:null});
  expect(state.messages.some(m=>m.text==='question 0')).toBe(true);
 }
});

it('extracts the older buffer early when the answer exceeds the input budget',async()=>{
 const f=fixture(800),state=createManagerConversation(),tools=new ToolRegistry(),seed=new ManagerAgent({complete:async()=>({text:'answer'})},tools);
 for(let i=0;i<6;i++)await seed.run({state,userText:`question ${i} ${'x'.repeat(120)}`});
 const result=await new ManagerAgent(f.adapter,tools).run({state,userText:'current',keyFacts:f.store});
 expect(result.error).toBeUndefined();expect(f.requests[0][0].content).toContain('Extract only facts');
 expect(f.getSaved().coveredMessageId).not.toBeNull();expect(f.requests.at(-1)?.at(-1)?.content).toBe('current');
});

it('uses no extraction in Token budget and retains facts across a strategy switch',async()=>{
 const f=fixture(),state=createManagerConversation(),tools=new ToolRegistry(),seed=new ManagerAgent({complete:async()=>({text:'answer'})},tools);
 for(let i=0;i<10;i++)await seed.run({state,userText:`question ${i}`});
 const manager=new ManagerAgent(f.adapter,tools);
 await manager.run({state,userText:'Key Facts',keyFacts:f.store});
 const covered=f.getSaved().coveredMessageId;expect(covered).not.toBeNull();
 f.requests.length=0;await manager.run({state,userText:'Token budget'});
 expect(f.requests).toHaveLength(1);expect(f.requests[0][0].content).not.toContain('Extract only facts');
 expect(f.getSaved().coveredMessageId).toBe(covered);
 f.requests.length=0;await manager.run({state,userText:'Back to Key Facts',keyFacts:f.store});
 expect(f.requests).toHaveLength(1);expect(f.requests[0][0].content).toContain('Saved key facts');
});

it('extracts a too-large current message while keeping its original in history',async()=>{
 const f=fixture(800),state=createManagerConversation(),text='Large question '.repeat(100);
 const result=await new ManagerAgent(f.adapter,new ToolRegistry()).run({state,userText:text,keyFacts:f.store});
 expect(result.error).toBeUndefined();expect(f.requests.length).toBeGreaterThan(1);
 expect(f.requests.at(-1)?.at(-1)?.content).toContain('Essential facts extracted');
 expect(state.messages.some(m=>m.text===text)).toBe(true);
});

it('preserves the active tool call and result together on the next answer request',async()=>{
 const f=fixture(),state=createManagerConversation(),tools=createBuiltInToolRegistry();
 const execute=vi.spyOn(tools,'executeById');
 vi.mocked(f.adapter.complete).mockImplementationOnce(async ({messages})=>{f.requests.push(structuredClone([...messages]));return {toolCalls:[{id:'call',toolId:'builtin.tax_calculator',arguments:{amount:100,taxRate:15}}]};});
 const result=await new ManagerAgent(f.adapter,tools).run({state,userText:'Calculate',keyFacts:f.store});
 expect(result.error).toBeUndefined();expect(execute).toHaveBeenCalledTimes(1);
 expect(f.requests[1].slice(-2)).toMatchObject([{role:'assistant',toolCalls:[{id:'call'}]},{role:'tool',toolCallId:'call'}]);
});
