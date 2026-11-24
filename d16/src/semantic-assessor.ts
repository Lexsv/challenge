import type { TopicCatalogEntry } from './topic-lifecycle';
import type { TopicSource } from './topic-memory';

/** Inputs are supplied by the caller; this interface does not establish their provenance. */
export type SemanticAssessorInput = {
  candidate:string;
  existingTopics:readonly TopicCatalogEntry[];
  context:readonly TopicSource[];
};

/** JSON response: exactly one recommendation for the supplied candidate.
 * ADD: {action,proposedContent,reason}; UPDATE: {action,targetKey,proposedContent,reason};
 * DUPLICATE: {action,targetKey,reason}; SKIP: {action,reason}.
 * targetKey must exactly match a supplied topic key. Recommendations are not authorization to write.
 */
export type SemanticRecommendation =
  | {action:'ADD';proposedContent:string;reason:string}
  | {action:'UPDATE';targetKey:string;proposedContent:string;reason:string}
  | {action:'DUPLICATE';targetKey:string;reason:string}
  | {action:'SKIP';reason:string};

export type SemanticAssessorError = {code:'INVALID_INPUT'|'INVALID_JSON'|'INVALID_RESPONSE'|'INVALID_TARGET'|'EXECUTION_FAILED';field?:string};
export type SemanticAssessorResult = {ok:true;recommendation:SemanticRecommendation}|{ok:false;error:SemanticAssessorError};
export interface SemanticAssessor { assess(input:SemanticAssessorInput):Promise<SemanticAssessorResult> }

const fail=(code:SemanticAssessorError['code'],field?:string):SemanticAssessorResult=>({ok:false,error:{code,...(field?{field}:{})}});
const nonempty=(value:unknown):value is string=>typeof value==='string' && !!value.trim();
const validInput=(input:SemanticAssessorInput):SemanticAssessorResult|undefined=>{
  if(!input || !nonempty(input.candidate) || !Array.isArray(input.existingTopics) || !Array.isArray(input.context))return fail('INVALID_INPUT','input');
  // SQLite NOCASE folds ASCII characters only, including when it enforces topic-key uniqueness.
  const keys=input.existingTopics.map(topic=>typeof topic?.key==='string'?topic.key.replace(/[A-Z]/g,(char:string)=>char.toLowerCase()):undefined);
  if(input.existingTopics.some(topic=>!topic || !nonempty(topic.key) || !nonempty(topic.value) || !['confirmed','uncertain','rejected'].includes(topic.status) || !Number.isSafeInteger(topic.revision) || topic.revision<1) || new Set(keys).size!==keys.length)return fail('INVALID_INPUT','existingTopics');
  if(input.context.some(source=>!source || !nonempty(source.id) || !['user','assistant'].includes(source.role) || !Number.isSafeInteger(source.sequence) || source.sequence<1 || !nonempty(source.content)))return fail('INVALID_INPUT','context');
};

/** Pure validation: malformed responses produce no recommendation and never mutate memory. */
export function parseSemanticRecommendation(input:SemanticAssessorInput,json:string):SemanticAssessorResult {
  const error=validInput(input);if(error)return error;
  let raw:unknown;try{raw=JSON.parse(json);}catch{return fail('INVALID_JSON');}
  if(!raw || typeof raw!=='object' || Array.isArray(raw))return fail('INVALID_RESPONSE');
  const value=raw as Record<string,unknown>;
  if(!['ADD','UPDATE','DUPLICATE','SKIP'].includes(value.action as string))return fail('INVALID_RESPONSE','action');
  if(!nonempty(value.reason))return fail('INVALID_RESPONSE','reason');
  const action=value.action as SemanticRecommendation['action'];
  const needsTarget=action==='UPDATE' || action==='DUPLICATE';
  const needsContent=action==='ADD' || action==='UPDATE';
  const allowed=new Set(['action','reason',...(needsTarget?['targetKey']:[]),...(needsContent?['proposedContent']:[])]);
  if(Object.keys(value).some(key=>!allowed.has(key)))return fail('INVALID_RESPONSE');
  if(needsTarget && (!nonempty(value.targetKey) || !input.existingTopics.some(topic=>topic.key===value.targetKey)))return fail('INVALID_TARGET','targetKey');
  if(needsContent && !nonempty(value.proposedContent))return fail('INVALID_RESPONSE','proposedContent');
  return {ok:true,recommendation:value as SemanticRecommendation};
}

/** Adapter for a future response producer. It receives a copy and errors are deliberately sanitized. */
export function createSemanticAssessor(produce:(input:SemanticAssessorInput)=>Promise<string>):SemanticAssessor {
  return {async assess(input){
    const error=validInput(input);if(error)return error;
    try{return parseSemanticRecommendation(input,await produce(structuredClone(input)));}catch{return fail('EXECUTION_FAILED');}
  }};
}
