import { restoreHistory, type HistoryEvent, type HistoryWriter } from './conversation-history';
import type { ManagerConversationState } from './manager-agent';

export const eventRunId = (event: HistoryEvent) => event.type === 'run' ? event.payload.id : event.payload.runId;
export async function retrySavedHistory(initial: ManagerConversationState, writer: HistoryWriter, load: () => Promise<HistoryEvent[]>) {
  await writer.flush();
  const pageEvents = await load();
  return {
    conversation: restoreHistory(initial, pageEvents),
    pageEvents,
    visibleRuns: new Set(pageEvents.map(eventRunId)),
    pageCursor: undefined,
  };
}
/** Idempotent page merging retains event sequence and complete run boundaries. */
export function mergeHistoryPages(current: readonly HistoryEvent[], incoming: readonly HistoryEvent[]) {
  const events = new Map(current.map(event => [event.id,event]));
  for(const event of incoming)events.set(event.id,event);
  return [...events.values()].sort((a,b)=>(a.sequence??0)-(b.sequence??0));
}
export function prependedScrollTop(before: {height:number; top:number}, height:number) {
  return before.top + height - before.height;
}
