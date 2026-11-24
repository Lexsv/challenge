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
  endpointConflict?: boolean;
  deletionPending?: boolean;
};
export type McpTool = {
  toolId: string;
  connectionId: string;
  originalName: string;
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
        ...(path.endsWith("/reveal") && {"X-Day16-UI":"settings"}),
        ...(path.endsWith("/execution-mode") && {"X-Day16-UI":"execution-mode"}),
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
