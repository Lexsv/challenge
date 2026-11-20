import { expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionServer } from '../server/sessions.mjs';
import { MemoryProcessor, SessionMemory, type MemorySnapshot } from './session-memory';
import type { ManagerLlmMessage } from './manager-agent';
import { ManagerAgent, createManagerConversation } from './manager-agent';
import { createBuiltInToolRegistry } from './tool-runtime';

type Action='update'|'confirm'|'contradiction'|'clarify'|'none';
function provider(extracted: unknown[], action: Action, value: string | null, evidence: string | null) {
  const requests: ManagerLlmMessage[][]=[];
  const adapter={context:{assess:async()=>({tokens:100,limit:10000}),summarize:async()=>''},complete:vi.fn(async({messages}:{messages:readonly ManagerLlmMessage[]})=>{
    requests.push([...messages]);
    return {text:messages[0].content.startsWith('Compare the current') ? JSON.stringify({action,target:action==='update'?0:null,value,evidence}) : JSON.stringify({facts:extracted})};
  })};
  return {processor:new MemoryProcessor(adapter),requests};
}
function fact(subject:string,attribute:string,value:string,evidence:string,correction=false){return {subject,attribute,value,evidence,correction,status:'confirmed'};}
function fixture(){let snapshot:MemorySnapshot={revision:0,data:null};return {store:{load:async()=>structuredClone(snapshot),save:async(value:MemorySnapshot)=>{if(value.revision!==snapshot.revision)throw Error('revision conflict');snapshot={revision:value.revision+1,data:structuredClone(value.data)};return structuredClone(snapshot);}},read:()=>snapshot};}
const user=(content:string):ManagerLlmMessage=>({role:'user',content});

it('recovers an empty clarification extraction using the recent question and an indexed existing identity',async()=>{
  const f=fixture();const initial=provider([fact('Alex','deadline','November 25, 2026',"Alex's deadline is November 25, 2026."),fact('Mark','deadline','November 28, 2026',"Mark's deadline is November 28, 2026.")],'none',null,null);
  const memory=new SessionMemory(f.store,initial.processor,'gpt-4o-mini');
  const source="Alex's deadline is November 25, 2026. Mark's deadline is November 28, 2026.";
  await memory.prepare([],[user(source)],'initial');
  const clarification='Mark. His deadline is now November 30, 2026.';
  const recovered=provider([],'update','November 30, 2026','His deadline is now November 30, 2026.');
  const next=new SessionMemory(f.store,recovered.processor,'gpt-4o-mini');
  await next.prepare([{id:'prior',messages:[user('Alex discussed the project with Mark. He decided to postpone the deadline.'),{role:'assistant',content:'Who decided to postpone the deadline, Alex or Mark?'}]}],[user(clarification)],'clarification');
  const data=await next.facts();expect(data.find(fact=>fact.subject==='Alex')?.value).toBe('November 25, 2026');
  expect(data.find(fact=>fact.subject==='Mark')).toMatchObject({value:'November 30, 2026',sources:['clarification'],supersedes:[{value:'November 28, 2026',sources:['initial']}]});
  const prompt=JSON.parse(recovered.requests[1][1].content);expect(prompt.recent.at(-1).content).toContain('Who decided');expect(prompt.current).toBe(clarification);
});

it.each(['has changed','We moved','has been revised'])('reconciles wording %s and alternate semantic keys without duplicates',async wording=>{
  const f=fixture(),initialText="Mark's project deadline is November 28, 2026.";
  const initial=provider([fact('Mark','project deadline','November 28, 2026',initialText)],'none',null,null);
  await new SessionMemory(f.store,initial.processor,'gpt-4o-mini').prepare([],[user(initialText)],'old');
  const text=wording==='We moved'?"We moved Mark's project deadline to December 2, 2026.":`Mark's project deadline ${wording} to December 2, 2026.`;
  const update=provider([fact("Mark's project",'deadline','December 2, 2026',text,false)],'update','December 2, 2026',text);
  const memory=new SessionMemory(f.store,update.processor,'gpt-4o-mini');
  await memory.prepare([],[user(text)],'new');await memory.prepare([],[user(text)],'repeat');
  const facts=await memory.facts();expect(facts).toHaveLength(1);expect(facts[0]).toMatchObject({subject:'Mark',attribute:'project deadline',value:'December 2, 2026',sources:['new','repeat'],supersedes:[{value:'November 28, 2026',sources:['old']}]});
});

it('keeps a conflicting claim distinct and refuses to apply an ambiguous update',async()=>{
  const f=fixture(),text="Mark's deadline is November 28, 2026.";
  await new SessionMemory(f.store,provider([fact('Mark','deadline','November 28, 2026',text)],'none',null,null).processor,'gpt-4o-mini').prepare([],[user(text)],'old');
  const conflict="Another schedule says Mark's deadline is November 30, 2026.";
  const p=provider([fact('Mark','deadline','November 30, 2026',conflict,true)],'contradiction',null,null);
  const memory=new SessionMemory(f.store,p.processor,'gpt-4o-mini');await memory.prepare([],[user(conflict)],'other');
  expect((await memory.facts()).map(fact=>fact.value)).toEqual(['November 28, 2026','November 30, 2026']);
  const ambiguous='Alex spoke to Mark. His deadline might now be December 2, 2026.';
  const candidate=provider([],'update','December 2, 2026',ambiguous);
  await new SessionMemory(f.store,candidate.processor,'gpt-4o-mini').prepare([],[user(ambiguous)],'ambiguous');
  expect((await memory.facts()).some(fact=>fact.value==='December 2, 2026')).toBe(false);
});
it('does not mark the source processed when reconciliation output is invalid',async()=>{
  const f=fixture(),text="Mark's deadline is November 28, 2026.";
  await new SessionMemory(f.store,provider([fact('Mark','deadline','November 28, 2026',text)],'none',null,null).processor,'gpt-4o-mini').prepare([],[user(text)],'old');
  const bad=new MemoryProcessor({context:{assess:async()=>({tokens:10,limit:10000}),summarize:async()=>''},complete:vi.fn(async({messages}:{messages:readonly ManagerLlmMessage[]})=>({text:messages[0].content.startsWith('Compare the current')?'not json':'{"facts":[]}'}))});
  await expect(new SessionMemory(f.store,bad,'gpt-4o-mini').prepare([],[user('Mark. His deadline is now November 30, 2026.')],'retry')).rejects.toThrow('invalid JSON');
  expect(f.read().data?.extracted).not.toContain('retry');expect(f.read().data?.facts[0].value).toBe('November 28, 2026');
});

it('persists the complete sequential version chain in SQLite across restart',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'d11-reconcile-'));let server:ReturnType<typeof createSessionServer>|undefined;let base='';
  const start=async()=>{server=createSessionServer(join(dir,'db.sqlite'));await new Promise<void>(resolve=>server!.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address || typeof address==='string')throw Error('No port');base=`http://127.0.0.1:${address.port}/api/week3/sessions`;};
  const stop=()=>new Promise<void>((resolve,reject)=>server!.close(error=>error?reject(error):resolve()));
  try {await start();const session=await(await fetch(base,{method:'POST'})).json();
    const store={load:async()=>await(await fetch(`${base}/${session.id}/memory`)).json() as MemorySnapshot,save:async(value:MemorySnapshot)=>{const response=await fetch(`${base}/${session.id}/memory`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});if(!response.ok)throw Error(`Save ${response.status}`);return await response.json() as MemorySnapshot;}};
    const first="Mark's deadline is November 28, 2026.";await new SessionMemory(store,provider([fact('Mark','deadline','November 28, 2026',first)],'none',null,null).processor,'gpt-4o-mini').prepare([],[user(first)],'s1');
    for(const [id,value] of [['s2','November 30, 2026'],['s3','December 2, 2026']]){const text=`Mark. His deadline is now ${value}.`;await new SessionMemory(store,provider([],'update',value,text).processor,'gpt-4o-mini').prepare([],[user(text)],id);}
    await stop();await start();const saved=await store.load();expect(saved.data?.facts).toMatchObject([{subject:'Mark',value:'December 2, 2026',sources:['s3'],supersedes:[{value:'November 28, 2026',sources:['s1']},{value:'November 30, 2026',sources:['s2']}]}]);
  }finally{if(server?.listening)await stop();await rm(dir,{recursive:true,force:true});}
});
it('routes a real Manager run through empty extraction and structured reconciliation',async()=>{
  const f=fixture(),first="Mark's deadline is November 28, 2026.";
  await new SessionMemory(f.store,provider([fact('Mark','deadline','November 28, 2026',first)],'none',null,null).processor,'gpt-4o-mini').prepare([],[user(first)],'old');
  const text='Mark. His deadline is now November 30, 2026.';
  const p=provider([],'update','November 30, 2026',text),memory=new SessionMemory(f.store,p.processor,'gpt-4o-mini');
  const manager=new ManagerAgent({complete:async()=>({text:'Noted.'})},createBuiltInToolRegistry());
  const result=await manager.run({state:createManagerConversation(),userText:text,sessionMemory:memory});
  expect(result.run.status).toBe('completed');expect((await memory.facts())[0]).toMatchObject({value:'November 30, 2026',supersedes:[{value:'November 28, 2026',sources:['old']}]});
  expect(p.requests).toHaveLength(2);
});
