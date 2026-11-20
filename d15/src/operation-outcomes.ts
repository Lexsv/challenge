import type { TopicProcessingStatus } from './topic-processing-status.ts';

/** Independent advisory contracts. They do not change Manager execution. */
export type AnswerOutcome =
  | { status: 'completed'; text: string }
  | { status: 'failed'; category: 'answer_provider' | 'server' | 'unknown' }
  | { status: 'blocked'; category: 'required_context' | 'context_budget' | 'server' | 'unknown' };

export type MemoryOutcome = {
  status: TopicProcessingStatus;
  category?: 'database' | 'semantic' | 'authorization' | 'ambiguity' | 'stale' | 'unknown_commit' | 'server' | 'unknown';
  /** This must be established by the producer, not inferred from a buffer. */
  retention: 'verified' | 'unknown';
  /** Only a confirmed committed topic mutation permits a save notice. */
  mutation: 'confirmed' | 'none' | 'unknown';
};

export type RetrievalScope = 'current_session' | 'multiple_sessions';
export type ContextRetrievalOutcome =
  | { status: 'found'; scope: RetrievalScope; content: string; coverage: 'complete' | 'partial' | 'unknown' }
  | { status: 'not_found'; scope: RetrievalScope; coverage: 'complete' | 'unknown'; search: 'exhaustive' | 'semantic' }
  | { status: 'incomplete'; scope: RetrievalScope }
  | { status: 'failed'; scope: RetrievalScope; category: 'database' | 'server' | 'unknown' };

export type OperationOutcomes = { answer: AnswerOutcome; memory: MemoryOutcome; context: ContextRetrievalOutcome };
export type OperationNotice = { kind: 'info' | 'warning' | 'error' | 'clarification'; message: string };

/** Maps structured outcomes only; never displays provider or database error text. */
export function operationNotices({answer, memory, context}: OperationOutcomes): OperationNotice[] {
  const notices: OperationNotice[] = [];
  if (answer.status === 'failed') notices.push({kind:'error', message:'The answer could not be generated. Please try again.'});
  if (answer.status === 'blocked') {
    if (context.status === 'incomplete') notices.push({kind:'error', message:"I couldn't check the entire conversation history, so I can't confirm whether we discussed it."});
    else if (context.status === 'failed') notices.push({kind:'error', message:"I couldn't check the conversation history because of a technical problem."});
    else if (answer.category === 'context_budget') notices.push({kind:'error', message:'The required context is too large to process safely.'});
    else notices.push({kind:'error', message:'The required context is unavailable, so an answer cannot be generated safely.'});
  } else if (context.status === 'not_found') {
    notices.push({kind:'info', message:context.scope === 'current_session'
      ? "I couldn't find a matching discussion in this conversation. We may have discussed it in another chat."
      : "I couldn't find a matching discussion in the conversations searched."});
  } else if (context.status === 'incomplete') notices.push({kind:'warning', message:"I couldn't check the entire conversation history, so I can't confirm whether we discussed it."});
  else if (context.status === 'failed') notices.push({kind:'warning', message:"I couldn't check the conversation history because of a technical problem."});

  switch (memory.status) {
    case 'completed':
      if (memory.mutation === 'confirmed' && answer.status !== 'failed') notices.push({kind:'info',message:'Memory was saved.'});
      break;
    case 'alreadyCompleted': case 'disabled': break;
    case 'unresolved': notices.push({kind:'clarification',message:'Memory needs clarification before it can be saved.'}); break;
    case 'rejected': notices.push({kind:'warning',message:'Memory could not be verified and was not saved.'}); break;
    case 'stale': notices.push({kind:'warning',message:'Memory changed during processing. Process it again.'}); break;
    case 'failed': notices.push({kind:'warning',message:'Memory processing failed; no save was confirmed.'}); break;
    case 'unknown': notices.push({kind:'warning',message:'Memory save could not be confirmed. Check its status before retrying.'}); break;
  }
  return notices;
}
