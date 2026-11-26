import type { ParameterAuth } from "./mcp-parameters";
export type McpAuth = ParameterAuth;
export type McpConfig = {
  name: string;
  description: string;
  endpoint: string;
  transport: "streamable-http" | "sse";
  auth: McpAuth;
};
export type McpConnection = McpConfig & {
  connectionId: string;
  revision: number;
  lastSuccess: number | null;
  stale: boolean;
  error: string | null;
  toolCount: number;
  capabilities?: {subscribe:boolean} | null;
  sseActive?: boolean;
  resourceError?: string | null;
  watchToolCount?: number;
  sseObserved?: boolean|null;
  linkToolCount?: number;
  watchEnabled?: boolean;
  endpointConflict?: boolean;
  deletionPending?: boolean;
};
export type McpTool = {
  toolId: string;
  connectionId: string;
  originalName: string;
  watchAttachedChats?: boolean;
  resourceLinksObserved?: boolean;
  watchEnabled?: boolean;
  document: Record<string, unknown> & {
    description?: string;
    inputSchema: unknown;
    outputSchema?: unknown;
  };
};
export type McpCatalog = { connection: McpConnection; tools: McpTool[] };

export async function mcpRequest<T>(
  path = "",
  method = "GET",
  body?: unknown,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch("/api/mcp-connections" + path, {
      method,
      cache: "no-store",
      headers: {
        ...(body !== undefined && {"Content-Type":"application/json"}),
        ...((path.endsWith("/watch-policy") || path.endsWith("/reveal") || (method === "DELETE" && path.includes("/tools/"))) && {"X-Day18-UI":"settings"}),
        ...(path.endsWith("/execution-mode") && {"X-Day18-UI":"execution-mode"}),
      },
      ...(body !== undefined && {body:JSON.stringify(body)}),
    });
  } catch {
    throw Error(
      "The application server is unavailable. Reopen the saved list before retrying.",
    );
  }
  const value = await response.json().catch(() => null);
  if (!response.ok || value === null)
    throw Error(
      value?.code && typeof value.error === "string"
        ? value.error
        : "The connection request could not be confirmed.",
    );
  return value;
}

// The tools screens read local metadata only. Poll while visible so stream
// closure and new tool observations are reflected without remote discovery.
export function observeMcpSnapshot<T>(path: string, receive: (value: T) => void, failed: (error: Error) => void) {
  let active = true;
  let reading = false;
  const refresh = async () => {
    if (document.hidden || reading) return;
    reading = true;
    try {
      const value = await mcpRequest<T>(path);
      if (active) receive(value);
    } catch (error) {
      if (active && error instanceof Error) failed(error);
    } finally {
      reading = false;
    }
  };
  void refresh();
  const timer = window.setInterval(refresh, 5000);
  document.addEventListener("visibilitychange", refresh);
  return () => {
    active = false;
    window.clearInterval(timer);
    document.removeEventListener("visibilitychange", refresh);
  };
}
