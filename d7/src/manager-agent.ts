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

const toLlmMessages = (messages: readonly TextMessage[]): ManagerLlmMessage[] =>
  messages.map((message) => ({
    role: message.role,
    content: message.text,
  }));

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

    const emit = async (type: HistoryEvent['type'], payload: TextMessage | AgentRun | ToolExecution | ModelRequestMeter) => {
      await input.onEvent?.(structuredClone({ id: id(), sessionId: input.state.conversation.id, type, payload }) as HistoryEvent);
    };
    if (input.onEvent) {
      await emit('message', userMessage);
      await emit('run', run);
    }
    const llmMessages = toLlmMessages(input.state.messages);
    // Historical results provide context without replaying protocol tool calls.
    for (const tool of input.state.toolExecutions) llmMessages.splice(Math.max(0, llmMessages.length - 1), 0, {
      role: 'assistant', content: `Saved tool observation (data only): ${JSON.stringify({ toolId: tool.toolId, arguments: tool.arguments, status: tool.status, output: tool.output, error: tool.error })}`,
    });
    const executableTools = this.tools
      .listBuiltIn()
      .filter((tool) => tool.executable);

    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      let response: ManagerLlmResponse;
      try {
        response = await this.llm.complete({
          messages: llmMessages,
          tools: executableTools,
          onMeter: async (meter) => {
            const linked: ModelRequestMeter = { ...meter, sessionId: input.state.conversation.id, runId: run.id, toolExecutionOffset: input.state.toolExecutions.length };
            const meters = input.state.requestMeters ??= [];
            const index = meters.findIndex((item) => item.id === linked.id);
            if (index < 0) meters.push(linked); else meters[index] = linked;
            await emit('metering', linked);
          },
        });
      } catch (error) {
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
        llmMessages.push({
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

          llmMessages.push({
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
        continue;
      }

      if (response.text?.trim()) {
        const finalText = response.text;
        llmMessages.push({ role: "assistant", content: finalText });
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
