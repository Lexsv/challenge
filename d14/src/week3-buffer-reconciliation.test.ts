import { expect, it } from 'vitest';
import { ContextBuilder, MemoryProcessor, SessionMemory, type MemorySnapshot } from './session-memory';
import type { ManagerLlmMessage } from './manager-agent';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionServer } from '../server/sessions.mjs';

const user=(content:string):ManagerLlmMessage=>({role:'user',content});

it.each(['immediate','buffered'] as const)('reconciles %s corrections without changing another project',async mode=>{
  let snapshot:MemorySnapshot={revision:0,data:null};
  const store={load:async()=>structuredClone(snapshot),save:async(next:MemorySnapshot)=>{if(next.revision!==snapshot.revision)throw Error('revision conflict');snapshot={revision:next.revision+1,data:structuredClone(next.data)};return structuredClone(snapshot);}};
  const adapter={context:{assess:async()=>({tokens:10,limit:10000}),summarize:async()=> 'Summary.'},complete:async({messages}:{messages:readonly ManagerLlmMessage[]})=>{
    if(messages[0].content.startsWith('Review a proposed'))return {text:'{"preserved":true}'};
    if(messages[0].content.startsWith('Compare the current')){
      const input=JSON.parse(messages[1].content) as {current:string;existing:{subject:string;attribute:string}[]};
      const target=input.existing.findIndex(f=>f.subject==='Atlas AI' && f.attribute==='database');
      const update=input.current.includes('replaced');
      return {text:JSON.stringify({action:input.current.includes('might')?'clarify':update?'update':'confirm',target:update?target:null,value:update?'MongoDB':null,evidence:update?input.current:null})};
    }
    const [message]=JSON.parse(messages[1].content) as ManagerLlmMessage[];
    const text=message.content;
    if(text==='Next question?') return {text:'{"facts":[]}'};
    const subject=text.includes('Beta AI')?'Beta AI':'Atlas AI';
    const value=text.includes('MongoDB')?'MongoDB':text.includes('MySQL')?'MySQL':'PostgreSQL';
    return {text:JSON.stringify({facts:[{subject,attribute:'database',value,evidence:text,status:text.includes('might')?'assumed':'confirmed',correction:text.includes('replaced')}]})};
  }};
  const memory=new SessionMemory(store,new MemoryProcessor(adapter),'gpt-4o-mini',80);
  const first='Atlas AI database is PostgreSQL.';
  await memory.prepare([],[user(first)],'atlas-original');
  await memory.prepare([],[user('Beta AI database is MySQL.')],'beta-original');
  const change='Atlas AI database has been replaced with MongoDB.';
  if(mode==='immediate') await memory.prepare([],[user(change)],'atlas-update');
  else {
    // The earlier run failed before extraction; its saved message is later compacted.
    const group={id:'interrupted-run',sourceIds:['atlas-update'],messages:[user(change),{role:'assistant' as const,content:'Long dialogue '.repeat(40)}]};
    await memory.prepare([group],[user('Next question?')],'next');
    expect(snapshot.data?.covered).toContain('interrupted-run');
    expect(snapshot.data?.extracted).toContain('atlas-update');
  }
  await memory.prepare([],[user(change)],'atlas-repeat');
  await memory.prepare([],[user('Atlas AI database might be PostgreSQL.')],'ambiguous');
  const restored=new SessionMemory(store,new MemoryProcessor(adapter),'gpt-4o-mini',80);
  const facts=await restored.facts();
  expect(facts.filter(f=>f.subject==='Atlas AI' && f.status==='confirmed')).toEqual([
    expect.objectContaining({attribute:'database',value:'MongoDB',sources:['atlas-update','atlas-repeat'],supersedes:[expect.objectContaining({value:'PostgreSQL',sources:['atlas-original']})]}),
  ]);
  expect(facts).toContainEqual(expect.objectContaining({subject:'Beta AI',attribute:'database',value:'MySQL',sources:['beta-original']}));
});

it('persists a buffered correction and its original source across a SQLite restart',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'d11-buffer-'));const path=join(dir,'test.sqlite');
  let server:ReturnType<typeof createSessionServer>|undefined;let base='';
  const start=async()=>{server=createSessionServer(path);await new Promise<void>(resolve=>server!.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address || typeof address==='string')throw Error('No port');base=`http://127.0.0.1:${address.port}/api/week3/sessions`;};
  const stop=()=>new Promise<void>((resolve,reject)=>server!.close(error=>error?reject(error):resolve()));
  try {
    await start();const session=await(await fetch(base,{method:'POST'})).json();
    const store={load:async()=>await(await fetch(`${base}/${session.id}/memory`)).json() as MemorySnapshot,save:async(value:MemorySnapshot)=>{const response=await fetch(`${base}/${session.id}/memory`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});if(!response.ok)throw Error(`Save ${response.status}`);return await response.json() as MemorySnapshot;}};
    const adapter={context:{assess:async()=>({tokens:10,limit:10000}),summarize:async()=> 'Summary.'},complete:async({messages}:{messages:readonly ManagerLlmMessage[]})=>{
      if(messages[0].content.startsWith('Review a proposed'))return {text:'{"preserved":true}'};
      if(messages[0].content.startsWith('Compare the current')){const input=JSON.parse(messages[1].content) as {current:string};return {text:JSON.stringify({action:'update',target:0,value:'MongoDB',evidence:input.current})};}
      const [message]=JSON.parse(messages[1].content) as ManagerLlmMessage[];const text=message.content;
      if(text==='Next question?')return {text:'{"facts":[]}'};
      return {text:JSON.stringify({facts:[{subject:'Atlas AI',attribute:'database',value:text.includes('MongoDB')?'MongoDB':'PostgreSQL',evidence:text,status:'confirmed',correction:text.includes('replaced')}]})};
    }};
    const memory=new SessionMemory(store,new MemoryProcessor(adapter),'gpt-4o-mini',80);
    await memory.prepare([],[user('Atlas AI database is PostgreSQL.')],'original');
    const change='Atlas AI database has been replaced with MongoDB.';
    await memory.prepare([{id:'failed-run',sourceIds:['update'],messages:[user(change),{role:'assistant',content:'Long dialogue '.repeat(40)}]}],[user('Next question?')],'next');
    await stop();await start();
    const restored=await store.load();
    expect(restored.data?.facts).toEqual([expect.objectContaining({subject:'Atlas AI',attribute:'database',value:'MongoDB',sources:['update'],supersedes:[expect.objectContaining({value:'PostgreSQL',sources:['original']})]})]);
    const context=new ContextBuilder().build(restored.data!,[user('What is current?')]);expect(JSON.stringify(context)).toContain('MongoDB');expect(JSON.stringify(context)).not.toContain('PostgreSQL');
    expect(restored.data?.extracted).toContain('update');expect(restored.data?.covered).toContain('failed-run');
  } finally {if(server?.listening)await stop();await rm(dir,{recursive:true,force:true});}
});
