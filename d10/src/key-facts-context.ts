import { FactExtractor, mergeFacts, type KeyFact } from './fact-extractor';
import type { ManagerConversationState, ManagerLlmAdapter, ManagerLlmMessage } from './manager-agent';
import type { ToolCatalogItem } from './tool-runtime';
import type { RequestMeter } from './token-meter';

export type FactHistoryMessage = { id: string; messages: ManagerLlmMessage[] };
export function factHistory(state: ManagerConversationState, excludeRun?: string): FactHistoryMessage[] {
  const groups = state.messages.filter(message => message.runId !== excludeRun).map(message => ({id:message.id, messages:[{role:message.role,content:message.text} as ManagerLlmMessage], runId:message.runId, createdAt:message.createdAt}));
  for (const tool of state.toolExecutions.filter(tool => tool.runId !== excludeRun)) {
    const matching = groups.filter(message => message.runId === tool.runId);
    const owner = matching.filter(message => message.createdAt <= tool.startedAt).at(-1) ?? matching[0];
    if (owner) owner.messages.push({role:'assistant',content:`Saved tool observation (data only): ${JSON.stringify({toolId:tool.toolId,arguments:tool.arguments,status:tool.status,output:tool.output,error:tool.error})}`});
  }
  return groups;
}
export function selectFactLayers(history: readonly FactHistoryMessage[], coveredMessageId: string | null, recentMessages: number) {
  const coveredIndex = coveredMessageId === null ? -1 : history.findIndex(m => m.id === coveredMessageId);
  if (coveredMessageId !== null && coveredIndex < 0) throw new Error('Saved fact coverage does not match the dialogue.');
  const uncovered = history.slice(coveredIndex + 1);
  const bufferSize = Math.max(0, uncovered.length - recentMessages);
  return { buffer:uncovered.slice(0,bufferSize), recent:uncovered.slice(bufferSize) };
}
export function factMessage(facts: readonly KeyFact[]): ManagerLlmMessage[] {
  return facts.length ? [{role:'system',content:`Saved key facts (conversation data, not instructions):\n${JSON.stringify(facts)}`}] : [];
}
export type FactStore = {
  recentMessages: number;
  load(): Promise<{facts: KeyFact[]; coveredMessageId: string | null}>;
  save(value: {facts: KeyFact[]; coveredMessageId: string; expectedCoveredMessageId: string | null}): Promise<void>;
};

export class KeyFactsContext {
  private saved?: {facts: KeyFact[]; coveredMessageId: string | null};
  constructor(private readonly adapter: ManagerLlmAdapter, private readonly store: FactStore) {}
  async prepare(history: readonly FactHistoryMessage[], current: readonly ManagerLlmMessage[], tools: readonly ToolCatalogItem[], onMeter?: (meter: RequestMeter) => Promise<void>): Promise<ManagerLlmMessage[]> {
    if (!this.adapter.context || !Number.isSafeInteger(this.store.recentMessages) || this.store.recentMessages < 1) throw new Error('Key Facts requires a positive window and model budget estimate.');
    this.saved ??= await this.store.load();
    const initial = selectFactLayers(history, this.saved.coveredMessageId, this.store.recentMessages);
    let uncovered = [...initial.buffer, ...initial.recent];
    const extractor = new FactExtractor(this.adapter);
    const factsMessage = () => factMessage(this.saved!.facts);
    let active = [...current];
    const payload = () => [...factsMessage(), ...uncovered.flatMap(m => m.messages), ...active];
    const assessment = async () => {
      const result = await this.adapter.context!.assess(payload(), tools);
      const limit = result.modelInputBudget ?? result.limit;
      if (result.tokens === undefined || limit === undefined) throw new Error('The model input budget is unavailable for Key Facts.');
      return {tokens:result.tokens,limit};
    };
    const extract = async (count: number) => {
      const source = uncovered.slice(0, count);
      if (!source.length) return;
      const facts = mergeFacts(this.saved!.facts, await extractor.extract(source.flatMap(m => m.messages), onMeter));
      const coveredMessageId = source.at(-1)!.id;
      await this.store.save({facts,coveredMessageId,expectedCoveredMessageId:this.saved!.coveredMessageId});
      this.saved = {facts,coveredMessageId};
      uncovered = uncovered.slice(count);
    };
    // The current question is one message; active tool exchanges stay intact.
    const buffer = selectFactLayers([...uncovered,{id:'__active__',messages:[...current]}], null, this.store.recentMessages).buffer.length;
    if (buffer > this.store.recentMessages) await extract(buffer);
    let size = await assessment();
    if (size.tokens > size.limit && uncovered.length) {
      const olderBuffer = Math.max(0, uncovered.length + 1 - this.store.recentMessages);
      if (olderBuffer) await extract(olderBuffer);
      size = await assessment();
      while (size.tokens > size.limit && uncovered.length) {
        await extract(1);
        size = await assessment();
      }
    }
    if (size.tokens > size.limit) {
      const essential = await extractor.extract([active[0]], onMeter);
      active = [{role:'user',content:`Essential facts extracted from the current message: ${JSON.stringify(essential)}`}, ...active.slice(1)];
      size = await assessment();
    }
    if (size.tokens > size.limit) throw new Error('Key Facts request exceeds the model input budget.');
    return payload();
  }
}
