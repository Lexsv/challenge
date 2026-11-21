import type { ManagerLlmAdapter } from './manager-agent';
import { estimateContextInput } from './token-meter.ts';

/** Deterministic QA adapter. It never performs network requests. */
export function createDevManagerMock(model:string, summaryFailure:()=>Promise<boolean> = async()=>false):ManagerLlmAdapter {
  return {
    context:{
      assess:async(messages,tools)=>({tokens:(await estimateContextInput(model,{messages,tools})).estimatedInputTokens,limit:32000,modelInputBudget:32000}),
      summarize:async()=> { if(await summaryFailure())throw new Error('Synthetic summary failure.'); return 'Synthetic QA summary: the conversation contains test messages.'; },
    },
    complete:async({messages,memoryProposal})=>{
      if(memoryProposal) return {text:'{"version":1,"facts":[],"topic":{"kind":"dialogue"}}'};
      const instruction=messages[0]?.content ?? '';
      if(instruction.startsWith('Extract facts from'))return {text:'{"facts":[]}'};
      if(instruction.startsWith('Review a proposed'))return {text:'{"preserved":true}'};
      if(instruction.startsWith('Compare the current'))return {text:'{"action":"none","target":null,"value":null,"evidence":null}'};
      return {text:'Acknowledged.'};
    },
  };
}
