import type { HistoryEvent } from './conversation-history';
import type { TopicCandidate, TopicRecord } from './topic-memory';
import type { SemanticRecommendation } from './semantic-assessor';
import { parseSemanticRecommendation } from './semantic-assessor.ts';
import { topicSourcesFromArchive } from './topic-memory.ts';
import { validateTopicAssessment, type SemanticAssessment } from './topic-semantic.ts';

export type AssessmentMapperInput = {
  sessionId:string;
  events:readonly HistoryEvent[];
  candidate:TopicCandidate;
  recommendation:SemanticRecommendation;
  assessment?:SemanticAssessment;
  existingTopics:readonly (TopicRecord & {revision:number})[];
};
/** A proposal is not an authorization: the lifecycle must validate it again against current state. */
export type AssessmentMapping =
  | {decision:'proposal';candidate:TopicCandidate;assessment:SemanticAssessment;targetKey?:string}
  | {decision:'no-mutation';reason:'skip'|'duplicate'}
  | {decision:'reject'|'defer';reason:string};

const reject=(reason:string):AssessmentMapping=>({decision:'reject',reason});
const defer=(reason:string):AssessmentMapping=>({decision:'defer',reason});
const asciiKey=(key:string)=>key.replace(/[A-Z]/g,char=>char.toLowerCase());

/** Isolated mapping only. The caller must supply trusted archive events and current topic records. */
export function mapTopicAssessment(input:AssessmentMapperInput):AssessmentMapping {
  const candidate=input?.candidate;
  if(!candidate || typeof candidate.key!=='string' || !candidate.key.trim() || typeof candidate.value!=='string' || !candidate.value.trim() || !['confirmed','uncertain','rejected'].includes(candidate.status) || !Array.isArray(candidate.sources) || !Array.isArray(candidate.evidence) || !candidate.assessment || !['unverified','supported'].includes(candidate.assessment.support) || !['unverified','confirmed'].includes(candidate.assessment.change))return reject('Invalid candidate.');
  if(!Array.isArray(input.events) || !Array.isArray(input.existingTopics) || typeof input.sessionId!=='string')return reject('Invalid mapping input.');
  let context;try{context=topicSourcesFromArchive(input.sessionId,input.events);}catch{return reject('Invalid session archive.');}
  let encoded:string;try{encoded=JSON.stringify(input.recommendation);}catch{return reject('Invalid recommendation.');}
  const checked=parseSemanticRecommendation({candidate:candidate.value,existingTopics:input.existingTopics,context},encoded);
  if(!checked.ok)return reject('Invalid recommendation or topic catalog.');
  const recommendation=checked.recommendation;
  if(recommendation.action==='SKIP')return {decision:'no-mutation',reason:'skip'};
  if(recommendation.action==='DUPLICATE')return {decision:'no-mutation',reason:'duplicate'};
  if(recommendation.proposedContent!==candidate.value)return defer('Proposed content differs from extracted evidence; a separately supported candidate is required.');
  const current=recommendation.action==='UPDATE'?input.existingTopics.find(topic=>topic.key===recommendation.targetKey):undefined;
  if(recommendation.action==='ADD' && input.existingTopics.some(topic=>asciiKey(topic.key)===asciiKey(candidate.key)))return defer('A topic with this key already exists.');
  if(recommendation.action==='UPDATE' && (!current || candidate.key!==current.key))return defer('Candidate and target topic identities differ.');
  const assessment=input.assessment;
  if(!assessment || !Array.isArray(assessment.evidence) || typeof assessment.factSupported!=='boolean' || typeof assessment.changeConfirmed!=='boolean' || !['fact','proposal','change','correction','cancellation','ambiguous','noise'].includes(assessment.classification))return defer('Evidence-aware semantic assessment is required.');
  let validation;try{validation=validateTopicAssessment(input.sessionId,input.events,candidate,assessment,current);}catch{return reject('Invalid candidate evidence or session archive.');}
  if(validation.decision!=='accept')return validation;
  if(recommendation.action==='UPDATE' && validation.update.action!=='change')return defer('An update requires an evidence-backed confirmed change.');
  return {decision:'proposal',candidate:structuredClone(candidate),assessment:structuredClone(assessment),...(current?{targetKey:current.key}:{})};
}
