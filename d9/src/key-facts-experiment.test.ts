import { expect, it } from 'vitest';
import { createManagerConversation, ManagerAgent, type ManagerLlmAdapter } from './manager-agent';
import { ToolRegistry } from './tool-runtime';
import { estimateContextInput } from './token-meter';
import type { FactStore } from './key-facts-context';

it('compares three strategies on a fixed dialogue with a deterministic mock model',async()=>{
 const key = ['Mira','December 12','12000 dollars','no weekends','use a pilot'];
 const state=createManagerConversation(),tools=new ToolRegistry();
 const seed=new ManagerAgent({complete:async()=>({text:'Acknowledged.'})},tools);
 for(const text of [
  'The lead is Mira.', 'The deadline is December 12.', 'The budget is 12000 dollars.',
  'The constraint is no weekends.', 'The decision is use a pilot.',
  'Status update alpha.', 'Status update beta.', 'Status update gamma.', 'Status update delta.', 'Status update epsilon.',
 ]) await seed.run({state,userText:text});
 const outputs:Record<string,{answerInput:number,total:number,recall:boolean[]}>={};
 for(const mode of ['full','budget','facts'] as const){
  let answerInput=0,total=0;
  const recall:boolean[]=[];
  const count=async(value:unknown)=>(await estimateContextInput('gpt-4o-mini',value)).estimatedInputTokens!;
  const complete:ManagerLlmAdapter['complete']=async({messages})=>{
   const extract=messages[0]?.content.startsWith('Extract only facts');
   const source=messages.map(m=>m.content).join('\n');
   const asked=Number(messages.at(-1)?.content.match(/Question (\d)/)?.[1] ?? -1);
   const text=extract ? JSON.stringify({facts:key.filter(value=>source.includes(value)).map(value=>({subject:'Project',attribute:`fact ${key.indexOf(value)}`,value}))})
    : (source.includes(key[asked]) ? key[asked] : 'Unknown');
   const input=await count({model:'gpt-4o-mini',messages});
   if(!extract)answerInput+=input;
   total+=input+await count(text);
   return {text:text || 'No facts found.'};
  };
  const adapter:ManagerLlmAdapter={complete,...(mode==='full'?{}:{context:{assess:async messages=>({tokens:await count({model:'gpt-4o-mini',messages}),limit:10000,target:mode==='budget'?150:0}),summarize:async()=>{throw Error('No summaries');}}})};
  for(const [index, question] of ['Who is the lead?','What is the deadline?','What is the budget?','What is the constraint?','What was decided?'].entries()) {
   let saved:Awaited<ReturnType<FactStore['load']>>={facts:[],coveredMessageId:null};
   const store:FactStore={recentMessages:10,load:async()=>saved,save:async value=>{saved={facts:value.facts,coveredMessageId:value.coveredMessageId};}};
   const result=await new ManagerAgent(adapter,tools).run({state:structuredClone(state),userText:`Question ${index}: ${question}`,...(mode==='facts'?{keyFacts:store}:{})});
   expect(result.error).toBeUndefined();recall.push(result.finalResponse===key[index]);
  }
  outputs[mode]={answerInput,total,recall};
 }
 expect(outputs.full.recall).toEqual([true,true,true,true,true]);
 expect(outputs.facts.recall).toEqual([true,true,true,true,true]);
 console.info('Mock experiment (local token estimates, including output and extraction):',JSON.stringify(outputs));
});
