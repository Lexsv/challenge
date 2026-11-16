import { expect, it, vi } from 'vitest';
import { ContextBuilder, SessionMemory, MemoryProcessor, mergeMemoryFacts, type MemorySnapshot, type MemoryStore } from './session-memory';
import type { ManagerLlmMessage } from './manager-agent';
import { ManagerAgent, createManagerConversation } from './manager-agent';
import { createBuiltInToolRegistry } from './tool-runtime';
import { createManagerLlmAdapter, ManagerProviderError } from './manager-llm-adapter';
import { ProviderRegistry } from './provider-registry';

function fixture() {
  let snapshot: MemorySnapshot = { revision:0, data:null };
  const store: MemoryStore = { load:async()=>structuredClone(snapshot), save:async value=>{if(value.revision!==snapshot.revision)throw Error('conflict');snapshot={revision:value.revision+1,data:structuredClone(value.data)};return structuredClone(snapshot);} };
  const processor = new MemoryProcessor({complete:async()=>({text:''})});
  vi.spyOn(processor,'compress').mockResolvedValue('Decision: use the synthetic plan.');
  vi.spyOn(processor,'extract').mockResolvedValue([{subject:'Plan',attribute:'budget',value:'20 units',status:'confirmed',sources:['source']}]);
  return {store,processor,read:()=>snapshot};
}
const user = (content:string):ManagerLlmMessage => ({role:'user',content});
it('compresses overflow once, merges facts, and reuses covered memory after restart',async()=>{
  const f=fixture();const group={id:'one',messages:[user('old source '.repeat(100))]};
  const memory=new SessionMemory(f.store,f.processor,'gpt-4o-mini',60);
  const context=await memory.prepare([group],[user('Current question')],'current');
  expect(context.some(message=>message.content.includes('old source'))).toBe(false);
  expect(context.some(message=>message.content.includes('Decision:'))).toBe(true);
  expect(f.read().data?.covered).toEqual(['one']);
  const restored=new SessionMemory(f.store,f.processor,'gpt-4o-mini',60);
  await restored.prepare([group],[user('Current question')],'current');
  expect(f.processor.compress).toHaveBeenCalledTimes(1);
  expect(await restored.facts()).toHaveLength(1);
  await restored.putFact({subject:'plan',attribute:'budget',value:'30 units',status:'confirmed',sources:['update'],correction:true});
  expect((await restored.facts())[0].value).toBe('30 units');
  await restored.deleteFact('plan','budget');expect(await restored.facts()).toEqual([]);
});
it('retains the pending source and previous coverage when compression fails',async()=>{
  const f=fixture();vi.mocked(f.processor.compress).mockRejectedValueOnce(Error('offline'));
  const memory=new SessionMemory(f.store,f.processor,'gpt-4o-mini',60);
  const group={id:'old',messages:[user('source '.repeat(100))]};
  await expect(memory.prepare([group],[user('Question')],'q')).rejects.toThrow('offline');
  expect(f.read().data?.covered).toEqual([]);expect(f.read().data?.buffer).toEqual([group]);
  await memory.prepare([group],[user('Question')],'q');expect(f.read().data?.covered).toEqual(['old']);
});
it('rejects an oversized current message without changing saved memory',async()=>{
  const f=fixture();const memory=new SessionMemory(f.store,f.processor,'gpt-4o-mini',20);
  await expect(memory.prepare([],[user('long '.repeat(100))],'q')).rejects.toThrow('exceeds');
  expect(f.read().revision).toBe(0);
});
it('preserves Manager tool execution and passes the result to the answer request',async()=>{
  const f=fixture();const requests: ManagerLlmMessage[][]=[];
  const tools=createBuiltInToolRegistry();const execute=vi.spyOn(tools,'executeById');
  const complete=vi.fn(async ({messages}:{messages:readonly ManagerLlmMessage[]})=>{
    requests.push([...messages]);
    return requests.length===1 ? {toolCalls:[{id:'tax',toolId:'builtin.tax_calculator',arguments:{amount:100,taxRate:15}}]} : {text:'115'};
  });
  const state=createManagerConversation();
  const result=await new ManagerAgent({complete},tools).run({state,userText:'Calculate the tax.',sessionMemory:new SessionMemory(f.store,f.processor,'gpt-4o-mini')});
  expect(result.run.status).toBe('completed');expect(execute).toHaveBeenCalledTimes(1);
  expect(requests[1].some(message=>message.role==='tool' && message.content.includes('115'))).toBe(true);
});
it('deduplicates facts, preserves assumptions and contradictions, and accepts explicit corrections',()=>{
  const f={subject:'Trip',attribute:'time',value:'12:00',status:'confirmed' as const,sources:['first']};
  let facts=mergeMemoryFacts([f],[{...f,sources:['first']}]);expect(facts).toHaveLength(1);
  facts=mergeMemoryFacts(facts,[{...f,value:'15:00',status:'assumed',sources:['second']}]);expect(facts).toHaveLength(2);expect(facts[0].status).toBe('confirmed');
  facts=mergeMemoryFacts(facts,[{...f,value:'16:00',correction:true,sources:['third']}]);expect(facts).toHaveLength(1);expect(facts[0].value).toBe('16:00');expect(facts[0].supersedes).toEqual(expect.arrayContaining([expect.objectContaining({value:'12:00',sources:['first']})]));
  expect(mergeMemoryFacts([{subject:'old',attribute:'a',value:'v'}],[])[0].status).toBe('assumed');
});
it('splits large compression input into ordered chunks and carries the preceding summary',async()=>{
  const calls:string[]=[];
  const processor=new MemoryProcessor({complete:async()=>({text:''}),context:{assess:async messages=>({tokens:JSON.stringify(messages).length,limit:800}),summarize:async text=>{calls.push(text);return `summary ${calls.length}`;}}});
  expect(await processor.compress('',[{id:'one',messages:[user('abc '.repeat(400))]}])).toBe(`summary ${calls.length}`);
  expect(calls.length).toBeGreaterThan(1);expect(calls[1]).toContain('summary 1');
});
it('does not commit partial summary or coverage after an interrupted compression',async()=>{
  const f=fixture();vi.mocked(f.processor.compress).mockRejectedValueOnce(new Error('incomplete output'));
  const memory=new SessionMemory(f.store,f.processor,'gpt-4o-mini',60);
  await expect(memory.prepare([{id:'old',messages:[user('source '.repeat(100))]}],[user('question')],'q')).rejects.toThrow('incomplete output');
  expect(f.read().data?.summary).toBe('');expect(f.read().data?.covered).toEqual([]);expect(f.read().data?.buffer).toHaveLength(1);
});
it('recovers from a provider context overflow only after reducing the request',async()=>{
  const f=fixture();const tools=createBuiltInToolRegistry();const state=createManagerConversation();
  const seed=new ManagerAgent({complete:async()=>({text:'earlier answer'})},tools);
  await seed.run({state,userText:'older '.repeat(100)});
  const complete=vi.fn().mockRejectedValueOnce(new ManagerProviderError({kind:'context-overflow',status:400})).mockResolvedValueOnce({text:'done'});
  const assess=async (messages:readonly ManagerLlmMessage[])=>({tokens:JSON.stringify(messages).length,limit:100000});
  const result=await new ManagerAgent({complete,context:{assess,summarize:async()=>''}},tools).run({state,userText:'question',sessionMemory:new SessionMemory(f.store,f.processor,'gpt-4o-mini')});
  expect(result.run.status).toBe('completed');expect(complete).toHaveBeenCalledTimes(2);expect(f.read().data?.covered).toContain(state.runs[0].id);
});
it('stops after two smaller overflow retries',async()=>{
  const f=fixture(),tools=createBuiltInToolRegistry(),state=createManagerConversation();
  const seed=new ManagerAgent({complete:async()=>({text:'answer'})},tools);
  await seed.run({state,userText:'first '.repeat(80)});await seed.run({state,userText:'second '.repeat(80)});
  const complete=vi.fn().mockRejectedValue(new ManagerProviderError({kind:'context-overflow',status:400}));
  const assess=async (messages:readonly ManagerLlmMessage[])=>({tokens:JSON.stringify(messages).length,limit:100000});
  const result=await new ManagerAgent({complete,context:{assess,summarize:async()=>''}},tools).run({state,userText:'question',sessionMemory:new SessionMemory(f.store,f.processor,'gpt-4o-mini')});
  expect(result.run.status).toBe('failed');expect(result.error).toContain('two attempts');expect(complete).toHaveBeenCalledTimes(3);
});
it('does not retry a rate limit or output exhaustion as context overflow',async()=>{
  for (const failure of [new ManagerProviderError({kind:'rate-limit',status:429}),new Error('The provider returned an incomplete answer. Please retry.')]) {
    const f=fixture(),tools=createBuiltInToolRegistry(),complete=vi.fn().mockRejectedValue(failure);
    const result=await new ManagerAgent({complete},tools).run({state:createManagerConversation(),userText:'question',sessionMemory:new SessionMemory(f.store,f.processor,'gpt-4o-mini')});
    expect(result.run.status).toBe('failed');expect(complete).toHaveBeenCalledTimes(1);expect(f.processor.compress).not.toHaveBeenCalled();
  }
});
it('rejects a truncated summary even when the provider returned partial text',async()=>{
  const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({status:'incomplete',incomplete_details:{reason:'max_output_tokens'},output:[{content:[{type:'output_text',text:'partial summary'}]}]}),{status:200}));
  const adapter=createManagerLlmAdapter({providerId:'openai',model:'gpt-4o-mini',apiKey:'synthetic',registry:new ProviderRegistry(),fetcher});
  await expect(adapter.context!.summarize('Synthetic source',undefined,undefined,true)).rejects.toThrow('output allowance');
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('carries original text across extraction boundaries and deduplicates overlapping evidence',async()=>{
  const seen:string[]=[];
  const processor=new MemoryProcessor({
    context:{assess:async messages=>({tokens:JSON.stringify(messages).length,limit:950}),summarize:async()=>''},
    complete:async({messages})=>{const text=messages[1].content;seen.push(text);const facts=[];
      if(text.includes('deadline was November 20') && text.includes('new deadline is November 25'))facts.push({subject:'Project',attribute:'deadline',value:'November 25',status:'confirmed',correction:true,evidence:'new deadline is November 25'});
      if(text.includes('budget was 40') && text.includes('revised to 48 units'))facts.push({subject:'Project',attribute:'budget',value:'48 units',status:'confirmed',correction:true,evidence:'revised to 48 units'});
      return {text:JSON.stringify({facts})};
    }
  });
  const text='Prelude '.repeat(110)+'The deadline was November 20, but after discussion the new deadline is November 25. '+'More context '.repeat(110)+'The budget was 40 and is revised to 48 units. '+'End '.repeat(120);
  const facts=await processor.extract([user(text)],undefined,'message-1');
  expect(seen.length).toBeGreaterThan(3);
  expect(facts).toEqual(expect.arrayContaining([expect.objectContaining({attribute:'deadline',value:'November 25',sources:['message-1']}),expect.objectContaining({attribute:'budget',value:'48 units',sources:['message-1']})]));
  expect(facts).toHaveLength(2);
  expect(seen.some((chunk,index)=>index>0 && seen[index-1].slice(-30) && chunk.includes(seen[index-1].slice(-30)))).toBe(true);
});
it('leaves a fact absent when required evidence spans beyond every extraction window',async()=>{
  const seen:string[]=[];
  const processor=new MemoryProcessor({context:{assess:async messages=>({tokens:JSON.stringify(messages).length,limit:900}),summarize:async()=>''},complete:async({messages})=>{const source=messages[1].content;seen.push(source);return {text:JSON.stringify({facts:source.includes('BEGIN deadline') && source.includes('END November 25') ? [{subject:'Project',attribute:'deadline',value:'November 25',status:'confirmed',correction:true,evidence:'END November 25'}] : []})};}});
  const facts=await processor.extract([user('BEGIN deadline '+ 'intervening context '.repeat(150) +'END November 25')],undefined,'source');
  expect(seen.length).toBeGreaterThan(3);expect(seen.every(chunk=>!(chunk.includes('BEGIN deadline') && chunk.includes('END November 25')))).toBe(true);expect(facts).toEqual([]);
});
it('does not promote an assumed fact on repeated extraction of the same source',()=>{
  const assumed={subject:'Project',attribute:'deadline',value:'November 25',status:'assumed' as const,sources:['message']};
  expect(mergeMemoryFacts([assumed],[{...assumed,status:'confirmed'}])[0].status).toBe('assumed');
  expect(mergeMemoryFacts([assumed],[{...assumed,status:'confirmed',sources:['new-message']}])[0].status).toBe('assumed');
  expect(mergeMemoryFacts([assumed],[{...assumed,status:'confirmed',sources:['new-message'],correction:true}])[0].status).toBe('confirmed');
});
it('recompresses a summary only when the saved result becomes smaller',async()=>{
  const f=fixture(),memory=new SessionMemory(f.store,f.processor,'gpt-4o-mini');
  const data={covered:['old'],summary:'Important decision. '.repeat(100),facts:[{subject:'Project',attribute:'deadline',value:'November 25',status:'confirmed' as const,sources:['old']}],short:[],buffer:[],extracted:[]};
  await f.store.save({revision:0,data});
  vi.spyOn(f.processor,'recompressSummary').mockResolvedValueOnce('Important decision.');
  const result=await memory.recover([user('question')]);
  expect(result.some(message=>message.content.includes('Important decision.'))).toBe(true);expect(f.read().data?.facts).toEqual(data.facts);expect(f.read().data?.covered).toEqual(['old']);
  vi.mocked(f.processor.recompressSummary).mockResolvedValueOnce('Important decision. '.repeat(100));
  await expect(memory.recover([user('question')])).rejects.toThrow('did not reduce');
  expect(f.read().data?.summary).toBe('Important decision.');
});
it('retains the prior summary and coverage if persistence fails after recompression',async()=>{
  const f=fixture(),data={covered:['old'],summary:'Keep this. '.repeat(100),facts:[],short:[],buffer:[],extracted:[]};
  await f.store.save({revision:0,data});vi.spyOn(f.processor,'recompressSummary').mockResolvedValue('Keep this.');
  const failing:MemoryStore={load:()=>f.store.load(),save:async()=>{throw Error('revision conflict');}};
  await expect(new SessionMemory(failing,f.processor,'gpt-4o-mini').recover([user('q')])).rejects.toThrow('revision conflict');
  expect(f.read().data?.summary).toBe(data.summary);expect(f.read().data?.covered).toEqual(['old']);
});
it('advances coverage once per successful cycle and does not repeat it after restart',async()=>{
  const f=fixture(),first={id:'first',messages:[user('first topic '.repeat(90))]},second={id:'second',messages:[user('second topic '.repeat(90))]};
  const memory=new SessionMemory(f.store,f.processor,'gpt-4o-mini',60);
  await memory.prepare([first],[user('question 1')],'q1');
  const restarted=new SessionMemory(f.store,f.processor,'gpt-4o-mini',60);
  await restarted.prepare([first,second],[user('question 2')],'q2');
  expect(f.read().data?.covered).toEqual(['first','second']);expect(f.processor.compress).toHaveBeenCalledTimes(2);
  await new SessionMemory(f.store,f.processor,'gpt-4o-mini',60).prepare([first,second],[user('question 2')],'q2');
  expect(f.processor.compress).toHaveBeenCalledTimes(2);expect(f.read().data?.facts).toHaveLength(1);
});
it('rejects unsupported source evidence and preserves explicit uncertainty',async()=>{
  const complete=vi.fn().mockResolvedValueOnce({text:JSON.stringify({facts:[{subject:'Project',attribute:'deadline',value:'November 25',status:'confirmed',correction:false,evidence:'I think the deadline might be November 25.'}]})}).mockResolvedValueOnce({text:JSON.stringify({facts:[{subject:'Project',attribute:'deadline',value:'November 25',status:'confirmed',correction:false,evidence:'invented evidence'}]})});
  const processor=new MemoryProcessor({complete,context:{assess:async()=>({tokens:10,limit:10000}),summarize:async()=>''}});
  expect((await processor.extract([user('I think the deadline might be November 25.')],undefined,'source'))[0].status).toBe('assumed');
  await expect(processor.extract([user('Unrelated source.')],undefined,'other')).rejects.toThrow('unsupported evidence');
});
it('omits an invented value even when the evidence quote is real',async()=>{
  const processor=new MemoryProcessor({complete:async()=>({text:JSON.stringify({facts:[{subject:'Project',attribute:'deadline',value:'December 30',status:'confirmed',correction:false,evidence:'The deadline is November 25.'}]})}),context:{assess:async()=>({tokens:10,limit:10000}),summarize:async()=>''}});
  expect(await processor.extract([user('The deadline is November 25.')],undefined,'message')).toEqual([]);
});
it('recognizes a change request from its original source without claiming a booking occurred',async()=>{
  const processor=new MemoryProcessor({complete:async()=>({text:JSON.stringify({facts:[{subject:'Appointment',attribute:'day',value:'Monday',status:'confirmed',correction:true,evidence:'Monday'}]})}),context:{assess:async()=>({tokens:10,limit:10000}),summarize:async()=>''}});
  expect(await processor.extract([user('Actually, change my appointment to Monday.')],undefined,'correction')).toMatchObject([{value:'Monday',correction:true,sources:['correction']}]);
});
it('retains correction history and does not resurrect a reprocessed superseded source',()=>{
  const first={subject:'Appointment',attribute:'day',value:'Tuesday',status:'confirmed' as const,sources:['original']};
  const correction={...first,value:'Monday',sources:['correction'],correction:true};
  const updated=mergeMemoryFacts([first],[correction]);
  expect(updated).toHaveLength(1);expect(updated[0]).toMatchObject({value:'Monday',sources:['correction'],supersedes:[{value:'Tuesday',sources:['original']}]});
  expect(mergeMemoryFacts(updated,[first])).toEqual(updated);
  const conflicting=mergeMemoryFacts(updated,[{...first,value:'Friday',sources:['another']}]);expect(conflicting.map(fact=>fact.value)).toEqual(['Monday','Friday']);
});
it('includes the honesty policy and traceable current and historical facts in answer context',()=>{
  const facts=mergeMemoryFacts([{subject:'Appointment',attribute:'day',value:'Tuesday',status:'confirmed',sources:['one']}],[{subject:'Appointment',attribute:'day',value:'Monday',status:'confirmed',sources:['two'],correction:true}]);
  const messages=new ContextBuilder().build({covered:[],summary:'A generated summary',facts,short:[],buffer:[],extracted:[]},[user('When is my appointment?')]);
  const policy=messages[0].content;
  for(const phrase of ['If information is missing','assumed or uncertain','facts conflict','superseded values','external booking','Never invent'])expect(policy).toContain(phrase);
  expect(JSON.stringify(messages)).toContain('Monday');expect(JSON.stringify(messages)).toContain('Tuesday');expect(messages.at(-1)?.content).toBe('When is my appointment?');
});
it('does not re-extract an already processed user message when its run is compressed',async()=>{
  const f=fixture(),memory=new SessionMemory(f.store,f.processor,'gpt-4o-mini',60);
  await memory.prepare([],[user('Original statement')],'original-id');
  vi.mocked(f.processor.extract).mockClear();
  await memory.prepare([{id:'old-run',sourceIds:['original-id'],messages:[user('older '.repeat(100))]}],[user('Next question')],'next-id');
  expect(f.processor.extract).toHaveBeenCalledTimes(1);
  expect(f.processor.extract).toHaveBeenCalledWith([user('Next question')],undefined,'next-id');
});
it('supplies honesty instructions to the Manager when a mocked answer acknowledges missing memory',async()=>{
  const f=fixture();vi.mocked(f.processor.extract).mockResolvedValue([]);const calls: ManagerLlmMessage[][]=[];
  const complete=vi.fn(async ({messages}:{messages:readonly ManagerLlmMessage[]})=>{calls.push([...messages]);return {text:"I don't have that information in my available memory. Could you remind me?"};});
  const result=await new ManagerAgent({complete},createBuiltInToolRegistry()).run({state:createManagerConversation(),userText:'What is my passport number?',sessionMemory:new SessionMemory(f.store,f.processor,'gpt-4o-mini')});
  expect(result.finalResponse).toContain("don't have that information");
  expect(calls[0].some(message=>message.role==='system' && message.content.includes('If information is missing'))).toBe(true);
});
