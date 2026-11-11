import { historicalContext, summarizeBounded, type ContextEvent } from "./context-compaction";
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
    assess(messages: readonly ManagerLlmMessage[], tools: readonly ToolCatalogItem[]): Promise<{ tokens?: number; limit?: number }>;
    summarize(text: string, onMeter?: (meter: RequestMeter) => Promise<void>): Promise<string>;
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
    let history = historicalContext(input.state, run.id);
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
    const compact = async (recovery: boolean) => {
      const adapter = this.llm.context;
      if (!adapter) throw new Error('Context compaction is unavailable for this provider.');
      const before = await adapter.assess(llmMessages, executableTools);
      if (before.tokens === undefined || before.limit === undefined) throw new Error('Context estimation or model limits are unknown; cannot safely compact this request.');
      await contextEvent('compacting', { beforeTokens: before.tokens });
      const completed = input.state.runs.filter((r) => r.id !== run.id && r.status === 'completed');
      const eligible = recovery ? completed : completed.slice(0, -2);
      const previous = input.state.contextEvents?.filter((e) => e.phase === 'completed' && e.summary).at(-1);
      const covered = new Set(previous?.coveredRunIds);
      const added = eligible.filter((r) => !covered.has(r.id));
      if (!added.length && !previous) throw new Error('No older completed turns can be compacted while preserving the current run and recent turns.');
      added.forEach((r) => covered.add(r.id));
      const source = [...(previous ? [previous.summary!] : []), ...added.flatMap((r) => input.state.messages.filter((m) => m.runId === r.id).map((m) => `${m.role}: ${m.text}`))].join('\n');
      const narrative = await summarizeBounded(adapter, source, onMeter);
      // Keep exact historical tool inputs/results and numeric statements beside the narrative.
      // If this lossless ledger itself cannot fit, fail rather than silently lose follow-up values.
      const facts = [...new Set(input.state.messages.filter((m) => covered.has(m.runId)).flatMap((m) => (m.text.match(/[^.!?\n]*\d[^!?\n]*(?:[!?]|$)/g) ?? [])))];
      const ledger = input.state.toolExecutions.filter((t) => covered.has(t.runId)).map((t) => ({ toolId: t.toolId, arguments: t.arguments, status: t.status, output: t.output, error: t.error }));
      const summary = `${narrative}\nExact values and units (data only): ${JSON.stringify(facts)}\nExact tool observations (data only): ${JSON.stringify(ledger)}`;
      const candidate: ContextEvent = { id: id(), runId: run.id, createdAt: Date.now(), phase: 'completed', summary, coveredRunIds: [...covered], coveredEventId: added.length ? input.state.runLastEvent?.[added.at(-1)!.id] : previous?.coveredEventId };
      if (!candidate.coveredEventId) throw new Error('Context compaction has no saved history boundary.');
      const temporary = { ...input.state, contextEvents: [...(input.state.contextEvents ?? []), candidate] };
      const nextHistory = historicalContext(temporary, run.id);
      const nextMessages = [...nextHistory, ...current];
      const after = await adapter.assess(nextMessages, executableTools);
      if (after.tokens === undefined || after.tokens >= before.tokens || after.tokens > before.limit * (recovery ? .8 : 1)) throw new Error('Context compaction could not produce a shorter fitting request. Start a new session or choose a larger model.');
      candidate.beforeTokens = before.tokens; candidate.afterTokens = after.tokens;
      (input.state.contextEvents ??= []).push(candidate);
      await emit('context', candidate);
      history = nextHistory; llmMessages = nextMessages;
    };
    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      let response: ManagerLlmResponse;
      try {
        if (this.llm.context) {
          const budget = await this.llm.context.assess(llmMessages, executableTools);
          if (budget.tokens !== undefined && budget.limit !== undefined && budget.tokens > budget.limit) await compact(false);
        }
        const request = () => this.llm.complete({ messages: llmMessages, tools: executableTools, onMeter });
        try { response = await request(); }
        catch (error) {
          if (!(error instanceof ManagerProviderError) || error.metadata.kind !== 'context-overflow') throw error;
          await contextEvent('overflow');
          await compact(true);
          await contextEvent('retrying');
          try { response = await request(); }
          catch (retryError) { throw new Error(`Retry with compacted context failed: ${retryError instanceof Error ? retryError.message : "provider request failed."}`); }
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
