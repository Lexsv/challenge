import { expect, it, vi } from 'vitest';
import { MemoryProcessor, mergeMemoryFacts } from './session-memory';

it('requests durable facts while distinguishing emotional expression and incidental activity', async () => {
  const examples = [
    {text:'I use Kotlin.', facts:[{subject:'user',attribute:'language',value:'Kotlin',evidence:'I use Kotlin.',status:'confirmed',correction:false}]},
    {text:'I am incredibly happy today!', facts:[]},
    {text:'I had coffee this morning.', facts:[]},
    {text:'I am thrilled! I prefer calm, structured technical explanations.', facts:[{subject:'user',attribute:'explanation preference',value:'calm, structured technical explanations',evidence:'I prefer calm, structured technical explanations.',status:'confirmed',correction:false}]},
  ];
  const complete=vi.fn(async ({messages}:{messages:readonly {content:string}[]})=>{
    const instruction=messages[0].content;
    expect(instruction).toContain('stable preferences');
    expect(instruction).toContain('temporary emotions');
    expect(instruction).toContain('incidental daily events');
    expect(instruction).toContain('Preserve durable preferences even when expressed emotionally');
    const match=examples.find(item=>messages[1].content.includes(item.text));
    if(!match) throw Error('Unexpected fixture');
    return {text:JSON.stringify({facts:match.facts})};
  });
  const processor=new MemoryProcessor({complete,context:{assess:async()=>({tokens:10,limit:10000}),summarize:async()=>''}});
  for(const example of examples){
    const facts=await processor.extract([{role:'user',content:example.text}],undefined,'source');
    expect(facts.map(fact=>fact.value)).toEqual(example.facts.map(fact=>fact.value));
  }
  expect(complete).toHaveBeenCalledTimes(4);
});

it('retains correction history when a durable fact changes',()=>{
  const existing={subject:'Project',attribute:'name',value:'Aurora',status:'confirmed' as const,sources:['old']};
  const updated={...existing,value:'Aurora Core',sources:['new'],correction:true};
  expect(mergeMemoryFacts([existing],[updated])).toMatchObject([{value:'Aurora Core',supersedes:[{value:'Aurora',sources:['old']}]}]);
});
