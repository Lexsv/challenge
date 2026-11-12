import { expect, it, vi } from 'vitest';
import { FactExtractor, mergeFacts } from './fact-extractor';
import type { ManagerLlmAdapter } from './manager-agent';

it('validates structured facts and applies explicit revisions by subject and attribute', async () => {
  const complete = vi.fn(async (_input: Parameters<ManagerLlmAdapter['complete']>[0]) => ({text: JSON.stringify({facts:[{subject:'Project',attribute:'budget',value:'$120'}]})}));
  const adapter: ManagerLlmAdapter = { complete, context: {assess: async () => ({tokens:10,limit:100}), summarize: async () => {throw Error('not used');}} };
  const extracted = await new FactExtractor(adapter).extract([{role:'user',content:'The budget is now $120.'}]);
  expect(mergeFacts([{subject:'project',attribute:'Budget',value:'$100'}], extracted)).toEqual(extracted);
  expect(complete.mock.calls[0][0].tools).toEqual([]);
});

it('rejects malformed facts and chunks sources to fit the extractor budget', async () => {
  const complete = vi.fn(async () => ({text: '{"facts":[]}'}));
  const adapter: ManagerLlmAdapter = { complete, context: {assess: async messages => ({tokens: messages[1].content.length,limit:25}), summarize: async () => {throw Error('not used');}} };
  await new FactExtractor(adapter).extract([{role:'user',content:'Long text '.repeat(20)}]);
  expect(complete.mock.calls.length).toBeGreaterThan(1);
  complete.mockResolvedValueOnce({text:'{"facts":[{"subject":"x"}]}'});
  await expect(new FactExtractor(adapter).extract([{role:'user',content:'Hi'}])).rejects.toThrow('invalid fact');
});
