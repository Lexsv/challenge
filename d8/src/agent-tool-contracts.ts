export type AgentExecutionStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "incomplete";

export interface BaseMessage {
  id: string;
  conversationId: string;
  runId: string;
  createdAt: number;
  role: "user" | "assistant" | "system";
}

export interface TextMessage extends BaseMessage {
  type: "text";
  text: string;
}

export interface Conversation {
  requestTokenLimit?: number;
  id: string;
  title?: string;
  messageIds: string[];
  runIds: string[];
  startedAt: number;
}

export interface AgentRun {
  id: string;
  conversationId: string;
  agentId: string;
  status: AgentExecutionStatus;
  startedAt: number;
  endedAt?: number;
  messageIds: string[];
  toolExecutionIds: string[];
}

export interface ToolExecution {
  id: string;
  runId: string;
  toolCallId?: string;
  toolId: string;
  status: AgentExecutionStatus;
  arguments: unknown;
  output?: unknown;
  error?: string;
  startedAt: number;
  endedAt?: number;
}
