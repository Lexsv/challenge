import { expect, it } from 'vitest';
import { ContextBuilder, factContextText, mergeMemoryFacts, type MemoryData } from './session-memory';
import { estimateMemoryTokenStats } from './memory-token-stats';
import { estimateContextInput } from './token-meter';

it('projects merged facts without mutating provenance or hiding conflicts and uncertainty',async()=>{
  const data:MemoryData={covered:[],short:[],buffer:[],extracted:[],summary:'',facts:[
    {subject:'Atlas',attribute:'database',value:'MongoDB',status:'confirmed',sources:['secret-source'],correction:true,supersedes:[{value:'PostgreSQL',status:'confirmed',sources:['historical-id']}]},
    {subject:'Atlas',attribute:'database',value:'MySQL',status:'assumed',sources:['another-source']},
  ]};
  const original=structuredClone(data);const messages=new ContextBuilder().build(data,[{role:'user',content:'What is the database?'}]);
  const text=messages.find(message=>message.content.startsWith('Session facts extracted'))!.content;
  expect(text).toBe(factContextText(data.facts));
  expect(JSON.parse(text.slice(text.indexOf('\n')+1))).toEqual([
    {subject:'Atlas',attribute:'database',value:'MongoDB',status:'confirmed'},
    {subject:'Atlas',attribute:'database',value:'MySQL',status:'assumed'},
  ]);
  expect(text).not.toMatch(/secret-source|another-source|historical-id|PostgreSQL|correction|supersedes|sources/);
  expect(data).toEqual(original);
  expect((await estimateMemoryTokenStats(data,'gpt-4o-mini')).longTermTokens).toBe((await estimateContextInput('gpt-4o-mini',text)).estimatedInputTokens);
});

it('does not inflate the answer context when confirmed sources accumulate',async()=>{
  const initial={subject:'Atlas',attribute:'database',value:'PostgreSQL',status:'confirmed' as const,sources:['initial']};
  const repeated=mergeMemoryFacts([initial],Array.from({length:100},(_,i)=>({...initial,sources:[`source-${i}`]})));
  expect(repeated[0].sources).toHaveLength(101);
  expect(factContextText(repeated)).toBe(factContextText([initial]));
  expect(repeated[0].status).toBe('confirmed');
});
