import { historicalContext, type ContextEvent } from "./context-compaction";
import { KeyFactsContext, factHistory, type FactStore } from './key-facts-context';
import { ManagerProviderError } from "./manager-llm-adapter";
import type { ModelRequestMeter, RequestMeter } from "./token-meter";
import type { HistoryEvent } from "./conversation-history";
import type {
  AgentRun,
  Conversation,
  TextMessage,
  ToolExecution,
} from "./agent-tool-contracts";
import type { ToolCatalogItem, ToolRegistry } from "./tool-runtime";

export type ManagerLlmMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolName?: string;
  toolCalls?: ManagerToolCall[];
};

export type ManagerToolCall = {
  id: string;
  toolId: string;
  arguments: unknown;
};

export type ManagerLlmResponse = {
  text?: string;
  toolCalls?: ManagerToolCall[];
};

export interface ManagerLlmAdapter {
  context?: {
    assess(messages: readonly ManagerLlmMessage[], tools: readonly ToolCatalogItem[]): Promise<{ tokens?: number; limit?: number; target?: number; modelInputBudget?: number }>;
    summarize(text: string, onMeter?: (meter: RequestMeter) => Promise<void>, maxTokens?: number): Promise<string>;
  };
  complete(input: {
    messages: readonly ManagerLlmMessage[];
    tools: readonly ToolCatalogItem[];
    onMeter?: (meter: RequestMeter) => Promise<void>;
  }): Promise<ManagerLlmResponse>;
}

export type ManagerConversationState = {
  conversation: Conversation;
  messages: TextMessage[];
  runs: AgentRun[];
  toolExecutions: ToolExecution[];
  requestMeters?: ModelRequestMeter[];
  contextEvents?: ContextEvent[];
  runLastEvent?: Record<string, string>;
};

export type ManagerRunResult = {
  state: ManagerConversationState;
  run: AgentRun;
  finalResponse?: string;
  error?: string;
};

const id = () => crypto.randomUUID();

export function createManagerConversation(title = "Agent Tool Lab"): ManagerConversationState {
  return {
    conversation: {
      id: id(),
      title,
      messageIds: [],
      runIds: [],
      startedAt: Date.now(),
    },
    messages: [],
    runs: [],
    toolExecutions: [],
  };
}

const appendTextMessage = (
  state: ManagerConversationState,
  runId: string,
  role: TextMessage["role"],
  text: string,
) => {
  const message: TextMessage = {
    id: id(),
    conversationId: state.conversation.id,
    runId,
    createdAt: Date.now(),
    role,
    type: "text",
    text,
  };
  state.messages.push(message);
  state.conversation.messageIds.push(message.id);
  return message;
};

export class ManagerAgent {
  constructor(
    private readonly llm: ManagerLlmAdapter,
    private readonly tools: ToolRegistry,
    private readonly defaults: { maxIterations?: number } = {},
  ) {}

  async run(input: {
    state: ManagerConversationState;
    userText: string;
    agentId?: string;
    maxIterations?: number;
    keyFacts?: FactStore;
    onEvent?: (event: HistoryEvent) => Promise<void>;
  }): Promise<ManagerRunResult> {
    const maxIterations = input.maxIterations ?? this.defaults.maxIterations ?? 8;
    const runId = id();
    const userMessage = appendTextMessage(input.state, runId, "user", input.userText);
    const run: AgentRun = {
      id: runId,
      conversationId: input.state.conversation.id,
      agentId: input.agentId ?? "manager-agent",
      status: "running",
      startedAt: Date.now(),
      messageIds: [userMessage.id],
      toolExecutionIds: [],
    };
    input.state.runs.push(run);
    input.state.conversation.runIds.push(run.id);

    const emit = async (type: HistoryEvent['type'], payload: TextMessage | AgentRun | ToolExecution | ModelRequestMeter | ContextEvent) => {
      const event = structuredClone({ id: id(), sessionId: input.state.conversation.id, type, payload }) as HistoryEvent;
      await input.onEvent?.(event);
      (input.state.runLastEvent ??= {})[type === 'run' ? payload.id : (payload as { runId: string }).runId] = event.id;
    };
    if (input.onEvent) {
      await emit('message', userMessage);
      await emit('run', run);
    }
    let history: ManagerLlmMessage[] = [];
    const current: ManagerLlmMessage[] = [{ role: 'user', content: userMessage.text }];
    let llmMessages = [...history, ...current];
    const executableTools = this.tools
      .listBuiltIn()
      .filter((tool) => tool.executable);

    const onMeter = async (meter: RequestMeter) => {
      const linked: ModelRequestMeter = { ...meter, sessionId: input.state.conversation.id, runId: run.id, toolExecutionOffset: input.state.toolExecutions.length };
      const meters = input.state.requestMeters ??= [];
      const index = meters.findIndex((item) => item.id === linked.id);
      if (index < 0) meters.push(linked); else meters[index] = linked;
      await emit('metering', linked);
    };
    const contextEvent = async (phase: ContextEvent['phase'], data: Partial<ContextEvent> = {}) => {
      const event: ContextEvent = { ...data, id: id(), runId: run.id, createdAt: Date.now(), phase };
      (input.state.contextEvents ??= []).push(event);
      await emit('context', event);
    };
    const hardLimit = (budget: {limit?: number; modelInputBudget?: number}) =>
      'modelInputBudget' in budget ? budget.modelInputBudget : budget.limit;
    // Historical messages and saved tool observations remain grouped by run,
    // including failed runs. Saved summaries never participate in the payload.
    const turns = input.state.runs.filter(r => r.id !== run.id).map(r => historicalContext({
      ...input.state,
      messages: input.state.messages.filter(m => m.runId === r.id),
      toolExecutions: input.state.toolExecutions.filter(t => t.runId === r.id),
      contextEvents: [],
    }, run.id)).filter(turn => turn.length > 0);
    const historyForFacts = factHistory(input.state, run.id);
    const keyFacts = input.keyFacts ? new KeyFactsContext(this.llm, input.keyFacts) : undefined;
    let selectedTurns: ManagerLlmMessage[][] = [];
    // Once overflow removes a turn, do not reselect it or older turns during this run.
    let firstEligibleTurn = 0;
    const prepare = async () => {
      const adapter = this.llm.context;
      if (!adapter) { selectedTurns = turns.slice(firstEligibleTurn); history = selectedTurns.flat(); llmMessages = [...history, ...current]; return; }
      const required = await adapter.assess(current, executableTools);
      const hard = hardLimit(required);
      if ((hard !== undefined || required.target) && required.tokens === undefined) throw new Error('Cannot estimate the answer input for the model budget.');
      if (hard !== undefined && required.tokens !== undefined && required.tokens > hard) throw new Error(`Required input exceeds the model input budget (${hard} tokens); this request needs approximately ${required.tokens} tokens.`);
      const target = required.target && required.target > 0 ? Math.min(required.target, hard ?? Infinity) : hard;
      selectedTurns = [];
      if (target === undefined || (required.tokens !== undefined && required.tokens <= target)) {
        for (let index = turns.length - 1; index >= firstEligibleTurn; index--) {
          const candidate = [turns[index], ...selectedTurns];
          const assessed = await adapter.assess([...candidate.flat(), ...current], executableTools);
          if (target !== undefined && (assessed.tokens === undefined || assessed.tokens > target)) break;
          selectedTurns = candidate;
        }
      }
      history = selectedTurns.flat(); llmMessages = [...history, ...current];
    };
    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      let response: ManagerLlmResponse;
      try {
        if (keyFacts) llmMessages = await keyFacts.prepare(historyForFacts, current, executableTools, onMeter);
        else if (this.llm.context) await prepare();
        else { selectedTurns = turns.slice(firstEligibleTurn); history = selectedTurns.flat(); llmMessages = [...history, ...current]; }
        const request = async () => {
          let comparison: Partial<RequestMeter> = { requestKind: 'answer', compacted: false };
          if (this.llm.context) {
            const sent = await this.llm.context.assess(llmMessages, executableTools);
            const limit = hardLimit(sent);
            if (limit !== undefined && (sent.tokens === undefined || sent.tokens > limit)) throw new Error('Answer request blocked: payload exceeds the effective input token limit.');
            const full = await this.llm.context.assess([
              ...historicalContext({ ...input.state, contextEvents: [] }, run.id), ...current,
            ], executableTools);
            comparison = { ...comparison, sentInputTokens: sent.tokens,
              ...(selectedTurns.length < turns.length ? {beforeInputTokens: full.tokens, afterInputTokens: sent.tokens} : {}) };
          }
          try {
            return await this.llm.complete({ messages: llmMessages, tools: executableTools,
              onMeter: meter => onMeter({ ...meter, ...comparison }) });
          } catch (error) {
            if (error instanceof ManagerProviderError && error.metadata.status === 503) throw new Error('The server is temporarily unavailable (503). Please try again later.');
            throw error;
          }
        };
        try { response = await request(); }
        catch (error) {
          if (keyFacts || !(error instanceof ManagerProviderError) || error.metadata.kind !== 'context-overflow') throw error;
          await contextEvent('overflow');
          if (!selectedTurns.length) throw new Error('Context overflow: no older history can be removed for a retry.');
          const previous = await this.llm.context?.assess(llmMessages, executableTools);
          const dropped = selectedTurns.shift()!;
          firstEligibleTurn = turns.indexOf(dropped) + 1;
          history = selectedTurns.flat(); llmMessages = [...history, ...current];
          const reduced = await this.llm.context?.assess(llmMessages, executableTools);
          if (!previous || !reduced || previous.tokens === undefined || reduced.tokens === undefined || reduced.tokens >= previous.tokens) throw new Error('Context overflow: removing the oldest turn did not reduce the request.');
          await contextEvent('retrying', {beforeTokens: previous.tokens, afterTokens: reduced.tokens});
          try { response = await request(); }
          catch (retryError) { if (retryError instanceof Error && retryError.message === 'The server is temporarily unavailable (503). Please try again later.') throw retryError; throw new Error(`Retry with trimmed history failed: ${retryError instanceof Error ? retryError.message : "provider request failed."}`); }
        }
      } catch (error) {
        if (input.state.contextEvents?.at(-1)?.runId === run.id && ["compacting", "retrying"].includes(input.state.contextEvents.at(-1)!.phase)) await contextEvent("failed");
        run.status = "failed";
        run.endedAt = Date.now();
        await emit("run", run);
        return {
          state: input.state,
          run,
          error: error instanceof Error ? error.message : "Manager execution failed.",
        };
      }

      if (response.toolCalls?.length) {
        current.push({
          role: "assistant",
          content: response.text ?? "",
          toolCalls: response.toolCalls,
        });
        if (response.text?.trim()) {
          const assistant = appendTextMessage(
            input.state,
            run.id,
            "assistant",
            response.text,
          );
          run.messageIds.push(assistant.id);
          await emit("message", assistant);
        }

        const pendingCalls: { call: ManagerToolCall; toolExecution: ToolExecution }[] = [];
        for (const call of response.toolCalls) {
          const toolExecution: ToolExecution = {
            id: id(), runId: run.id, toolCallId: call.id, toolId: call.toolId,
            status: 'running', arguments: call.arguments, startedAt: Date.now(),
          };
          input.state.toolExecutions.push(toolExecution);
          run.toolExecutionIds.push(toolExecution.id);
          await emit('tool-call', toolExecution);
          pendingCalls.push({ call, toolExecution });
        }
        for (const { call, toolExecution } of pendingCalls) {
          const execution = await this.tools.executeById(call.toolId, call.arguments);
          toolExecution.endedAt = Date.now();
          toolExecution.status = execution.ok ? 'completed' : 'failed';
          if (execution.ok) toolExecution.output = execution.output;
          else toolExecution.error = execution.error.message;
          await emit('tool-result', toolExecution);

          current.push({
            role: "tool",
            toolCallId: call.id,
            toolName: call.toolId,
            content: JSON.stringify(
              execution.ok
                ? { ok: true, toolId: call.toolId, output: execution.output }
                : {
                    ok: false,
                    toolId: call.toolId,
                    error: execution.error,
                  },
            ),
          });
        }
        llmMessages = [...history, ...current];
        continue;
      }

      if (response.text?.trim()) {
        const finalText = response.text;
        current.push({ role: "assistant", content: finalText });
        const assistant = appendTextMessage(
          input.state,
          run.id,
          "assistant",
          finalText,
        );
        run.messageIds.push(assistant.id);
        await emit("message", assistant);
        run.status = "completed";
        run.endedAt = Date.now();
        await emit("run", run);
        return { state: input.state, run, finalResponse: finalText };
      }

      run.status = "failed";
      run.endedAt = Date.now();
      await emit("run", run);
      return {
        state: input.state,
        run,
        error: "Model returned neither tool calls nor a final response.",
      };
    }

    run.status = "failed";
    run.endedAt = Date.now();
    await emit("run", run);
    return {
      state: input.state,
      run,
      error: `Maximum iterations reached (${maxIterations}) before final response.`,
    };
  }
}
