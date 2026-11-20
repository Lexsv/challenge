import { describe, expect, it } from 'vitest';
import { operationNotices, type OperationOutcomes, type ContextRetrievalOutcome } from './operation-outcomes.ts';
import { topicProcessingNotice } from './topic-processing-status.ts';
import type { ManagerRunResult } from './manager-agent.ts';

const base: OperationOutcomes = {
  answer:{status:'completed',text:'An answer'},
  memory:{status:'completed',mutation:'confirmed',retention:'verified'},
  context:{status:'found',scope:'current_session',content:'A discussion',coverage:'complete'},
};
const messages = (outcome: OperationOutcomes) => operationNotices(outcome).map(n=>n.message).join(' ');

describe('isolated operation outcome mapping',()=>{
  it('preserves independent answer and memory outcomes',()=>{
    expect(messages(base)).toContain('Memory was saved');
    const result = {...base,memory:{status:'failed',category:'database',mutation:'unknown',retention:'unknown'}} satisfies OperationOutcomes;
    expect(result.answer.status).toBe('completed');
    expect(messages(result)).toContain('no save was confirmed');
    expect(messages(result)).not.toContain('answer could not');
  });
  it('reports an answer failure without a misleading save notification',()=>{
    const result = {...base,answer:{status:'failed',category:'answer_provider'}} satisfies OperationOutcomes;
    expect(messages(result)).toContain('answer could not be generated');
    expect(messages(result)).not.toContain('Memory was saved');
  });
  it('distinguishes unknown commit, marker-only, mutation and duplicate completion',()=>{
    for (const status of ['alreadyCompleted','disabled'] as const) expect(operationNotices({...base,memory:{status,mutation:'confirmed',retention:'verified'}})).toEqual([]);
    expect(operationNotices({...base,memory:{status:'completed',mutation:'none',retention:'verified'}})).toEqual([]);
    expect(messages({...base,memory:{status:'unknown',category:'unknown_commit',mutation:'unknown',retention:'unknown'}})).toContain('could not be confirmed');
  });
  it('handles wrong-session, complete, partial and failed retrieval separately',()=>{
    const noMatch: ContextRetrievalOutcome={status:'not_found',scope:'current_session',coverage:'complete',search:'exhaustive'};
    const noMatchText=messages({...base,context:noMatch,memory:{status:'disabled',mutation:'none',retention:'unknown'}});
    expect(noMatchText).toMatch(/this conversation/);
    expect(noMatchText).toMatch(/may have discussed/);
    expect(noMatchText).not.toMatch(/searched other|definitely|never existed/i);
    expect(operationNotices({...base,memory:{status:'disabled',mutation:'none',retention:'unknown'}})).toEqual([]);
    const incomplete={...base,answer:{status:'blocked',category:'required_context'},context:{status:'incomplete',scope:'current_session'},memory:{status:'disabled',mutation:'none',retention:'unknown'}} satisfies OperationOutcomes;
    expect(messages(incomplete)).toMatch(/couldn't check the entire/);
    const failed={...incomplete,context:{status:'failed',scope:'current_session',category:'server'}} satisfies OperationOutcomes;
    expect(messages(failed)).toMatch(/technical problem/);
    expect(messages(failed)).not.toMatch(/couldn't find/i);
  });
  it('does not imply exhaustive archive or cross-session search for semantic zero matches',()=>{
    const context={status:'not_found',scope:'current_session',coverage:'unknown',search:'semantic'} satisfies ContextRetrievalOutcome;
    const text=messages({...base,context});
    expect(text).toContain('matching discussion');
    expect(text).not.toMatch(/all conversations|searched other|never/i);
  });
  it('does not leak error details or claim durable retry',()=>{
    for (const status of ['failed','unknown','unresolved','rejected','stale'] as const) {
      const text=messages({...base,memory:{status,category:'unknown',mutation:'unknown',retention:'unknown'}});
      expect(text).not.toMatch(/queued|safely stored|automatically retry|sqlite|stack|api key/i);
    }
  });
  it('preserves the existing Manager result and status helper contracts',()=>{
    const legacy = {state:{} as ManagerRunResult['state'],run:{} as ManagerRunResult['run'],error:'error'} satisfies ManagerRunResult;
    expect(legacy.error).toBe('error');
    expect(topicProcessingNotice('completed')?.severity).toBe('success');
  });
});
