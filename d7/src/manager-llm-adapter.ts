import type { ProviderRegistry } from "./provider-registry";
import { consoleTransportUrl } from "./opencode-console-transport";
import type {
  ManagerLlmAdapter,
  ManagerLlmMessage,
  ManagerLlmResponse,
  ManagerToolCall,
} from "./manager-agent";
import type { ToolCatalogItem } from "./tool-runtime";

type ProviderId = "openai" | "opencode-console" | "opencode-go";

type FunctionToolSchema = {
  type: "function";
  name: string;
  description: string;
  parameters: unknown;
};

const FUNCTION_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

export type ProviderToolNameMap = {
  idToName: Map<string, string>;
  nameToId: Map<string, string>;
};

function toProviderFunctionName(toolId: string): string {
  const normalized = toolId
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (FUNCTION_NAME_PATTERN.test(normalized) && normalized) return normalized;
  return "tool";
}

export function buildProviderToolNameMap(
  tools: readonly ToolCatalogItem[],
): ProviderToolNameMap {
  const idToName = new Map<string, string>();
  const nameToId = new Map<string, string>();
  const used = new Set<string>();
  for (const tool of tools) {
    if (!tool.executable || !tool.inputSchema) continue;
    const base = FUNCTION_NAME_PATTERN.test(tool.id)
      ? tool.id
      : toProviderFunctionName(tool.id);
    let candidate = base;
    let index = 2;
    while (used.has(candidate)) {
      candidate = `${base}_${index}`;
      index += 1;
    }
    used.add(candidate);
    idToName.set(tool.id, candidate);
    nameToId.set(candidate, tool.id);
  }
  return { idToName, nameToId };
}

function mapToolIdToProviderName(
  toolId: string,
  map?: ProviderToolNameMap,
): string {
  return map?.idToName.get(toolId) ?? toolId;
}

function mapProviderNameToToolId(
  providerName: string,
  map?: ProviderToolNameMap,
): string {
  return map?.nameToId.get(providerName) ?? providerName;
}

function toolSchemas(
  tools: readonly ToolCatalogItem[],
  map?: ProviderToolNameMap,
): FunctionToolSchema[] {
  return tools
    .filter((tool) => tool.executable && tool.inputSchema)
    .map((tool) => ({
      type: "function",
      name: mapToolIdToProviderName(tool.id, map),
      description: tool.description,
      parameters: tool.inputSchema,
    }));
}

function tryParseArguments(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function asToolCalls(value: unknown, map?: ProviderToolNameMap): ManagerToolCall[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const toolCall = item as {
        id?: unknown;
        name?: unknown;
        arguments?: unknown;
        function?: { name?: unknown; arguments?: unknown };
      };
      const id =
        typeof toolCall.id === "string" && toolCall.id
          ? toolCall.id
          : crypto.randomUUID();
      const toolId =
        typeof toolCall.name === "string"
          ? mapProviderNameToToolId(toolCall.name, map)
          : typeof toolCall.function?.name === "string"
            ? mapProviderNameToToolId(toolCall.function.name, map)
            : "";
      if (!toolId) return null;
      const args =
        toolCall.arguments ?? toolCall.function?.arguments ?? ({} as unknown);
      return {
        id,
        toolId,
        arguments: tryParseArguments(args),
      };
    })
    .filter((item): item is ManagerToolCall => !!item);
}

export function toOpenAIResponsesInput(
  messages: readonly ManagerLlmMessage[],
  map?: ProviderToolNameMap,
) {
  const input: unknown[] = [];
  for (const message of messages) {
    if (message.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: message.toolCallId,
        output: message.content,
      });
      continue;
    }
    if (message.role === "assistant" && message.toolCalls?.length) {
      if (message.content?.trim()) {
        input.push({ role: "assistant", content: message.content });
      }
      for (const toolCall of message.toolCalls) {
        input.push({
          type: "function_call",
          call_id: toolCall.id,
          name: mapToolIdToProviderName(toolCall.toolId, map),
          arguments: JSON.stringify(toolCall.arguments ?? {}),
        });
      }
      continue;
    }
    input.push({ role: message.role, content: message.content });
  }
  return input;
}

export function parseOpenAIResponses(
  payload: unknown,
  map?: ProviderToolNameMap,
): ManagerLlmResponse {
  if (!payload || typeof payload !== "object") return {};
  const data = payload as { output?: unknown };
  const output = Array.isArray(data.output) ? data.output : [];
  const text = output
    .filter(
      (entry) =>
        entry && typeof entry === "object" && (entry as { type?: unknown }).type === "message",
    )
    .flatMap((entry) => {
      const content = (entry as { content?: unknown }).content;
      return Array.isArray(content) ? content : [];
    })
    .filter(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        (entry as { type?: unknown }).type === "output_text" &&
        typeof (entry as { text?: unknown }).text === "string",
    )
    .map((entry) => (entry as { text: string }).text)
    .join("\n");

  const toolCalls = asToolCalls(
    output
      .filter(
        (entry) =>
          entry &&
          typeof entry === "object" &&
          (entry as { type?: unknown }).type === "function_call",
      )
      .map((entry) => ({
        id: (entry as { call_id?: unknown }).call_id,
        name: (entry as { name?: unknown }).name,
        arguments: (entry as { arguments?: unknown }).arguments,
      })),
    map,
  );

  return {
    ...(text ? { text } : {}),
    ...(toolCalls.length ? { toolCalls } : {}),
  };
}

export function toOpenAIChatMessages(
  messages: readonly ManagerLlmMessage[],
  map?: ProviderToolNameMap,
) {
  const mapped: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    if (message.role === "tool") {
      mapped.push({
        role: "tool",
        tool_call_id: message.toolCallId,
        content: message.content,
        ...(message.toolName
          ? { name: mapToolIdToProviderName(message.toolName, map) }
          : {}),
      });
      continue;
    }
    if (message.role === "assistant" && message.toolCalls?.length) {
      mapped.push({
        role: "assistant",
        content: message.content || "",
        tool_calls: message.toolCalls.map((call) => ({
            id: call.id,
            type: "function",
            function: {
              name: mapToolIdToProviderName(call.toolId, map),
              arguments: JSON.stringify(call.arguments ?? {}),
            },
        })),
      });
      continue;
    }
    mapped.push({ role: message.role, content: message.content });
  }
  return mapped;
}

export function parseOpenAIChatCompletions(
  payload: unknown,
  map?: ProviderToolNameMap,
): ManagerLlmResponse {
  if (!payload || typeof payload !== "object") return {};
  const choices = (payload as { choices?: unknown }).choices;
  const first = Array.isArray(choices) ? choices[0] : undefined;
  const message =
    first && typeof first === "object"
      ? (first as { message?: unknown }).message
      : undefined;
  if (!message || typeof message !== "object") return {};
  const content =
    typeof (message as { content?: unknown }).content === "string"
      ? (message as { content: string }).content
      : "";
  const toolCalls = asToolCalls(
    (message as { tool_calls?: unknown }).tool_calls,
    map,
  );
  return {
    ...(content.trim() ? { text: content } : {}),
    ...(toolCalls.length ? { toolCalls } : {}),
  };
}

export function createManagerLlmAdapter(input: {
  providerId: ProviderId;
  model: string;
  apiKey: string;
  useSavedKey?: boolean;
  registry: ProviderRegistry;
  fetcher?: typeof fetch;
}): ManagerLlmAdapter {
  const fetcher = input.fetcher ?? fetch;
  const endpoint = input.registry.endpointFor(input.providerId);
  if (!endpoint) {
    throw new Error(`Endpoint is not configured for provider: ${input.providerId}`);
  }

  const providerFetch = async (body: unknown, target: string) => {
    if (input.useSavedKey) {
      return fetcher(`/api/credentials/${input.providerId}/request`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
    }
    return fetcher(target, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${input.apiKey}` }, body: JSON.stringify(body),
    });
  };

  const executeOpenAI = async (payload: { messages: readonly ManagerLlmMessage[]; tools: readonly ToolCatalogItem[]; }) => {
    const nameMap = buildProviderToolNameMap(payload.tools);
    const body = {
      model: input.model,
      store: false,
      input: toOpenAIResponsesInput(payload.messages, nameMap),
      tools: toolSchemas(payload.tools, nameMap),
      tool_choice: "auto",
    };
    const response = await providerFetch(body, endpoint);
    if (!response.ok) {
      throw new Error(`OpenAI manager request failed (${response.status}).`);
    }
    return parseOpenAIResponses(await response.json(), nameMap);
  };

  const executeOpenCode = async (payload: { messages: readonly ManagerLlmMessage[]; tools: readonly ToolCatalogItem[]; }) => {
    const nameMap = buildProviderToolNameMap(payload.tools);
    const body = {
      model: input.model,
      messages: toOpenAIChatMessages(payload.messages, nameMap),
      tools: toolSchemas(payload.tools, nameMap),
      tool_choice: "auto",
    };
    const response = await providerFetch(body, consoleTransportUrl(endpoint));
    if (!response.ok) {
      throw new Error(`OpenCode manager request failed (${response.status}).`);
    }
    return parseOpenAIChatCompletions(await response.json(), nameMap);
  };

  return {
    complete: async ({ messages, tools }) => {
      if (!input.useSavedKey && !input.apiKey.trim()) {
        throw new Error("Provider API key is missing.");
      }
      if (input.providerId === "openai") return executeOpenAI({ messages, tools });
      return executeOpenCode({ messages, tools });
    },
  };
}
