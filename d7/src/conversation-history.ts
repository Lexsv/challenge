import type { AgentRun, TextMessage, ToolExecution } from './agent-tool-contracts';
import type { ManagerConversationState } from './manager-agent';

export type HistoryEvent = {
  id: string;
  sessionId: string;
  sequence?: number;
} & ({ type: 'message'; payload: TextMessage }
  | { type: 'run'; payload: AgentRun }
  | { type: 'tool-call' | 'tool-result'; payload: ToolExecution });

export function restoreHistory(initial: ManagerConversationState, events: HistoryEvent[]): ManagerConversationState {
  const state = structuredClone(initial);
  state.messages = []; state.runs = []; state.toolExecutions = [];
  for (const event of structuredClone(events).sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))) {
    if (event.sessionId !== state.conversation.id) throw new Error('History belongs to another session.');
    if (event.type === 'message') state.messages.push(event.payload);
    else if (event.type === 'run') {
      const index = state.runs.findIndex((run) => run.id === event.payload.id);
      if (index < 0) state.runs.push(event.payload); else state.runs[index] = event.payload;
    } else {
      const index = state.toolExecutions.findIndex((tool) => tool.id === event.payload.id);
      if (index < 0) state.toolExecutions.push(event.payload); else state.toolExecutions[index] = event.payload;
    }
  }
  // Interrupted work is displayed, never resumed or dispatched during restoration.
  for (const tool of state.toolExecutions) if (!tool.endedAt) {
    tool.status = 'incomplete';
    tool.error = 'Incomplete: no saved result. This call was not replayed.';
  }
  for (const run of state.runs) {
    run.messageIds = state.messages.filter((message) => message.runId === run.id).map((message) => message.id);
    run.toolExecutionIds = state.toolExecutions.filter((tool) => tool.runId === run.id).map((tool) => tool.id);
    if (!run.endedAt) { run.status = 'incomplete'; }
  }
  state.conversation.messageIds = state.messages.map((message) => message.id);
  state.conversation.runIds = state.runs.map((run) => run.id);
  return state;
}

// Retain exact events on failed/ambiguous saves; retry never calls the manager or a tool.
export class HistoryWriter {
  private pending: HistoryEvent[] = [];
  private flushing: Promise<void> | null = null;
  constructor(private readonly save: (event: HistoryEvent) => Promise<unknown>) {}
  async append(event: HistoryEvent) { this.pending.push(structuredClone(event)); await this.flush(); }
  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = (async () => {
      while (this.pending.length) { await this.save(this.pending[0]); this.pending.shift(); }
    })().finally(() => { this.flushing = null; });
    return this.flushing;
  }
}
