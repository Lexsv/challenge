import { expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { estimateMemoryTokenStats, type MemoryTokenCache } from './memory-token-stats';
import { estimateContextInput } from './token-meter';
import { SessionMemoryCard } from './session-memory-card';
import { factContextText, type MemoryData } from './session-memory';

const data:MemoryData={covered:[],extracted:[],buffer:[],short:[{id:'run',messages:[{role:'user',content:'Hello'},{role:'assistant',content:'Hi'}]}],summary:'First decision.',facts:[{subject:'Project',attribute:'date',value:'Friday',status:'confirmed',sources:['a'],supersedes:[{value:'Monday',status:'confirmed',sources:['old']}]},{subject:'Project',attribute:'budget',value:'20',status:'assumed',sources:['b']}]};

it('reports genuine empty layers as zero without calling the estimator',async()=>{
  const estimate=vi.fn();expect(await estimateMemoryTokenStats(null,'gpt-4o-mini',{},estimate)).toEqual({shortTermTokens:0,mediumTermTokens:0,longTermTokens:0,storedLongTermTokens:0});expect(estimate).not.toHaveBeenCalled();
});
it('counts stored content with the shared estimator and excludes superseded versions',async()=>{
  const stats=await estimateMemoryTokenStats(data,'gpt-4o-mini');
  expect(stats).toEqual({shortTermTokens:(await estimateContextInput('gpt-4o-mini',data.short.flatMap(group=>group.messages))).estimatedInputTokens,mediumTermTokens:(await estimateContextInput('gpt-4o-mini',data.summary)).estimatedInputTokens,longTermTokens:(await estimateContextInput('gpt-4o-mini',factContextText(data.facts))).estimatedInputTokens,storedLongTermTokens:(await estimateContextInput('gpt-4o-mini',data.facts)).estimatedInputTokens});
  const changed=structuredClone(data);changed.facts[0].supersedes![0].value='A much longer obsolete historical value that must not count';
  expect((await estimateMemoryTokenStats(changed,'gpt-4o-mini')).longTermTokens).toBe(stats.longTermTokens);
  expect((await estimateMemoryTokenStats(changed,'gpt-4o-mini')).storedLongTermTokens).not.toBe(stats.storedLongTermTokens);
});
it('reuses unchanged layer counts and recounts an updated summary only',async()=>{
  const cache:MemoryTokenCache={};const estimate=vi.fn(async (_model:string,body:unknown)=>({estimatedInputTokens:JSON.stringify(body).length}));
  const first=await estimateMemoryTokenStats(data,'model',cache,estimate);await estimateMemoryTokenStats(structuredClone(data),'model',cache,estimate);expect(estimate).toHaveBeenCalledTimes(4);
  const changed={...data,summary:'A revised and longer summary.'};const second=await estimateMemoryTokenStats(changed,'model',cache,estimate);
  expect(estimate).toHaveBeenCalledTimes(5);expect(second.mediumTermTokens).not.toBe(first.mediumTermTokens);expect(second.shortTermTokens).toBe(first.shortTermTokens);expect(second.longTermTokens).toBe(first.longTermTokens);
});
it('distinguishes unavailable estimates from empty layers and permits retry',async()=>{
  const cache:MemoryTokenCache={};const estimate=vi.fn(async (_model:string,body:unknown)=>{if(body===data.summary)throw Error('unavailable');return {estimatedInputTokens:12};});
  const result=await estimateMemoryTokenStats(data,'model',cache,estimate);expect(result).toEqual({shortTermTokens:12,mediumTermTokens:null,longTermTokens:12,storedLongTermTokens:12});
  await estimateMemoryTokenStats(data,'model',cache,estimate);expect(estimate).toHaveBeenCalledTimes(5);
  const empty={...data,summary:'',facts:[]};expect(await estimateMemoryTokenStats(empty,'model',cache,estimate)).toEqual({shortTermTokens:12,mediumTermTokens:0,longTermTokens:0,storedLongTermTokens:0});
});
it('passes the same local estimates to the UI and renders their sum',async()=>{
  const stats=await estimateMemoryTokenStats(data,'gpt-4o-mini');const total=stats.shortTermTokens!+stats.mediumTermTokens!+stats.longTermTokens!;
  const html=renderToStaticMarkup(<SessionMemoryCard snapshot={{revision:1,data}} shortTokens={stats.shortTermTokens ?? undefined} summaryTokens={stats.mediumTermTokens ?? undefined} factTokens={stats.longTermTokens ?? undefined} />);
  expect(html).toContain(`>${total.toLocaleString('en-US')}<`);expect(html).not.toContain('Distribution unavailable');expect((html.match(/stroke-dasharray/g) ?? [])).toHaveLength(3);
});
