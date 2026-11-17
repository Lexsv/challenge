import type { DatabaseSync } from 'node:sqlite';
import type { TopicRepository } from '../src/topic-persistence';
import type { TopicSegmentRepository } from '../src/topic-lifecycle';
import type { TopicCandidate } from '../src/topic-memory';
import type { SemanticRecommendation } from '../src/semantic-assessor';
import type { SemanticAssessment } from '../src/topic-semantic';
import type { HistoryEvent } from '../src/conversation-history';
import type { TopicCatalogEntry } from '../src/topic-lifecycle';
export type ControlledTopicProposal={candidate:TopicCandidate;recommendation:SemanticRecommendation;assessment?:SemanticAssessment;expectedTopicRevision:number};
export type ControlledSegmentRequest={authorized:true;analysisComplete:true;candidateCount:number;segmentId:string;sourceRevision:string;catalogRevision:string;proposals:ControlledTopicProposal[]};
export interface ControlledTopicRepository {
  controlledSnapshot(sessionId:string,runId:string):{segmentId:string;sourceRevision:string;catalogRevision:string;completed:boolean;events:HistoryEvent[];topics:TopicCatalogEntry[]};
  commitControlledSegment(sessionId:string,runId:string,request:ControlledSegmentRequest):{completed:boolean;alreadyCompleted:boolean};
}
export function createTopicRepository(db:DatabaseSync):TopicRepository & TopicSegmentRepository & ControlledTopicRepository;
