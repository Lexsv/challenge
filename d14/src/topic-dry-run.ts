import type { HistoryEvent } from './conversation-history';
import type { TopicCandidate, TopicRecord } from './topic-memory';
import { topicSourcesFromArchive } from './topic-memory.ts';
import type { TopicCatalogEntry, TopicSegmentRepository } from './topic-lifecycle';
import type { SemanticAssessor, SemanticRecommendation } from './semantic-assessor';
import type { SemanticAssessment } from './topic-semantic';
import { validateTopicAssessment } from './topic-semantic.ts';
import { mapTopicAssessment } from './assessment-mapper.ts';

type CurrentTopic=TopicRecord & {revision:number};
export type DryRunCandidate = {
  candidateKey:string;
  recommendedAction:SemanticRecommendation['action']|null;
  mapping:'proposal'|'no-mutation'|'defer'|'reject'|'failure';
  // This is the final explicit validator pass; the mapper may already have validated rejected/deferred candidates.
  validation:'accept'|'not-run';
  reason?:string;
};
export type TopicDryRunResult = {
  segmentId:string|null;
  status:'completed'|'failed';
  candidates:DryRunCandidate[];
  failure?:'archive'|'extraction'|'catalog'|'assessment'|'stale';
};
type ReadRepository=Pick<TopicSegmentRepository,'segment'|'catalog'>;
export type TopicDryRunDependencies = {
  repository:ReadRepository;
  extract:(sessionId:string,events:readonly HistoryEvent[])=>Promise<TopicCandidate[]>;
  assessor:SemanticAssessor;
  assessEvidence:(sessionId:string,events:readonly HistoryEvent[],candidate:TopicCandidate,current?:TopicRecord)=>Promise<SemanticAssessment>;
};

// Catalog projections deliberately carry no provenance: only key/value/status are used by the existing validator.
function currentTopic(entry:TopicCatalogEntry):CurrentTopic {
  return {...entry,sources:[],archiveSequence:null,history:[]};
}
async function catalog(repository:ReadRepository,sessionId:string):Promise<TopicCatalogEntry[]> {
  const entries:TopicCatalogEntry[]=[];let after:string|undefined;const cursors=new Set<string>();
  for(let pageNumber=0;pageNumber<100;pageNumber++){
    const page=await repository.catalog(sessionId,after===undefined?{}:{after});
    if(!page || !Array.isArray(page.topics) || !(page.nextCursor===null || typeof page.nextCursor==='string'))throw Error('Invalid catalog page.');
    entries.push(...page.topics);
    if(page.nextCursor===null)return entries;
    if(!page.nextCursor || cursors.has(page.nextCursor))throw Error('Invalid catalog cursor.');
    cursors.add(page.nextCursor);after=page.nextCursor;
  }
  throw Error('Catalog exceeds dry-run page limit.');
}
const failed=(segmentId:string|null,failure:NonNullable<TopicDryRunResult['failure']>,candidates:DryRunCandidate[]=[]):TopicDryRunResult=>({segmentId,status:'failed',candidates,failure});

/** Read-only advisory analysis. A completed result is never permission to persist. */
export async function runTopicDryRun(sessionId:string,runId:string,deps:TopicDryRunDependencies):Promise<TopicDryRunResult> {
  let source:ReturnType<ReadRepository['segment']>;
  try{source=await deps.repository.segment(sessionId,[runId]);topicSourcesFromArchive(sessionId,source.events);}catch{return failed(null,'archive');}
  let candidates:TopicCandidate[];
  try{candidates=await deps.extract(sessionId,structuredClone(source.events));if(!Array.isArray(candidates))throw Error();}catch{return failed(source.segmentId,'extraction');}
  let snapshot:TopicCatalogEntry[];
  try{snapshot=await catalog(deps.repository,sessionId);}catch{return failed(source.segmentId,'catalog');}
  const current=snapshot.map(currentTopic);const results:DryRunCandidate[]=[];
  const context=topicSourcesFromArchive(sessionId,source.events);
  for(const candidate of candidates){
    const candidateKey=typeof candidate?.key==='string'?candidate.key:'';
    try {
      const recommendation=await deps.assessor.assess({candidate:candidate.value,existingTopics:structuredClone(snapshot),context:structuredClone(context)});
      if(!recommendation.ok){
        if(recommendation.error.code==='EXECUTION_FAILED')return failed(source.segmentId,'assessment',[...results,{candidateKey,recommendedAction:null,mapping:'failure',validation:'not-run',reason:'Semantic assessment failed.'}]);
        results.push({candidateKey,recommendedAction:null,mapping:'reject',validation:'not-run',reason:'Invalid semantic recommendation.'});continue;
      }
      const proposed=recommendation.recommendation;
      const target=proposed.action==='UPDATE'?current.find(topic=>topic.key===proposed.targetKey):undefined;
      const evidence=proposed.action==='ADD' || proposed.action==='UPDATE'?await deps.assessEvidence(sessionId,structuredClone(source.events),structuredClone(candidate),target?structuredClone(target):undefined):undefined;
      const mapped=mapTopicAssessment({sessionId,events:source.events,candidate,recommendation:proposed,assessment:evidence,existingTopics:current});
      if(mapped.decision==='proposal'){
        const final=validateTopicAssessment(sessionId,source.events,mapped.candidate,mapped.assessment,target);
        if(final.decision==='accept')results.push({candidateKey,recommendedAction:proposed.action,mapping:'proposal',validation:'accept'});
        else results.push({candidateKey,recommendedAction:proposed.action,mapping:final.decision,validation:'not-run',reason:final.reason});
      } else results.push({candidateKey,recommendedAction:proposed.action,mapping:mapped.decision,validation:'not-run',reason:mapped.reason});
    } catch {return failed(source.segmentId,'assessment',[...results,{candidateKey,recommendedAction:null,mapping:'failure',validation:'not-run',reason:'Candidate processing failed.'}]);}
  }
  try{
    const latest=await deps.repository.segment(sessionId,[runId]);
    if(latest.segmentId!==source.segmentId || JSON.stringify(await catalog(deps.repository,sessionId))!==JSON.stringify(snapshot))return failed(source.segmentId,'stale',results);
  }catch{return failed(source.segmentId,'stale',results);}
  const counts=new Map<string,number>();for(const result of results)if(result.mapping==='proposal'){const key=result.candidateKey.replace(/[A-Z]/g,char=>char.toLowerCase());counts.set(key,(counts.get(key)??0)+1);}
  for(const result of results)if(result.mapping==='proposal' && (counts.get(result.candidateKey.replace(/[A-Z]/g,char=>char.toLowerCase()))??0)>1){result.mapping='defer';result.validation='not-run';result.reason='Conflicting proposals require separate review.';}
  return {segmentId:source.segmentId,status:'completed',candidates:results};
}
