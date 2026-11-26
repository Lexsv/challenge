import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SHORT_TERM_TOKEN_BUDGET, ContextBuilder, SessionMemory, MemoryProcessor, mergeMemoryFacts, type MemorySnapshot, type MemoryStore } from './session-memory';
import { estimateMemoryTokenStats } from './memory-token-stats';
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
it('uses the shared 1000-token default and retains facts and recent messages across a normal overflow',async()=>{
  expect(DEFAULT_SHORT_TERM_TOKEN_BUDGET).toBe(1000);
  const f=fixture(),memory=new SessionMemory(f.store,f.processor,'gpt-4o-mini');
  await memory.putFact({subject:'Schedule',attribute:'date',value:'Friday',status:'confirmed',sources:['new'],supersedes:[{value:'Monday',status:'confirmed',sources:['old']}]});
  const small={id:'small',messages:[user('Recent detail.')]};
  await memory.prepare([small],[user('Current question')],'first');expect(f.processor.compress).not.toHaveBeenCalled();
  const before=await estimateMemoryTokenStats(f.read().data,'gpt-4o-mini');
  const old={id:'old-run',messages:[user('older '.repeat(1500))]};
  const context=await memory.prepare([old,small],[user('Next question')],'second');
  expect(f.processor.compress).toHaveBeenCalledTimes(1);expect(f.read().data?.covered).toEqual(['old-run']);expect(f.read().data?.buffer).toEqual([]);
  expect(context.some(message=>message.content==='Recent detail.')).toBe(true);expect(context.at(-1)?.content).toBe('Next question');
  expect(f.read().data?.summary).toBe('Decision: use the synthetic plan.');
  expect(f.read().data?.facts.find(fact=>fact.subject==='Schedule')?.supersedes).toEqual([{value:'Monday',status:'confirmed',sources:['old']}]);
  expect(f.read().data?.facts.some(fact=>fact.subject==='Plan')).toBe(true);
  const after=await estimateMemoryTokenStats(f.read().data,'gpt-4o-mini');expect(before.mediumTermTokens).toBe(0);expect(after.mediumTermTokens).toBeGreaterThan(0);expect(after.longTermTokens).toBeGreaterThan(0);
});
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
  const processor=new MemoryProcessor({complete:async()=>({text:'{"preserved":true}'}),context:{assess:async messages=>messages[0].content.startsWith('Review a proposed')?{tokens:100,limit:2000}:{tokens:JSON.stringify(messages).length,limit:800},summarize:async text=>{calls.push(text);return `summary ${calls.length}`;}}});
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
    context:{assess:async messages=>({tokens:JSON.stringify(messages).length,limit:1400}),summarize:async()=>''},
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
  const processor=new MemoryProcessor({context:{assess:async messages=>({tokens:JSON.stringify(messages).length,limit:1350}),summarize:async()=>''},complete:async({messages})=>{const source=messages[1].content;seen.push(source);return {text:JSON.stringify({facts:source.includes('BEGIN deadline') && source.includes('END November 25') ? [{subject:'Project',attribute:'deadline',value:'November 25',status:'confirmed',correction:true,evidence:'END November 25'}] : []})};}});
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
  expect(JSON.stringify(messages)).toContain('Monday');expect(JSON.stringify(messages)).not.toContain('Tuesday');expect(messages.at(-1)?.content).toBe('When is my appointment?');
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

const cite=(quote:string)=>({source:"current",quote});
const wire=(topic:unknown)=>({text:JSON.stringify({version:1,facts:[],topic})});
const createTopic=(description:string,tags:string[],quote:string,edits:unknown[]=[])=>({
  kind:"write",updates:[{target:{kind:"new",description,tags,mention:cite(quote)},edits}]});
const dateEdit=(value:string,quote:string)=>({kind:"set",field:"date",value,evidence:cite(quote)});
const readTopic=(card:string,field:string|null=null)=>({kind:"read",purpose:"answer",queries:[{card,field,selector:{kind:"current"}}]});

it('rejects an unversioned action on the first turn and retries a malformed decision without partial writes', async()=>{
  const f=fixture();
  const message='Давай спланируем отдых на озере с друзьями';
  const write={action:'write',id:'new',description:'Озеро с друзьями',tags:['озеро','друзья'],changes:[]};
  const complete=vi.fn()
    .mockResolvedValueOnce({text:JSON.stringify({...write,changes:[{field:'date',value:'Tomorrow',evidence:'unmentioned'}]})})
    .mockResolvedValueOnce({text:'{"evidence":[]}'})
    .mockResolvedValue(wire(createTopic(write.description,write.tags,"озере")));
  const memory=new SessionMemory(f.store,new MemoryProcessor({complete,context:{assess:async()=>({tokens:1,limit:5000}),summarize:async()=>''}}),'gpt-4o-mini');
  const attempt=()=>memory.prepare([],[user(message)],'one',undefined,{id:'one',at:1,order:1});
  await expect(attempt()).rejects.toThrow(/proposal/);
  expect(f.read()).toEqual({revision:0,data:null});
  await attempt();await attempt();
  expect(f.read().data?.catalog?.cards).toEqual([{id:'one',description:write.description,tags:write.tags,changes:[]}]);
  expect(f.read().data?.covered).toEqual([]);
});

it('retries failed dialogue compression on a card turn and keeps superseded dialogue out of its answer',async()=>{
  const f=fixture(), detail='Оператор произнёс «янтарный фонарь».';
  const catalog={active:'lake',cards:[{id:'lake',description:'Lake',tags:[],changes:[{field:'roster',value:['Lena'],evidence:'Lena',id:'one',at:1,order:1}]}]};
  await f.store.save({revision:0,data:{catalog,buffer:[],short:[],summary:'',covered:[],facts:[],extracted:['one']}});
  const processor=new MemoryProcessor({context:{assess:async()=>({tokens:1,limit:5000}),summarize:async()=>detail},complete:async({messages})=>({text:messages[0].content.startsWith('Review')?'{"preserved":true}':wire(readTopic('lake','roster')).text})});
  const compress=vi.spyOn(processor,'compress').mockRejectedValueOnce(Error('summary unavailable'));
  const memory=new SessionMemory(f.store,processor,'gpt-4o-mini',30);
  const groups=[{id:'run1',sourceIds:['one'],messages:[user(detail+' Katya '.repeat(90))]}];
  const prepare=()=>memory.prepare(groups,[user('Кто сейчас едет?')],'q',undefined,{id:'q',at:2,order:2});
  await expect(prepare()).rejects.toThrow('summary unavailable');expect(f.read().data?.covered).toEqual([]);
  const answer=await prepare();
  expect(compress).toHaveBeenCalledTimes(2);
  expect(f.read().data).toMatchObject({summary:detail,covered:['run1']});
  expect(JSON.stringify(answer)).toContain('Lena');
  expect(JSON.stringify(answer)).not.toContain('Katya');
});

it('resolves a misrouted dialogue reply through a targeted selection without writing advice as a fact',async()=>{
  const f=fixture();
  const pending={intent:'read' as const, source:{id:'ask',at:1,order:1},question:'Which trip?',text:'How should we divide the work?'};
  const card={id:'mountains',description:'Горы',tags:['trip'],changes:[]};
  await f.store.save({revision:0,data:{catalog:{pending,cards:[card]},summary:'',facts:[],short:[],buffer:[],covered:[],extracted:[]}});
  const complete=vi.fn().mockResolvedValueOnce(wire({kind:'dialogue'}))
    .mockResolvedValueOnce(wire(readTopic('mountains')));
  const memory=new SessionMemory(f.store,new MemoryProcessor({complete,context:{assess:async()=>({tokens:50,limit:10000}),summarize:async()=>''}}),'gpt-4o-mini');
  const answer=await memory.prepare([],[user('Давай для гор')],'reply',undefined,{id:'reply',at:2,order:2});
  expect(f.read().data?.catalog).toMatchObject({active:'mountains',cards:[card]});
  expect(f.read().data?.catalog?.pending).toBeUndefined();
  expect(JSON.stringify(answer)).toContain(pending.text);
});

it('grounds recall in a reviewed summary and an original covered turn after reopening memory',async()=>{
  const f=fixture(), original='Слова для ведущего: «Серебряный маяк».';
  const group={id:'source-run',messages:[user(original)],sourceIds:['source-msg']};
  await f.store.save({revision:0,data:{catalog:{cards:[]},short:[],facts:[],summary:'Просили запомнить слова «Серебряный маяк».',buffer:[],covered:[group.id],extracted:['source-msg']}});
  const complete=vi.fn().mockResolvedValue({text:wire({kind:'recall',quote:'Серебряный маяк'}).text});
  const memory=new SessionMemory(f.store,new MemoryProcessor({complete,context:{assess:async()=>({tokens:50,limit:10000}),summarize:async()=>''}}),'gpt-4o-mini');
  const request=await memory.prepare([group],[user('Что я просил запомнить?')],'q',undefined,{at:2,order:2,id:'q'});
  const evidence=JSON.parse(request.find(m=>m.content.startsWith('Selected task records:'))!.content.slice('Selected task records: '.length));
  expect(evidence.original).toEqual({runId:group.id,role:'user',excerpt:original});
  expect(evidence.dialogueSummaryExcerpt).toContain('Серебряный маяк');
  expect(f.read().data?.short.flatMap(g=>g.messages)).not.toContainEqual(user(original));
});

it.each([false,true])("repairs an omitted creation changes array once; explicit fields=%s",async(explicit)=>{
  const f=fixture(), text=explicit ? 'Планируем поездку на озеро 20 июля.' : 'Давай спланируем отдых на озере с друзьями';
  const plan={action:'write',id:'new',description:'Отдых на озере с друзьями',tags:['озеро','друзья']};
  const complete=vi.fn().mockResolvedValueOnce({text:JSON.stringify({facts:[],topic:plan})})
    .mockResolvedValueOnce(wire(createTopic(plan.description,plan.tags,explicit?'озеро':'озере',explicit?[dateEdit('20 июля','20 июля')]:[])));
  const memory=new SessionMemory(f.store,new MemoryProcessor({complete,context:{assess:async()=>({tokens:10,limit:2000}),summarize:async()=>''}}),'gpt-4o-mini');
  await memory.prepare([],[user(text)],'m',undefined,{id:'m',at:1,order:1});
  expect(complete).toHaveBeenCalledTimes(2);
  expect(f.read().data?.catalog?.cards).toHaveLength(1);
  expect(f.read().data?.catalog?.cards[0].changes.length).toBe(explicit?1:0);
});

it("rejects a malformed repair before writing and permits retry from the original turn",async()=>{
  const f=fixture(),plan={action:'write',id:'new',description:'Озеро',tags:['озеро']};
  const complete=vi.fn().mockResolvedValueOnce({text:JSON.stringify({facts:[],topic:plan})})
    .mockResolvedValueOnce({text:'{"changes":null}'}).mockResolvedValue(wire(createTopic(plan.description,plan.tags,'озеро')));
  const memory=new SessionMemory(f.store,new MemoryProcessor({complete,context:{assess:async()=>({tokens:10,limit:2000}),summarize:async()=>''}}),'gpt-4o-mini');
  const attempt=()=>memory.prepare([],[user('Создай поездку на озеро')],'m',undefined,{id:'m',at:1,order:1});
  await expect(attempt()).rejects.toThrow(/proposal/);
  expect(complete).toHaveBeenCalledTimes(2);expect(f.read().revision).toBe(0);
  await attempt();await attempt();
  expect(f.read().data?.catalog?.cards).toHaveLength(1);
});

it("opens the finished catalog for an explicit lookup without putting it into the initial extraction", async()=>{
  const f=fixture(), card={id:'old',description:'Archived summer trip',tags:['summer'],changes:[]};
  await f.store.save({revision:0,data:{catalog:{boundary:'finished',cards:[card]},short:[],buffer:[],covered:[],extracted:[],summary:'',facts:[]}});
  const complete=vi.fn()
    .mockResolvedValueOnce(wire({kind:'lookup_catalog'}))
    .mockResolvedValueOnce(wire(readTopic('old')));
  const processor=new MemoryProcessor({complete,context:{assess:async()=>({tokens:50,limit:5000}),summarize:async()=>''}});
  const result=await new SessionMemory(f.store,processor,'gpt-4o-mini').prepare([],[user("Reopen last summer's trip")],'q',undefined,{id:'q',at:2,order:2});
  expect(JSON.stringify(complete.mock.calls[0])).not.toContain(card.description);
  expect(JSON.stringify(complete.mock.calls[1])).toContain(card.description);
  expect(JSON.stringify(result)).toContain(card.description);
  expect(f.read().data?.catalog?.active).toBe(card.id);
});

it("creates an explicitly new task after Finish without sending old cards to the model",async()=>{
  const f=fixture(), old={id:'old',description:'Old lake holiday',tags:['lake'],changes:[]};
  await f.store.save({revision:0,data:{catalog:{boundary:'finished',cards:[old]},short:[],buffer:[],covered:[],extracted:[],summary:'',facts:[]}});
  const plan={action:'write',id:'new',description:'House repairs',tags:['repairs'],changes:[]};
  const complete=vi.fn().mockResolvedValue(wire(createTopic(plan.description,plan.tags,"house repairs")));
  const processor=new MemoryProcessor({complete,context:{assess:async()=>({tokens:50,limit:5000}),summarize:async()=>''}});
  const result=await new SessionMemory(f.store,processor,'gpt-4o-mini').prepare([],[user('Start a new plan for house repairs.')],'q',undefined,{id:'q',at:2,order:2});
  expect(complete).toHaveBeenCalledTimes(1);
  expect(JSON.stringify([complete.mock.calls,result])).not.toContain(old.description);
  expect(f.read().data?.catalog?.cards.map(c=>c.id)).toEqual(['old','q']);
});

it('confirms saved transitions and repeats from receipts despite a contradictory provider answer',async()=>{
  const f=fixture();
  const card={id:'lake',description:'Отдых на озере с друзьями',tags:['озеро'],changes:[
    {id:'lake',at:1,order:1,field:'date',value:'2027-08-04',evidence:'4 августа'}]};
  await f.store.save({revision:0,data:{catalog:{cards:[card],active:card.id},summary:'',facts:[],buffer:[],short:[],extracted:[],covered:[]}});
  const llm=new MemoryProcessor({complete:async({messages})=>{
    const text=JSON.parse(messages[1].content)[0].content;
    return wire({kind:"write",updates:[{target:{kind:"existing",card:card.id,mention:cite("озеро")},edits:[dateEdit('2027-08-08','8 августа 2027 года')]}]});
  },context:{assess:async()=>({tokens:100,limit:5000}),summarize:async()=>''}});
  const memory=new SessionMemory(f.store,llm,'gpt-4o-mini');
  const complete=vi.fn().mockResolvedValue({text:'Дата отдыха на озере уже была указана как **8 августа 2027 года**; новое изменение не потребовалось. ПЕРСОНАЛЬНО'});
  const manager=new ManagerAgent({complete},createBuiltInToolRegistry()), state=createManagerConversation();
  const run=(userText:string)=>manager.run({state,userText,sessionMemory:memory, receiptRequiredLiterals:['ПРОВЕРЕНО'],
    personalizationSnapshot:{sessionId:state.conversation.id,profileId:'test',profileRevision:1,habits:'В конце каждого ответа добавляй слово ПЕРСОНАЛЬНО.'}});
  const changed=await run('Ещё переносим озеро на 8 августа 2027 года.');
  expect(changed.finalResponse).toContain('изменено с «2027-08-04» на «2027-08-08»');
  const repeated=await run('Дата поездки на озеро остаётся 8 августа 2027 года.');
  expect(repeated.finalResponse).toContain('Это значение уже сохранено');
  for(const result of [changed,repeated]) expect(result.finalResponse).toMatch(/ПРОВЕРЕНО ПЕРСОНАЛЬНО\.$|ПРОВЕРЕНО ПЕРСОНАЛЬНО$/);
  expect(f.read().data?.catalog?.cards[0].changes).toHaveLength(2);
  expect(f.read().data?.catalog?.cards[0].confirmations).toHaveLength(1);
  expect(complete).not.toHaveBeenCalled();
  vi.spyOn(f.store,'save').mockRejectedValueOnce(Error('revision conflict'));
  const rejected=await run('Дата поездки на озеро остаётся 8 августа 2027 года.');
  expect(rejected.error).toContain('revision conflict');
  expect(rejected.finalResponse).toBeUndefined();
  expect(memory.writeReceipts).toEqual([]);
});

it('permits one citation-only repair against the current user message before saving',async()=>{
  const f=fixture(),message='Озеро: 4 августа 2027 года. Идут Ира и Лена.';
  const write={action:'write',id:'new',description:'Озеро',tags:['озеро'],changes:[
    {field:'date',value:'2027-08-04',evidence:'The lake moved to August 4.'},
    {field:'participants',value:['Ира','Лена'],evidence:'Идут Ира и Лена.'}]};
  const proposal=(date:string)=>wire(createTopic(write.description,write.tags,"Озеро",[
    dateEdit("2027-08-04",date),{kind:"set_roster",names:["Ира","Лена"],evidence:cite("Идут Ира и Лена.")}]));
  const complete=vi.fn().mockResolvedValueOnce(proposal("The lake moved to August 4.")).mockResolvedValueOnce(proposal("Озеро: 4 августа 2027 года."));
  const processor=new MemoryProcessor({complete,context:{assess:async()=>({tokens:30,limit:5000}),summarize:async()=>''}});
  await new SessionMemory(f.store,processor,'gpt-4o-mini').prepare([],[user(message)],'m',undefined,{id:'m',at:1,order:1});
  expect(complete).toHaveBeenCalledTimes(2);
  expect(f.read().revision).toBe(1);
  expect(f.read().data?.catalog?.cards[0].changes.map(v=>[v.field,v.value,v.evidenceStart])).toEqual([
    ['date','2027-08-04',0],['participants',['Ира','Лена'],message.indexOf('Идут')]
  ]);
});

it.each(['unsupported value','different target','malformed repair','ambiguous citation'])('rejects %s atomically after one repair, then retries cleanly',async(kind)=>{
  const f=fixture(), message='Озеро: 4 августа 2027 года. Море: 5 августа 2027 года.';
  const write={action:'write',id:'new',description:'Озеро',tags:['озеро'],changes:[
    {field:'date',value:kind==='unsupported value'?'2027-08-05':'2027-08-04',evidence:'unsupported paraphrase'}]};
  const quote='Озеро: 4 августа 2027 года.';
  const fixed={...write,changes:[{field:'date',value:'2027-08-04',evidence:quote}]};
  const proposal=(value:string,evidence:string)=>wire(createTopic(write.description,write.tags,"Озеро",[dateEdit(value,evidence)]));
  const value=write.changes[0].value;
  const complete=vi.fn().mockResolvedValueOnce(proposal(value,"unsupported paraphrase"))
    .mockResolvedValueOnce(kind==='malformed repair'?{text:'{"evidence":[]}'}:proposal(value,kind==='different target'?'Море: 5 августа 2027 года.':kind==='ambiguous citation'?'августа 2027 года.':quote))
    .mockResolvedValue(proposal(fixed.changes[0].value,quote));
  const processor=new MemoryProcessor({complete,context:{assess:async()=>({tokens:30,limit:5000}),summarize:async()=>''}});
  const memory=new SessionMemory(f.store,processor,'gpt-4o-mini');
  const run=()=>memory.prepare([],[user(message)],'m',undefined,{id:'m',at:1,order:1});
  await expect(run()).rejects.toThrow(/evidence|proposal|ambiguous/);
  expect(complete).toHaveBeenCalledTimes(2);
  expect(f.read()).toEqual({revision:0,data:null});
  await run();await run();
  expect(f.read().data?.catalog?.cards).toHaveLength(1);
  expect(f.read().data?.catalog?.cards[0].changes).toHaveLength(1);
});

it("requires catalog lookup before an archived handle can enter an answer after Finish",async()=>{
  const f=fixture(),card={id:"archived",description:"Private trip",tags:["lake"],changes:[]};
  await f.store.save({revision:0,data:{catalog:{boundary:"finished",cards:[card]},summary:"",buffer:[],short:[],facts:[],covered:[],extracted:[]}});
  const complete=vi.fn().mockResolvedValue(wire(readTopic("archived")));
  const processor=new MemoryProcessor({complete,context:{assess:async()=>({tokens:10,limit:5000}),summarize:async()=>""}});
  await expect(new SessionMemory(f.store,processor,"gpt-4o-mini").prepare([],[user("Explain chess.")],"next",undefined,{id:"next",at:10,order:3})).rejects.toThrow(/archived catalog/);
  expect(complete).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(complete.mock.calls)).not.toContain(card.description);
  expect(f.read().revision).toBe(1);
});

it("permits a repaired existing handle only for the same resolved topic and field claim", async () => {
  const f = fixture();
  const card = {id:"lake", description:"Отдых на озере", tags:[], changes:[]};
  await f.store.save({revision:0,data:{catalog:{cards:[card]},covered:[],summary:"",facts:[],short:[],buffer:[],extracted:[]}});
  const complete = vi.fn()
    .mockResolvedValueOnce(wire(createTopic("Поездка на озеро",[],"Поездка на озеро",[dateEdit("2027-07-20","invalid quote")])))
    .mockResolvedValueOnce(wire({kind:"write",updates:[{target:{kind:"existing",card:"lake",mention:cite("Поездка на озеро")},edits:[dateEdit("2027-07-20","20 июля 2027 года")]}]}));
  const processor = new MemoryProcessor({complete,context:{assess:async()=>({tokens:50,limit:5000}),summarize:async()=>""}});
  await new SessionMemory(f.store,processor,"gpt-4o-mini").prepare([],[user("Поездка на озеро: 20 июля 2027 года.")],"m",undefined,{id:"m",at:2,order:2});
  expect(complete).toHaveBeenCalledTimes(2);
  expect(f.read().data?.catalog?.cards).toMatchObject([{id:"lake",changes:[{field:"date",value:"2027-07-20"}]}]);
});

it("v6 asks for repair of a nonexistent pending source and requires fresh grounding for the same edits", async () => {
  const {followup:q} = (await import("./test-fixtures/terra-v6-memory.json")).default;
  const f=fixture(), card={id:"lake",description:"Планирование отдыха на озере с друзьями",tags:["отдых","друзья"],changes:[]};
  await f.store.save({revision:0,data:{catalog:{cards:[card],active:card.id},covered:[],summary:"",facts:[],short:[],buffer:[],extracted:[]}});
  const complete=vi.fn().mockResolvedValueOnce({text:JSON.stringify(q.wrongSource)}).mockResolvedValueOnce({text:JSON.stringify(q.sourceRepair)});
  const processor=new MemoryProcessor({complete,context:{assess:async()=>({tokens:50,limit:5000}),summarize:async()=>""}});
  await new SessionMemory(f.store,processor,"gpt-5.6-terra").prepare([],[user(q.message)],"m",undefined,{id:"m",at:2,order:2});
  expect(complete).toHaveBeenCalledTimes(2);
  expect(f.read().data?.catalog?.cards).toMatchObject([{id:"lake",changes:[{value:"2027-07-20"},{value:["Сергей","Лена","Катя"]},{value:["Лена берёт термос."]}]}]);
});

describe("v8 abstentions",()=>{
  const abstain={kind:"abstain",reason:"No grounded changes."};
  async function replay(text:string, proposals:unknown[], pending=false) {
    const f=fixture();
    const catalog={cards:[{id:"lake",description:"Lake trip",tags:["lake"],changes:[]}],active:"lake",
      ...(pending?{pending:{text:"Move the date.",question:"Which trip?",intent:"write" as const,source:{id:"prior",at:1,order:1}}}:{})};
    await f.store.save({revision:0,data:{catalog,summary:"",covered:[],facts:[],buffer:[],short:[],extracted:[]}});
    const complete=vi.fn();
    for(const p of proposals) complete.mockResolvedValueOnce(wire(p));
    const memory=new SessionMemory(f.store,new MemoryProcessor({complete,context:{assess:async()=>({tokens:50,limit:5000}),summarize:async()=>""}}),"gpt-4o-mini");
    const before=f.read();
    return { f,before,run:()=>memory.prepare([],[user(text)],"msg",undefined,{id:"msg",at:2,order:2}) };
  }
  it("handles a standalone text exercise with an active card",async()=>{
    const r=await replay("Translate the passage: «Le ciel est bleu.»",[abstain]);
    const answer=await r.run();
    expect(answer.at(-1)?.content).toContain("Le ciel est bleu");
    expect(r.f.read().data?.catalog).toEqual(r.before.data?.catalog);
    expect(r.f.read().data?.facts).toEqual([]);
  });
  it.each([
    ["unsupported change","Move the lake trip tomorrow.",[abstain,abstain],false],
    ["mixed instructions","Read this passage. Now change the lake date.",[abstain,abstain],false],
    ["instruction after a quoted passage","Read the passage: «A clear sky.» Then change the trip.",[abstain,abstain],false],
    ["pending clarification","Read this passage: a clear sky.",[abstain,abstain],true],
    ["unverified write repaired to abstention","Read this passage: a clear sky.",[createTopic("Lake",[],"lake",[dateEdit("2027-08-01","fabricated")]),abstain],false],
    ["malformed write repaired to dialogue","Read this passage: a clear sky.",[{kind:"write",updates:"invalid"},{kind:"dialogue"}],false],
  ] as const)("rejects %s without a snapshot",async(_case,text,proposals,pending)=>{
    const r=await replay(text,[...proposals],pending);
    await expect(r.run()).rejects.toThrow();
    expect(r.f.read()).toEqual(r.before);
  });
});

it('uses the consolidated summary before deciding whether connected local recall needs clarification',async()=>{
  const f=fixture(), memory=new SessionMemory(f.store,f.processor,'gpt-4o-mini',75);
  const detail='Keep the review label amber.';
  vi.mocked(f.processor.compress).mockResolvedValue(detail);
  vi.mocked(f.processor.extract).mockImplementation(async (_messages,_meter,_id,topic)=>{
    if (!topic) return [];
    const known = JSON.parse(topic.context()).summary.includes(detail);
    const decision = known ? {kind:'recall' as const,quote:detail}
      : {kind:'clarify' as const,intent:'write' as const,question:'Which label?'};
    topic.decide(topic.map(topic.resolve(decision)));
    return [];
  });
  const group={id:'design',messages:[{role:'assistant' as const,content:detail+' notes'.repeat(200)}]};
  const question=user('Recall the earlier review label.');
  const messages=await memory.prepare([group],[question],'user-recall',undefined,
    {id:'user-recall',at:1,order:3},new Set(['design']),'local');
  expect(messages.filter(m=>m.content===question.content)).toHaveLength(1);
  expect(JSON.stringify(messages)).toContain(detail);
  expect(JSON.stringify(messages)).not.toContain('Which label?');
  expect(f.read().data?.catalog?.pending).toBeUndefined();
  expect(f.read().data?.covered).toEqual(['design']);
  expect(f.read().data?.facts).toEqual([]);
});

it('fits service memory by selecting whole relevant evidence and honors the Finish boundary',async()=>{
  const f=fixture(), memory=new SessionMemory(f.store,f.processor,'gpt-4o-mini');
  const fact={subject:'Cedar',attribute:'contrast',value:'amber',status:'confirmed' as const,sources:['source']};
  const relevant='Cedar requires keyboard navigation.';
  await f.store.save({revision:0,data:{catalog:{cards:[],boundary:'finished'},covered:[],short:[],buffer:[],extracted:[],
    summary:'Unrelated '.repeat(500)+'.\n'+relevant,facts:[fact]}});
  const groups=[{id:'finished',messages:[user('Private finished draft.')]},
    {id:'next',messages:[user('Cedar uses compact buttons.')]}];
  const fits=async(messages:ManagerLlmMessage[])=>JSON.stringify(messages).length<1800;
  const context=await memory.serviceContext(groups,'Continue the Cedar design',fits);
  expect(await fits(context)).toBe(true);
  const payload=JSON.stringify(context);
  for (const value of [relevant,'amber','compact buttons']) expect(payload).toContain(value);
  for (const value of ['Private finished draft','Unrelated']) expect(payload).not.toContain(value);
  expect(f.read().revision).toBe(1);
});
