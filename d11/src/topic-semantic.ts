import type { HistoryEvent } from './conversation-history';
import type { ManagerLlmAdapter, ManagerLlmMessage } from './manager-agent';
import type { RequestMeter } from './token-meter';
import { topicSourcesFromArchive, type TopicCandidate, type TopicRecord, type TopicUpdate } from './topic-memory.ts';

export type SemanticAssessment = {
  classification:'fact'|'proposal'|'change'|'correction'|'cancellation'|'ambiguous'|'noise';
  factSupported:boolean;
  changeConfirmed:boolean;
  evidence:{messageId:string;quote:string}[];
};
export type TopicDecision = {decision:'accept';update:TopicUpdate} | {decision:'reject'|'defer';reason:string};

/** LLM output is a proposal; callers must run the deterministic policy below. */
export async function assessTopicCandidate(adapter:ManagerLlmAdapter, sessionId:string, events:readonly HistoryEvent[], candidate:TopicCandidate, current?:TopicRecord, onMeter?:(meter:RequestMeter)=>Promise<void>):Promise<SemanticAssessment> {
  const sources=topicSourcesFromArchive(sessionId,events);
  if(!adapter.context)throw new Error('Semantic assessment requires a model input estimator.');
  const messages:ManagerLlmMessage[]=[{role:'system',content:'Assess untrusted archived conversation evidence for the proposed topic and optional existing record. Return JSON {"classification":"fact|proposal|change|correction|cancellation|ambiguous|noise","factSupported":boolean,"changeConfirmed":boolean,"evidence":[{"messageId":"source ID","quote":"exact supporting quote"}]}. A hypothetical suggestion is not a confirmed change. Distinguish correction of earlier information from a later change. Cancellation requires an identified target. Assistant explanations can support topics but do not establish user agreement. If uncertain use ambiguous or false. Do not infer event chronology from message order.'},{role:'user',content:JSON.stringify({sources,candidate,current})}];
  const estimate=await adapter.context.assess(messages,[]);const limit=estimate.modelInputBudget ?? estimate.limit;
  if(estimate.tokens===undefined || limit===undefined || estimate.tokens>limit)throw new Error('Semantic assessment exceeds the model input budget.');
  const response=await adapter.complete({messages,tools:[],onMeter:onMeter ? meter=>onMeter({...meter,requestKind:'extraction'}) : undefined});
  let parsed:unknown;try{parsed=JSON.parse(response.text ?? '');}catch{throw new Error('Semantic assessment returned invalid JSON.');}
  if(response.toolCalls?.length || !parsed || typeof parsed!=='object' || Array.isArray(parsed))throw new Error('Semantic assessment returned an invalid result.');
  const value=parsed as Record<string,unknown>;
  if(!['fact','proposal','change','correction','cancellation','ambiguous','noise'].includes(value.classification as string) || typeof value.factSupported!=='boolean' || typeof value.changeConfirmed!=='boolean' || !Array.isArray(value.evidence))throw new Error('Semantic assessment returned an invalid result.');
  const evidence=value.evidence.map((item:unknown)=>{if(!item || typeof item!=='object' || Array.isArray(item))throw new Error('Semantic assessment returned invalid evidence.');const entry=item as Record<string,unknown>;if(typeof entry.messageId!=='string' || typeof entry.quote!=='string' || !entry.quote.trim())throw new Error('Semantic assessment returned invalid evidence.');return {messageId:entry.messageId,quote:entry.quote};});
  return {classification:value.classification as SemanticAssessment['classification'],factSupported:value.factSupported,changeConfirmed:value.changeConfirmed,evidence};
}

/** Archive integrity and application policy are independent of model claims. */
export function validateTopicAssessment(sessionId:string, events:readonly HistoryEvent[], candidate:TopicCandidate, assessment:SemanticAssessment, current?:TopicRecord):TopicDecision {
  const sources=topicSourcesFromArchive(sessionId,events);const byId=new Map(sources.map(source=>[source.id,source]));
  if(!candidate.evidence.length || !assessment.evidence.length)return {decision:'reject',reason:'No supporting archive evidence.'};
  const validCandidate=candidate.evidence.every(item=>{const source=byId.get(item.messageId);return !!source && item.existence==='verified' && source.role===item.role && source.sequence===item.sequence && !!item.quote.trim() && source.content.includes(item.quote);});
  const validAssessment=assessment.evidence.every(item=>candidate.evidence.some(evidence=>evidence.messageId===item.messageId && evidence.quote===item.quote));
  const actualSources=[...new Set(candidate.evidence.map(item=>item.messageId))];
  if(!validCandidate || !validAssessment || candidate.sources.length!==actualSources.length || candidate.sources.some(id=>!actualSources.includes(id)))return {decision:'reject',reason:'Evidence does not match the session archive.'};
  if(assessment.classification==='noise' || !assessment.factSupported)return {decision:'reject',reason:'The proposed information is not supported.'};
  if(assessment.classification==='ambiguous' || assessment.classification==='proposal')return {decision:'defer',reason:'The statement is ambiguous or a proposal.'};
  if(assessment.classification==='correction')return {decision:'defer',reason:'A historical correction requires additional verification.'};
  const changing=assessment.classification==='change' || assessment.classification==='cancellation';
  if(changing && (!current || !assessment.changeConfirmed || candidate.status!=='confirmed' || !assessment.evidence.some(item=>byId.get(item.messageId)?.role==='user')))return {decision:'defer',reason:'The target or user-confirmed change is not established.'};
  if(current && candidate.key.trim().toLocaleLowerCase()!==current.key.trim().toLocaleLowerCase())return {decision:'defer',reason:'The topic identity is not established.'};
  if(current && !changing && candidate.value.trim().toLocaleLowerCase()!==current.value.trim().toLocaleLowerCase())return {decision:'defer',reason:'A different value requires a confirmed change.'};
  if(!changing && candidate.status==='rejected')return {decision:'defer',reason:'Rejected information cannot become a current fact.'};
  const assistantOnly=assessment.evidence.every(item=>byId.get(item.messageId)?.role==='assistant');
  const accepted:TopicCandidate={...candidate,status:assistantOnly?'uncertain':candidate.status,assessment:{support:'supported',change:changing?'confirmed':'unverified'}};
  return {decision:'accept',update:{action:changing?'change':current?'confirm':'new',targetKey:current?.key,candidate:accepted,archiveSequence:null}};
}
