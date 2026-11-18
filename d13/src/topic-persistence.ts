import type { HistoryEvent } from './conversation-history';
import type { TopicCandidate, TopicRecord, TopicUpdate } from './topic-memory';
import { validateTopicAssessment, type SemanticAssessment } from './topic-semantic';

export interface TopicRepository {
  get(sessionId:string,key:string):unknown;
  commit(sessionId:string,update:TopicUpdate,assessment:SemanticAssessment,expectedRevision:number):unknown;
}

/** The prototype flow persists accepted decisions only; archive input must be trusted. */
export function persistAssessedTopic(repository:TopicRepository, sessionId:string, events:readonly HistoryEvent[], candidate:TopicCandidate, assessment:SemanticAssessment, expectedRevision:number, current?:TopicRecord):{decision:'accept'|'reject'|'defer';record?:unknown;reason?:string} {
  const saved=repository.get(sessionId,current?.key ?? candidate.key) as {key:string;value:string;status:string;revision:number}|null;
  if(current && (!saved || saved.revision!==expectedRevision || saved.key.trim().toLocaleLowerCase()!==current.key.trim().toLocaleLowerCase() || saved.value!==current.value || saved.status!==current.status))throw new Error('Topic revision conflict.');
  const decision=validateTopicAssessment(sessionId,events,candidate,assessment,current);
  if(decision.decision!=='accept')return decision;
  return {decision:'accept',record:repository.commit(sessionId,decision.update,assessment,expectedRevision)};
}
