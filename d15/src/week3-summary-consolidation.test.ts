import { expect, it, vi } from 'vitest';
import { MemoryProcessor, SessionMemory, type MemorySnapshot } from './session-memory';
import type { ManagerLlmMessage } from './manager-agent';
import { estimateContextInput } from './token-meter';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionServer } from '../server/sessions.mjs';

const user=(content:string):ManagerLlmMessage=>({role:'user',content});
const group=(id:string,text:string)=>({id,messages:[user(text)]});

it('consolidates five cycles, retaining unrelated decisions and applying an explicit correction',async()=>{
  const outputs=[
    'Database: PostgreSQL. Constraint: no paid dependencies. Open question: launch date.',
    'Database: PostgreSQL. Constraint: no paid dependencies. Open question: launch date.',
    'Database: PostgreSQL. Constraint: no paid dependencies. Open question: launch date. Architecture: modular monolith.',
    'Database: MongoDB (replaces PostgreSQL). Constraint: no paid dependencies. Open question: launch date. Architecture: modular monolith.',
    'Database: MongoDB (replaces PostgreSQL). Constraint: no paid dependencies. Open question: launch date. Architecture: modular monolith.',
  ];
  const sources=['Select PostgreSQL. No paid dependencies. When is launch?','PostgreSQL is the database. Tea is pleasant.','Choose a modular monolith.','We explicitly replace PostgreSQL with MongoDB.','Use MongoDB; the tea discussion is no longer relevant.'];
  const reviews:Record<string,string>[]=[];let call=0;
  const processor=new MemoryProcessor({context:{assess:async()=>({tokens:100,limit:10000}),summarize:async()=>outputs[call++]},complete:async({messages})=>{reviews.push(JSON.parse(messages[1].content));return {text:'{"preserved":true}'};}});
  let summary='';const tokens:number[]=[];
  for(let i=0;i<sources.length;i++){summary=await processor.compress(summary,[group(`run-${i}`,sources[i])]);tokens.push((await estimateContextInput('gpt-4o-mini',summary)).estimatedInputTokens!);}
  expect(reviews).toHaveLength(5);expect(reviews[0].previousSummary).toBe('');expect(reviews[1].previousSummary).toBe(outputs[0]);expect(reviews[3].sourceChunk).toContain('replace PostgreSQL with MongoDB');
  expect(summary).toContain('MongoDB');expect(summary).toContain('no paid dependencies');expect(summary).toContain('launch date');expect(summary).toContain('modular monolith');expect(summary).not.toContain('tea');
  expect(tokens[1]).toBe(tokens[0]);expect(tokens[4]).toBe(tokens[3]);expect(Math.max(...tokens)).toBeLessThan(1024);
});

it('rejects a delta-only replacement and retains prior summary, coverage, and pending source',async()=>{
  let saved:MemorySnapshot={revision:0,data:{summary:'Earlier decision: PostgreSQL. Constraint: no paid dependencies. Open question: launch date.',facts:[],short:[],buffer:[],covered:['earlier'],extracted:[]}};
  const store={load:async()=>structuredClone(saved),save:async(value:MemorySnapshot)=>{if(value.revision!==saved.revision)throw Error('revision conflict');saved={revision:value.revision+1,data:structuredClone(value.data)};return structuredClone(saved);}};
  const processor=new MemoryProcessor({context:{assess:async()=>({tokens:100,limit:10000}),summarize:async()=> 'New backend: Python.'},complete:async()=>({text:'{"preserved":false}'})});
  const memory=new SessionMemory(store,processor,'gpt-4o-mini',60);
  const source=group('pending','Backend language is Python. '+ 'additional discussion '.repeat(100));
  await expect(memory.prepare([source],[user('Continue?')],'current')).rejects.toThrow('could not verify preservation');
  expect(saved.data?.summary).toContain('PostgreSQL');expect(saved.data?.covered).toEqual(['earlier']);expect(saved.data?.buffer.map(g=>g.id)).toEqual(['pending']);
});

it('rejects malformed or unavailable independent verification rather than accepting a short replacement',async()=>{
  for(const response of ['not json','{"preserved":false}']){
    const processor=new MemoryProcessor({context:{assess:async()=>({tokens:100,limit:10000}),summarize:async()=> 'Only the newest detail.'},complete:async()=>({text:response})});
    await expect(processor.compress('Previous important decision.',[group('one','New unrelated detail.')])).rejects.toThrow('Summary consolidation');
  }
});

it('rejects the observed long-to-delta collapse on repeated attempts and preserves the SQLite summary on restart',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'d11-summary-'));const path=join(dir,'summary.sqlite');
  let db=new DatabaseSync(path);db.exec('CREATE TABLE memory (revision INTEGER NOT NULL, data TEXT NOT NULL)');
  const previous='detail '.repeat(254), deltas=['detail '.repeat(28),'detail '.repeat(17)];
  expect(await Promise.all([previous,...deltas].map(async value=>(await estimateContextInput('gpt-4o-mini',value)).estimatedInputTokens))).toEqual([256,30,19]);
  const initial={summary:previous,facts:[],short:[],buffer:[],covered:['prior'],extracted:[]};
  db.prepare('INSERT INTO memory VALUES (?,?)').run(0,JSON.stringify(initial));
  const store={load:async()=>{const row=db.prepare('SELECT revision,data FROM memory').get() as {revision:number;data:string};return {revision:row.revision,data:JSON.parse(row.data)} as MemorySnapshot;},save:async(value:MemorySnapshot)=>{const result=db.prepare('UPDATE memory SET revision=revision+1,data=? WHERE revision=?').run(JSON.stringify(value.data),value.revision);if(!result.changes)throw Error('revision conflict');return {revision:value.revision+1,data:value.data};}};
  let count=0;const processor=new MemoryProcessor({context:{assess:async()=>({tokens:100,limit:10000}),summarize:async()=>deltas[count++]},complete:async()=>({text:'{"preserved":false}'})});
  try {
    const source=group('pending','New discussion. '.repeat(100));
    for(let i=0;i<2;i++)await expect(new SessionMemory(store,processor,'gpt-4o-mini',60).prepare([source],[user('Continue?')],`current-${i}`)).rejects.toThrow('could not verify preservation');
    db.close();db=new DatabaseSync(path);
    const restored=await store.load();expect(restored.data?.summary).toBe(previous);expect(restored.data?.covered).toEqual(['prior']);expect(restored.data?.buffer[0].id).toBe('pending');
  } finally {db.close();await rm(dir,{recursive:true,force:true});}
});

it('reviews a first summary and fails closed for rejection, malformed output and reviewer timeout',async()=>{
  for(const response of ['{"preserved":false}','invalid','timeout']) {
    const complete=vi.fn(async()=>{if(response==='timeout')throw Error('review timeout');return {text:response};});
    const processor=new MemoryProcessor({context:{assess:async()=>({tokens:10,limit:10000}),summarize:async()=> 'Proposed.'},complete});
    let snapshot:MemorySnapshot={revision:0,data:null};
    const store={load:async()=>structuredClone(snapshot),save:async(value:MemorySnapshot)=>{snapshot={revision:value.revision+1,data:structuredClone(value.data)};return structuredClone(snapshot);}};
    await expect(new SessionMemory(store,processor,'gpt-4o-mini',60).prepare([group('pending','context '.repeat(120))],[user('Continue?')],'next')).rejects.toThrow();
    expect(complete).toHaveBeenCalledTimes(1);expect(snapshot.data?.summary).toBe('');expect(snapshot.data?.covered).toEqual([]);expect(snapshot.data?.buffer[0].id).toBe('pending');
  }
});

it.each([true,false])('reviews overflow recompression and applies the reviewer decision %s',async accepted=>{
  const complete=vi.fn(async()=>({text:JSON.stringify({preserved:accepted})}));
  const processor=new MemoryProcessor({context:{assess:async()=>({tokens:10,limit:10000}),summarize:async()=> 'Decision: PostgreSQL. Open: launch date.'},complete});
  let snapshot:MemorySnapshot={revision:0,data:{summary:'Decision: PostgreSQL. Open: launch date. '.repeat(50),facts:[],short:[],buffer:[],covered:['old'],extracted:[]}};
  const store={load:async()=>structuredClone(snapshot),save:async(value:MemorySnapshot)=>{snapshot={revision:value.revision+1,data:structuredClone(value.data)};return structuredClone(snapshot);}};
  const original=snapshot.data!.summary;const recovery=new SessionMemory(store,processor,'gpt-4o-mini').recover([user('Continue?')]);
  if(accepted){await recovery;expect(snapshot.data?.summary).toBe('Decision: PostgreSQL. Open: launch date.');}else{await expect(recovery).rejects.toThrow('could not verify preservation');expect(snapshot.data?.summary).toBe(original);}
  expect(complete).toHaveBeenCalledTimes(1);expect(snapshot.data?.covered).toEqual(['old']);
});

it('reserves reviewer capacity and reduces source before making summary requests',async()=>{
  const chunks:string[]=[];const reviews:string[]=[];
  const processor=new MemoryProcessor({context:{assess:async messages=>({tokens:messages[0].content.startsWith('Review a proposed') ? 1100+JSON.parse(messages[1].content).sourceChunk.length : 100,limit:2200}),summarize:async text=>{chunks.push(JSON.parse(text.slice(text.indexOf('{'))).sourceChunk);return 'Condensed.';}},complete:async({messages})=>{reviews.push(messages[1].content);return {text:'{"preserved":true}'};}});
  await processor.compress('',[group('long','abcdefgh '.repeat(60))]);
  expect(chunks.length).toBeGreaterThan(1);expect(chunks.every(chunk=>chunk.length<=76 && chunk.length>0)).toBe(true);expect(reviews).toHaveLength(chunks.length);
});

it('stops before summarization if the minimum chunk cannot fit and rejects an oversized actual review',async()=>{
  const summarize=vi.fn(async()=> 'Proposed.');
  const noRoom=new MemoryProcessor({context:{assess:async()=>({tokens:100,limit:1000}),summarize},complete:async()=>({text:'{"preserved":true}'})});
  await expect(noRoom.compress('old',[group('one','text')])).rejects.toThrow('safely reviewable');expect(summarize).not.toHaveBeenCalled();
  const noReview=new MemoryProcessor({context:{assess:async messages=>({tokens:messages[0].content.startsWith('Review a proposed') && JSON.parse(messages[1].content).proposedSummary ? 20000 : 10,limit:10000}),summarize},complete:async()=>({text:'{"preserved":true}'})});
  await expect(noReview.compress('old',[group('one','text')])).rejects.toThrow('Cannot verify summary consolidation');
});

it('does not overwrite a concurrent revision after a reviewed consolidation',async()=>{
  let snapshot:MemorySnapshot={revision:0,data:{summary:'Old decision.',facts:[],short:[],buffer:[],covered:[],extracted:[]}};
  let writes=0;const store={load:async()=>structuredClone(snapshot),save:async(value:MemorySnapshot)=>{if(++writes===2)throw Error('revision conflict');snapshot={revision:value.revision+1,data:structuredClone(value.data)};return structuredClone(snapshot);}};
  const processor=new MemoryProcessor({context:{assess:async()=>({tokens:10,limit:10000}),summarize:async()=> 'Old decision and new context.'},complete:async({messages})=>({text:messages[0].content.startsWith('Review a proposed')?'{"preserved":true}':'{"facts":[]}'})});
  await expect(new SessionMemory(store,processor,'gpt-4o-mini',60).prepare([group('pending','context '.repeat(120))],[user('Next?')],'next')).rejects.toThrow('revision conflict');
  expect(snapshot.data?.summary).toBe('Old decision.');expect(snapshot.data?.covered).toEqual([]);expect(snapshot.data?.buffer[0].id).toBe('pending');
});

it('restores the pending buffer through the Week 3 SQLite API after a rejected review',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'d11-summary-api-'));const path=join(dir,'test.sqlite');let server:ReturnType<typeof createSessionServer>|undefined;let base='';
  const start=async()=>{server=createSessionServer(path);await new Promise<void>(resolve=>server!.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address || typeof address==='string')throw Error('No port');base=`http://127.0.0.1:${address.port}/api/week3/sessions`;};
  const stop=()=>new Promise<void>((resolve,reject)=>server!.close(error=>error?reject(error):resolve()));
  try {
    await start();const session=await(await fetch(base,{method:'POST'})).json();
    const store={load:async()=>await(await fetch(`${base}/${session.id}/memory`)).json() as MemorySnapshot,save:async(value:MemorySnapshot)=>{const response=await fetch(`${base}/${session.id}/memory`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});if(!response.ok)throw Error(`Save ${response.status}`);return await response.json() as MemorySnapshot;}};
    const processor=new MemoryProcessor({context:{assess:async()=>({tokens:10,limit:10000}),summarize:async()=> 'Incomplete.'},complete:async()=>({text:'{"preserved":false}'})});
    await expect(new SessionMemory(store,processor,'gpt-4o-mini',60).prepare([group('pending','context '.repeat(120))],[user('Next?')],'next')).rejects.toThrow('could not verify preservation');
    await stop();await start();const restored=await store.load();expect(restored.data?.summary).toBe('');expect(restored.data?.covered).toEqual([]);expect(restored.data?.buffer[0].id).toBe('pending');
  } finally {if(server?.listening)await stop();await rm(dir,{recursive:true,force:true});}
});
