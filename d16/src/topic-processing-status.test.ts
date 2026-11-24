import { expect, it } from 'vitest';
import { topicProcessingNotice } from './topic-processing-status';

it('maps statuses without false success or unsupported durable-retry claims',()=>{
  expect(topicProcessingNotice('completed')).toMatchObject({severity:'success'});
  expect(topicProcessingNotice('alreadyCompleted')).toBeNull();expect(topicProcessingNotice('disabled')).toBeNull();
  for(const status of ['unresolved','rejected','stale','failed','unknown'] as const){const notice=topicProcessingNotice(status);expect(notice?.severity).not.toBe('success');expect(notice?.message).not.toMatch(/queued|safely stored|will retry/i);}
  expect(topicProcessingNotice('unknown')?.message).toMatch(/could not be confirmed/i);
});
