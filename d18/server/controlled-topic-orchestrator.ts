import { runTopicDryRun, type TopicDryRunDependencies } from '../src/topic-dry-run.ts';
import type { TopicCandidate } from '../src/topic-memory';
import type { SemanticAssessment } from '../src/topic-semantic';
import type { SemanticRecommendation } from '../src/semantic-assessor';
import type { ControlledTopicProposal, ControlledTopicRepository } from './topic-repository.mjs';
import type { TopicProcessingStatus } from '../src/topic-processing-status';

type Result={status:TopicProcessingStatus;segmentId?:string};
type Dependencies=Omit<TopicDryRunDependencies,'repository'> & {repository:ControlledTopicRepository};
type Policy={enabled?:boolean; authorize?:(summary:{sessionId:string;runId:string;segmentId:string;candidateCount:number})=>boolean|Promise<boolean>};

/** Internal factory only: neither configuration nor authorization comes from a request or model output. */
export function createControlledTopicOrchestrator(deps:Dependencies,policy:Policy={}) {
  return {async process(sessionId:string,runId:string,...unexpected:unknown[]):Promise<Result>{
    if(unexpected.length || typeof sessionId!=='string' || typeof runId!=='string')return {status:'failed'};
    if(policy.enabled!==true || typeof policy.authorize!=='function')return {status:'disabled'};
    let snapshot:ReturnType<ControlledTopicRepository['controlledSnapshot']>;
    try{snapshot=deps.repository.controlledSnapshot(sessionId,runId);}catch{return {status:'failed'};}
    if(snapshot.completed)return {status:'alreadyCompleted',segmentId:snapshot.segmentId};
    const candidates:TopicCandidate[]=[];const recommendations:SemanticRecommendation[]=[];const assessments:(SemanticAssessment|undefined)[]=[];
    // A read-only view pins the existing dry-run orchestrator to exactly this trusted snapshot.
    const dryRepository:TopicDryRunDependencies['repository']={
      segment:(id,ids)=>{if(id!==sessionId || ids.length!==1 || ids[0]!==runId)throw Error('Invalid segment.');return {segmentId:snapshot.segmentId,events:structuredClone(snapshot.events),completed:false};},
      catalog:(id,options={})=>{if(id!==sessionId)throw Error('Invalid session.');const limit=options.limit??50;const start=options.after===undefined?0:snapshot.topics.findIndex(topic=>topic.key===options.after)+1;if(options.after!==undefined && start===0)throw Error('Invalid cursor.');const rows=snapshot.topics.slice(start,start+limit);return {topics:structuredClone(rows),nextCursor:start+limit<snapshot.topics.length?rows.at(-1)!.key:null};},
    };
    let extractionSucceeded=false;
    const analysis=await runTopicDryRun(sessionId,runId,{
      repository:dryRepository,
      extract:async(id,events)=>{const extracted=await deps.extract(id,events);if(!Array.isArray(extracted))throw Error('Invalid extraction.');candidates.push(...structuredClone(extracted));extractionSucceeded=true;return structuredClone(extracted);},
      assessor:{assess:async input=>{const result=await deps.assessor.assess(input);if(result.ok)recommendations.push(structuredClone(result.recommendation));return result;}},
      assessEvidence:async(id,events,candidate,current)=>{const result=await deps.assessEvidence(id,events,candidate,current);assessments.push(structuredClone(result));return result;},
    });
    if(analysis.status!=='completed')return {status:'failed',segmentId:snapshot.segmentId};
    if(!extractionSucceeded || candidates.length!==analysis.candidates.length)return {status:'failed',segmentId:snapshot.segmentId};
    if(analysis.candidates.some(item=>item.mapping==='reject'))return {status:'rejected',segmentId:snapshot.segmentId};
    if(analysis.candidates.some(item=>item.mapping==='defer'))return {status:'unresolved',segmentId:snapshot.segmentId};
    if(analysis.candidates.some(item=>item.mapping!=='proposal' && item.mapping!=='no-mutation'))return {status:'failed',segmentId:snapshot.segmentId};
    if(recommendations.length!==candidates.length)return {status:'failed',segmentId:snapshot.segmentId};
    const required= recommendations.filter(item=>item.action==='ADD' || item.action==='UPDATE').length;
    if(assessments.length!==required)return {status:'failed',segmentId:snapshot.segmentId};
    let evidenceIndex=0;const proposals:ControlledTopicProposal[]=[];
    for(let index=0;index<candidates.length;index++){
      const candidate=candidates[index],recommendation=recommendations[index];
      if(analysis.candidates[index].candidateKey!==candidate.key || analysis.candidates[index].recommendedAction!==recommendation.action)return {status:'failed',segmentId:snapshot.segmentId};
      const target=recommendation.action==='UPDATE'||recommendation.action==='DUPLICATE'?snapshot.topics.find(topic=>topic.key===recommendation.targetKey):undefined;
      if((recommendation.action==='UPDATE'||recommendation.action==='DUPLICATE') && !target)return {status:'rejected',segmentId:snapshot.segmentId};
      const assessment=recommendation.action==='ADD'||recommendation.action==='UPDATE'?assessments[evidenceIndex++]:undefined;
      proposals.push({candidate,recommendation,...(assessment?{assessment}:{}),expectedTopicRevision:target?.revision??0});
    }
    try{if(await policy.authorize({sessionId,runId,segmentId:snapshot.segmentId,candidateCount:candidates.length})!==true)return {status:'disabled',segmentId:snapshot.segmentId};}catch{return {status:'failed',segmentId:snapshot.segmentId};}
    try{
      const committed=deps.repository.commitControlledSegment(sessionId,runId,{authorized:true,analysisComplete:true,candidateCount:candidates.length,segmentId:snapshot.segmentId,sourceRevision:snapshot.sourceRevision,catalogRevision:snapshot.catalogRevision,proposals});
      return {status:committed.alreadyCompleted?'alreadyCompleted':'completed',segmentId:snapshot.segmentId};
    }catch(error){
      const message=error instanceof Error?error.message:'';
      // A thrown call may have committed before the response was lost. Do not claim rollback.
      return {status:/^(Archived segment changed during processing\.|Topic catalog revision conflict\.|Topic revision conflict\.)$/.test(message)?'stale':'unknown',segmentId:snapshot.segmentId};
    }
  }};
}
