import { expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionServer } from '../server/sessions.mjs';
import { MemoryProcessor, SessionMemory, mergeMemoryFacts, type MemorySnapshot } from './session-memory';
import { ManagerAgent, createManagerConversation, type ManagerLlmMessage } from './manager-agent';
import { createBuiltInToolRegistry } from './tool-runtime';

const statement="Alex's deadline is November 25, 2026. Mark's deadline is November 28, 2026.";
const ambiguous='Alex discussed the project with Mark. He decided to postpone the deadline.';
const clarification='Mark. His deadline is now November 30, 2026.';
const record=(subject:string,value:string,evidence:string,correction=false)=>({subject,attribute:'deadline',value,status:'confirmed',correction,evidence});
const extractionAdapter=(records:unknown[])=>({context:{assess:async()=>({tokens:100,limit:10000}),summarize:async()=>''},complete:vi.fn(async({messages}:{messages:readonly ManagerLlmMessage[]})=>{
  if(messages[0].content.startsWith('Compare the current')){const data=JSON.parse(messages[1].content) as {current:string};const value=(records[0] as {value?:string} | undefined)?.value;return {text:JSON.stringify(value && data.current.includes(value)?{action:'update',target:0,value,evidence:data.current}:{action:'none',target:null,value:null,evidence:null})};}
  return {text:JSON.stringify({facts:records})};
})});

it('extracts each person’s deadline and rejects a swapped association',async()=>{
  const processor=new MemoryProcessor(extractionAdapter([record('Alex','November 25, 2026',statement),record('Mark','November 28, 2026',statement),record('Alex','November 28, 2026',statement)]));
  const facts=await processor.extract([{role:'user',content:statement}],undefined,'source-1');
  expect(facts.map(f=>[f.subject,f.value])).toEqual([['Alex','November 25, 2026'],['Mark','November 28, 2026']]);
});
it('does not assign the ambiguous pronoun, even if extraction guesses a subject',async()=>{
  const processor=new MemoryProcessor(extractionAdapter([record('Mark','postpone',ambiguous,true)]));
  for(let attempt=0;attempt<3;attempt++)expect(await processor.extract([{role:'user',content:ambiguous}],undefined,`source-${attempt}`)).toEqual([]);
});
it('does not infer a correction from an ambiguous or uncertain current statement',async()=>{
  const input='Alex discussed the project with Mark. His deadline might now be November 30.';
  const processor=new MemoryProcessor(extractionAdapter([record('Mark','November 30',input,false)]));
  const facts=await processor.extract([{role:'user',content:input}],undefined,'ambiguous');
  expect(facts.every(f=>!f.correction && f.status!=='confirmed')).toBe(true);
});
it('repairs existing parallel confirmed records only after an explicit repeated correction',()=>{
  const old={subject:'Mark',attribute:'deadline',value:'November 28, 2026',status:'confirmed' as const,sources:['old']};
  const current={...old,value:'November 30, 2026',sources:['new']};
  expect(mergeMemoryFacts([old,current],[{...current,correction:false}])).toHaveLength(2);
  const repaired=mergeMemoryFacts([old,current],[{...current,correction:true,sources:['repeat']}]);
  expect(repaired).toHaveLength(1);expect(repaired[0]).toMatchObject({value:'November 30, 2026',sources:['new','repeat'],supersedes:[{value:'November 28, 2026',sources:['old']}]});
});
it('sends the Manager both associations and the clarification policy, without forcing clarification for a named subject',async()=>{
  const calls:ManagerLlmMessage[][]=[];let snapshot:MemorySnapshot={revision:0,data:null};
  const store={load:async()=>structuredClone(snapshot),save:async(value:MemorySnapshot)=>snapshot={revision:value.revision+1,data:structuredClone(value.data)}};
  const processor=new MemoryProcessor(extractionAdapter([]));vi.spyOn(processor,'extract').mockResolvedValue([]);vi.spyOn(processor,'reconcileUpdate').mockResolvedValue({action:'none'});
  const memory=new SessionMemory(store,processor,'gpt-4o-mini');
  await memory.putFact({subject:'Alex',attribute:'deadline',value:'November 25',status:'confirmed',sources:['a']});
  await memory.putFact({subject:'Mark',attribute:'deadline',value:'November 28',status:'confirmed',sources:['b']});
  const adapter={complete:vi.fn(async({messages}:{messages:readonly ManagerLlmMessage[]})=>{calls.push([...messages]);return {text:calls.length===1?"Mark's deadline is November 28.":'Who decided to postpone the deadline, Alex or Mark?'};})};
  const manager=new ManagerAgent(adapter,createBuiltInToolRegistry()),state=createManagerConversation();
  expect((await manager.run({state,userText:"What is Mark's deadline?",sessionMemory:memory})).finalResponse).toContain('November 28');
  expect((await manager.run({state,userText:ambiguous,sessionMemory:memory})).finalResponse).toContain('Alex or Mark');
  expect(JSON.stringify(calls[0])).toContain('November 25');expect(JSON.stringify(calls[0])).toContain('November 28');
  expect(JSON.stringify(calls[1])).toContain('ask a concise clarification');
});
it('persists the clarified correction and both source histories across SQLite restart',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'d11-ambiguity-'));let server:ReturnType<typeof createSessionServer>|undefined;let base='';
  const start=async()=>{server=createSessionServer(join(dir,'test.sqlite'));await new Promise<void>(resolve=>server!.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address || typeof address==='string')throw Error('No port');base=`http://127.0.0.1:${address.port}/api/week3/sessions`;};
  const stop=()=>new Promise<void>((resolve,reject)=>server!.close(error=>error?reject(error):resolve()));
  try{
    await start();const session=await(await fetch(base,{method:'POST'})).json();
    const store={load:async()=>await(await fetch(`${base}/${session.id}/memory`)).json() as MemorySnapshot,save:async(value:MemorySnapshot)=>{const response=await fetch(`${base}/${session.id}/memory`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});if(!response.ok)throw Error(`Save ${response.status}`);return await response.json() as MemorySnapshot;}};
    // Live QA captured correction:false despite the explicit update in the source.
    const extract=new MemoryProcessor(extractionAdapter([record('Mark','November 30, 2026','His deadline is now November 30, 2026.',false)]));const memory=new SessionMemory(store,extract,'gpt-4o-mini');
    const alex="Alex's deadline is November 25, 2026.",markOriginal="Mark's deadline is November 28, 2026.";
    const initialAlex=await new MemoryProcessor(extractionAdapter([record('Alex','November 25, 2026',alex)])).extract([{role:'user',content:alex}],undefined,'original-alex');
    const initialMark=await new MemoryProcessor(extractionAdapter([record('Mark','November 28, 2026',markOriginal)])).extract([{role:'user',content:markOriginal}],undefined,'original-mark');
    for(const fact of [...initialAlex,...initialMark])await memory.putFact(fact);
    await memory.prepare([],[{role:'user',content:clarification}],'clarification');
    expect((await memory.facts()).find(f=>f.subject==='Mark')).toMatchObject({value:'November 30, 2026',supersedes:[{value:'November 28, 2026',sources:['original-mark']}]});
    await memory.prepare([],[{role:'user',content:clarification}],'repeat');
    const second='Mark. His deadline is now December 2, 2026.';
    const nextMemory=new SessionMemory(store,new MemoryProcessor(extractionAdapter([record('Mark','December 2, 2026',second,false)])),'gpt-4o-mini');
    await nextMemory.prepare([],[{role:'user',content:second}],'second-correction');
    await stop();await start();const restored=await memory.facts();
    expect(restored.find(f=>f.subject==='Alex')).toMatchObject({value:'November 25, 2026',sources:['original-alex']});
    const mark=restored.filter(f=>f.subject==='Mark');expect(mark).toHaveLength(1);
    expect(mark[0]).toMatchObject({value:'December 2, 2026',sources:['second-correction'],supersedes:[{value:'November 28, 2026',sources:['original-mark']},{value:'November 30, 2026',sources:['clarification','repeat']}]});
  }finally{if(server?.listening)await stop();await rm(dir,{recursive:true,force:true});}
});
