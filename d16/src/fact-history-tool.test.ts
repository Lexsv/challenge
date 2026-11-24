import { expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionServer } from '../server/sessions.mjs';
import { createFactHistoryTool } from './fact-history-tool';
import { ManagerAgent, createManagerConversation, type ManagerLlmAdapter, type ManagerLlmMessage } from './manager-agent';
import { ContextBuilder, SessionMemory, type MemoryFact, type MemorySnapshot } from './session-memory';
import { createBuiltInToolRegistry } from './tool-runtime';
import { estimateContextInput } from './token-meter';

const facts:MemoryFact[]=[{subject:'Project',attribute:'deadline',value:'December 2',status:'confirmed',sources:['private-source'],supersedes:[{value:'November 20',status:'confirmed',sources:['old-source']},{value:'November 28',status:'confirmed',sources:['old-source-2']}]},{subject:'Other project',attribute:'deadline',value:'January 1',status:'confirmed',sources:['unrelated']}];
const memory=(items:MemoryFact[])=>({facts:async()=>structuredClone(items)}) as SessionMemory;

it('returns only the matching current and historical values without provenance',async()=>{
  const tool=createFactHistoryTool(memory(facts));const output=await tool.execute({subject:'project',attribute:'deadline'});
  expect(output).toEqual({status:'ok',subject:'Project',attribute:'deadline',current:{value:'December 2',status:'confirmed'},unorderedValues:[{value:'November 20',status:'confirmed'},{value:'November 28',status:'confirmed'}],chronology:'unknown'});
  expect(JSON.stringify(output)).not.toMatch(/private-source|old-source|Other project|January 1/);
  expect((await estimateContextInput('gpt-4o-mini',output)).estimatedInputTokens).toBeGreaterThan(0);
  expect(facts[0].sources).toEqual(['private-source']);
});
it('handles missing, empty, ambiguous, invalid and unavailable memory safely',async()=>{
  const tool=createFactHistoryTool(memory(facts));
  expect(await tool.execute({subject:'Missing',attribute:'deadline'})).toMatchObject({status:'not_found'});
  expect(await tool.execute({subject:'Other project',attribute:'deadline'})).toMatchObject({status:'ok',unorderedValues:[],chronology:'unknown'});
  expect(await createFactHistoryTool(memory([...facts,{...facts[0],value:'December 3'}])).execute({subject:'Project',attribute:'deadline'})).toMatchObject({status:'ambiguous'});
  expect(tool.validate({subject:'Project',attribute:'deadline',sessionId:'other'}).ok).toBe(false);
  await expect(createFactHistoryTool({facts:async()=>{throw Error('sensitive storage detail');}} as unknown as SessionMemory).execute({subject:'Project',attribute:'deadline'})).rejects.toThrow('Fact history is unavailable.');
});

it.each([true,false])('uses the shared Manager tool loop for a mocked history selection: %s',async useTool=>{
  const requests:{messages:readonly ManagerLlmMessage[];tools:readonly {id:string}[]}[]=[];
  const snapshot={covered:[],short:[],buffer:[],summary:'',facts,extracted:[]};
  const bound={facts:async()=>structuredClone(facts),prepare:async(_groups:unknown,current:ManagerLlmMessage[])=>new ContextBuilder().build(snapshot,current)} as unknown as SessionMemory;
  const adapter:ManagerLlmAdapter={complete:async request=>{requests.push(request);if(useTool && requests.length===1)return {toolCalls:[{id:'call-1',toolId:'get_fact_history',arguments:{subject:'Project',attribute:'deadline'}}]};return {text:'Acknowledged.'};}};
  const registry=createBuiltInToolRegistry();const run=await new ManagerAgent(adapter,registry).run({state:createManagerConversation(),userText:useTool?'What was the previous deadline?':'What is the current deadline?',sessionMemory:bound});
  expect(run.run.status).toBe('completed');expect(requests[0].tools.some(tool=>tool.id==='get_fact_history')).toBe(true);expect(registry.get('get_fact_history')).toBeUndefined();
  expect(JSON.stringify(requests[0].messages)).not.toMatch(/November 20|old-source/);
  expect(run.state.toolExecutions).toHaveLength(useTool?1:0);
  if(useTool){expect(run.state.toolExecutions[0].output).toMatchObject({unorderedValues:[{value:'November 20'},{value:'November 28'}],chronology:'unknown'});expect(requests).toHaveLength(1);expect(run.finalResponse).toContain('chronological order cannot be verified');}
});

it('returns a sanitized tool error to the Manager and continues the run',async()=>{
  const requests:ManagerLlmMessage[][]=[];
  const bound={facts:async()=>{throw Error('private database path');},prepare:async(_groups:unknown,current:ManagerLlmMessage[])=>current} as unknown as SessionMemory;
  const adapter:ManagerLlmAdapter={complete:async({messages})=>{requests.push([...messages]);return requests.length===1?{toolCalls:[{id:'failed-call',toolId:'get_fact_history',arguments:{subject:'Project',attribute:'deadline'}}]}:{text:'History is unavailable.'};}};
  const result=await new ManagerAgent(adapter,createBuiltInToolRegistry()).run({state:createManagerConversation(),userText:'What was the previous deadline?',sessionMemory:bound});
  expect(result.run.status).toBe('completed');expect(result.state.toolExecutions[0].status).toBe('failed');expect(result.finalResponse).toContain('Fact history is unavailable');expect(result.finalResponse).not.toContain('private database path');expect(requests).toHaveLength(1);
});

it.each(['What was the original deadline?','What was the previous deadline?','How did the deadline change over time?'])('does not infer chronology from reversed history: %s',async question=>{
  const reversed:MemoryFact={subject:'Project',attribute:'deadline',value:'December 12',status:'confirmed',sources:['current'],supersedes:[{value:'December 5',status:'confirmed',sources:['second']},{value:'November 20',status:'confirmed',sources:['first']}]};
  const saved=structuredClone(reversed);
  const tool=createFactHistoryTool(memory([reversed]));const result=await tool.execute({subject:'Project',attribute:'deadline'});
  expect(result).toMatchObject({chronology:'unknown',unorderedValues:expect.arrayContaining([{value:'December 5',status:'confirmed'},{value:'November 20',status:'confirmed'}])});
  const bound={facts:async()=>[reversed],prepare:async(_groups:unknown,current:ManagerLlmMessage[])=>current} as unknown as SessionMemory;
  const complete=vi.fn(async()=>({text:'The original was December 5.',toolCalls:[{id:'one',toolId:'get_fact_history',arguments:{subject:'Project',attribute:'deadline'}}]}));
  const run=await new ManagerAgent({complete},createBuiltInToolRegistry()).run({state:createManagerConversation(),userText:question,sessionMemory:bound});
  expect(run.finalResponse).toContain('chronological order cannot be verified');expect(run.finalResponse).toContain('November 20');expect(run.finalResponse).toContain('December 5');expect(run.finalResponse).not.toContain('original was');
  expect(run.state.messages.some(message=>message.text.includes('original was'))).toBe(false);expect(complete).toHaveBeenCalledTimes(1);expect(reversed).toEqual(saved);
});

it('loads the requested session only and restores history from Week 3 SQLite after restart',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'d11-fact-tool-'));const path=join(dir,'db.sqlite');let server:ReturnType<typeof createSessionServer>|undefined;let base='';
  const start=async()=>{server=createSessionServer(path);await new Promise<void>(resolve=>server!.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address || typeof address==='string')throw Error('No port');base=`http://127.0.0.1:${address.port}/api/week3/sessions`;};
  const stop=()=>new Promise<void>((resolve,reject)=>server!.close(error=>error?reject(error):resolve()));
  try {
    await start();const a=await(await fetch(base,{method:'POST'})).json(),b=await(await fetch(base,{method:'POST'})).json();
    const store=(id:string)=>({load:async()=>await(await fetch(`${base}/${id}/memory`)).json() as MemorySnapshot,save:async(value:MemorySnapshot)=>{const response=await fetch(`${base}/${id}/memory`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});if(!response.ok)throw Error('save failed');return await response.json() as MemorySnapshot;}});
    const data={covered:[],short:[],buffer:[],summary:'',facts,extracted:[]};await store(a.id).save({revision:0,data});await store(b.id).save({revision:0,data:{...data,facts:[{...facts[0],value:'March 3',supersedes:[]}]}});
    await stop();await start();const loadA=store(a.id);const processor={} as never;const tool=createFactHistoryTool(new SessionMemory(loadA,processor,'gpt-4o-mini'));const before=await loadA.load();
    expect(await tool.execute({subject:'Project',attribute:'deadline'})).toMatchObject({current:{value:'December 2'},unorderedValues:[{value:'November 20'},{value:'November 28'}],chronology:'unknown'});
    expect(await loadA.load()).toEqual(before);
    expect(await createFactHistoryTool(new SessionMemory(store(b.id),processor,'gpt-4o-mini')).execute({subject:'Project',attribute:'deadline'})).toMatchObject({current:{value:'March 3'},unorderedValues:[],chronology:'unknown'});
  } finally {if(server?.listening)await stop();await rm(dir,{recursive:true,force:true});}
});
