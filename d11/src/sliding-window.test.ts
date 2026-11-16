import { expect, it } from 'vitest';
import { slidingWindow } from './sliding-window';
import { ManagerAgent, createManagerConversation, type ManagerLlmAdapter } from './manager-agent';
import { ToolRegistry } from './tool-runtime';
import { vi } from 'vitest';

it('selects the newest dialogue messages while retaining their tool observations', () => {
  const history = [
    {id:'one',messages:[{role:'user' as const,content:'old'}]},
    {id:'two',messages:[{role:'assistant' as const,content:'recent'},{role:'tool' as const,content:'observation'}]},
  ];
  const current = [{role:'user' as const,content:'question'},{role:'tool' as const,content:'active result'}];
  expect(slidingWindow(history,current,2).map(message=>message.content)).toEqual(['recent','observation','question','active result']);
  expect(slidingWindow(history,current,1).map(message=>message.content)).toEqual(['question','active result']);
  expect(() => slidingWindow(history,current,0)).toThrow('positive');
});

it('uses the recent window on Manager answer requests', async () => {
  const complete = vi.fn<ManagerLlmAdapter['complete']>(async () => ({text:'answer'}));
  const manager = new ManagerAgent({complete}, new ToolRegistry());
  const state = createManagerConversation();
  await manager.run({state,userText:'old',contextMode:'sliding',windowSize:2});
  await manager.run({state,userText:'new',contextMode:'sliding',windowSize:2});
  expect(complete.mock.calls[1][0].messages.map(message => message.content)).toEqual(['answer','new']);
});

it('keeps the full conversation while sending only the latest ten dialogue messages', async () => {
  const complete = vi.fn<ManagerLlmAdapter['complete']>(async () => ({text:'answer'}));
  const manager = new ManagerAgent({complete}, new ToolRegistry());
  const state = createManagerConversation();
  for (let i = 1; i <= 7; i++) await manager.run({state,userText:`question ${i}`,contextMode:'sliding',windowSize:10});
  const last = complete.mock.calls[6][0].messages;
  expect(last).toHaveLength(10);
  expect(last.map(message => message.content)).not.toContain('question 1');
  expect(last.at(-1)?.content).toBe('question 7');
  expect(state.messages).toHaveLength(14);
  expect(state.messages[0].text).toBe('question 1');
});
