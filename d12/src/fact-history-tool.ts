import type { SessionMemory } from './session-memory';
import type { ExecutableTool } from './tool-runtime';

type HistoryArgs = { subject:string; attribute:string };

/** Bound to the run's session memory; callers cannot choose a session. */
export function createFactHistoryTool(memory: SessionMemory): ExecutableTool<HistoryArgs, unknown> {
  return {
    id:'get_fact_history', name:'get_fact_history', executionType:'function',
    description:'Read previous values and corrections for a remembered fact in this session. Use for questions about history or changes, not ordinary current-value questions. If history is missing or ambiguous, acknowledge that limitation.',
    inputSchema:{type:'object',properties:{subject:{type:'string',description:'Exact fact subject from current memory.'},attribute:{type:'string',description:'Exact fact attribute from current memory.'}},required:['subject','attribute'],additionalProperties:false},
    validate(args) {
      if(!args || typeof args!=='object' || Array.isArray(args))return {ok:false,code:'invalid_arguments',message:'Expected subject and attribute.'};
      const value=args as Record<string,unknown>;
      if(Object.keys(value).some(key=>key!=='subject' && key!=='attribute') || typeof value.subject!=='string' || !value.subject.trim() || typeof value.attribute!=='string' || !value.attribute.trim())return {ok:false,code:'invalid_arguments',message:'Provide only a non-empty subject and attribute.'};
      return {ok:true,value:{subject:value.subject.trim(),attribute:value.attribute.trim()}};
    },
    async execute(args) {
      let facts;
      try { facts=await memory.facts(); } catch { throw new Error('Fact history is unavailable. Please try again.'); }
      const normalize=(value:string)=>value.trim().toLocaleLowerCase();
      const matches=facts.filter(fact=>normalize(fact.subject)===normalize(args.subject) && normalize(fact.attribute)===normalize(args.attribute));
      if(!matches.length)return {status:'not_found',message:'No matching fact is available in this session.'};
      if(matches.length>1)return {status:'ambiguous',message:'Multiple current records match; clarify the fact before using its history.'};
      const fact=matches[0];
      const unorderedValues=(fact.supersedes ?? []).map(({value,status})=>({value,status})).sort((a,b)=>a.value.localeCompare(b.value) || a.status.localeCompare(b.status));
      return {status:'ok',subject:fact.subject,attribute:fact.attribute,current:{value:fact.value,status:fact.status},chronology:'unknown',unorderedValues};
    },
  };
}
