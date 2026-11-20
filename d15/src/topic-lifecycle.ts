import type { HistoryEvent } from './conversation-history';
import type { MemoryGroup } from './session-memory';
import type { TopicCandidate, TopicRecord, TopicUpdate } from './topic-memory';
import { validateTopicAssessment, type SemanticAssessment } from './topic-semantic.ts';

type SegmentOutcome = {decision:'accept';update:TopicUpdate;assessment:SemanticAssessment;expectedRevision:number}|{decision:'reject'|'defer'};
export type TopicCatalogEntry = {key:string;value:string;status:TopicRecord['status'];revision:number};
export type TopicCatalogPage = {topics:TopicCatalogEntry[];nextCursor:string|null};
export interface TopicSegmentRepository {
  segment(sessionId:string,runIds:string[]):{segmentId:string;events:HistoryEvent[];completed:boolean};
  get(sessionId:string,key:string):unknown;
  catalog(sessionId:string,options?:{limit?:number;after?:string}):TopicCatalogPage;
  commitSegment(sessionId:string,runIds:string[],outcomes:SegmentOutcome[],expectedSegmentId:string):{completed:boolean;alreadyCompleted:boolean};
}
export type MockSegmentAssessment = (events:readonly HistoryEvent[])=>Promise<{candidate:TopicCandidate;assessment:SemanticAssessment}[]>;

/** One archive run per segment makes overlapping buffer windows idempotent. */
export function createTopicLifecycle(repository:TopicSegmentRepository,sessionId:string,assess:MockSegmentAssessment):(groups:readonly MemoryGroup[])=>Promise<void> {
  return async groups=>{
    for(const group of groups){
      const source=repository.segment(sessionId,[group.id]);
      if(source.completed)continue;
      const proposals=await assess(source.events);
      if(!Array.isArray(proposals))throw new Error('Segment assessment returned an invalid result.');
      const outcomes:SegmentOutcome[]=[];
      const staged=new Map<string,{key:string;value:string;status:TopicRecord['status'];revision:number}|null>();
      for(const proposal of proposals){
        if(!proposal?.candidate || !proposal.assessment || !Array.isArray(proposal.assessment.evidence) || typeof proposal.assessment.factSupported!=='boolean' || typeof proposal.assessment.changeConfirmed!=='boolean' || !['fact','proposal','change','correction','cancellation','ambiguous','noise'].includes(proposal.assessment.classification))throw new Error('Segment assessment returned an invalid candidate.');
        const key=proposal.candidate.key.trim().toLocaleLowerCase();
        const saved=staged.has(key)?staged.get(key)!:repository.get(sessionId,proposal.candidate.key) as {key:string;value:string;status:TopicRecord['status'];revision:number}|null;
        const current:TopicRecord|undefined=saved?{key:saved.key,value:saved.value,status:saved.status,sources:[],archiveSequence:null,history:[]}:undefined;
        const result=validateTopicAssessment(sessionId,source.events,proposal.candidate,proposal.assessment,current);
        outcomes.push(result.decision==='accept'?{decision:'accept',update:result.update,assessment:proposal.assessment,expectedRevision:saved?.revision ?? 0}:{decision:result.decision});
        if(result.decision==='accept')staged.set(key,{key:result.update.candidate.key,value:result.update.candidate.value,status:result.update.candidate.status,revision:(saved?.revision ?? 0)+1});
      }
      repository.commitSegment(sessionId,[group.id],outcomes,source.segmentId);
    }
  };
}
