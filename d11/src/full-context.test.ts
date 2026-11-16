import { expect, it, vi } from 'vitest';
import { ManagerAgent, createManagerConversation, type ManagerLlmAdapter } from './manager-agent';
import { ToolRegistry } from './tool-runtime';

it('sends all prior dialogue in full context and blocks instead of trimming when it exceeds the model budget', async () => {
  let limit = 100;
  const complete = vi.fn<ManagerLlmAdapter['complete']>(async () => ({ text: 'acknowledged' }));
  const adapter: ManagerLlmAdapter = {
    complete,
    context: {
      assess: async messages => ({ tokens: messages.length, modelInputBudget: limit, target: 1 }),
      summarize: async () => { throw new Error('Unexpected summarization'); },
    },
  };
  const state = createManagerConversation();
  const manager = new ManagerAgent(adapter, new ToolRegistry());
  await manager.run({ state, userText: 'first', contextMode: 'full' });
  await manager.run({ state, userText: 'second', contextMode: 'full' });
  expect(complete.mock.calls[1][0].messages.map(message => message.content)).toEqual(['first', 'acknowledged', 'second']);
  limit = 2;
  const blocked = await manager.run({ state, userText: 'third', contextMode: 'full' });
  expect(blocked.error).toContain('Full Context exceeds the model input budget');
  expect(blocked.run.status).toBe('failed');
  expect(complete).toHaveBeenCalledTimes(2);
});
