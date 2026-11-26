import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { JSONRPCMessage, RequestId } from "@modelcontextprotocol/sdk/types.js";
import { elapsed, Logger } from "./logging.js";

const methods = new Set(["initialize", "notifications/initialized", "notifications/cancelled", "tools/list", "tools/call", "ping"]);
const tools = new Set(["get_weather", "save_weather", "read_weather_history"]);
type Operation = {method: string; tool?: string; invocationId: string; start: number};

export class ObservedTransport extends StreamableHTTPServerTransport {
  private readonly pending = new Map<RequestId, Operation>();
  constructor(private readonly log: Logger) {
    super({sessionIdGenerator: undefined, enableJsonResponse: true});
    this.onerror = () => log.write("transport.error", "failure", "MCP transport reported a protocol or delivery error.");
  }

  override async start() {
    const dispatch = this.onmessage!;
    this.onmessage = (message, extra) => {
      if (!("method" in message)) return dispatch(message, extra);
      const method = methods.has(message.method) ? message.method : "other";
      if (!("id" in message)) {
        this.log.write("mcp.notification.received", "success",
          method === "notifications/initialized" ? "Client acknowledged initialization." : "Received a client notification.", {method});
        return dispatch(message, extra);
      }
      const name = message.params?.name;
      const tool = method === "tools/call" ? (typeof name === "string" && tools.has(name) ? name : "unknown") : undefined;
      const invocationId = randomUUID();
      this.pending.set(message.id, {method, tool, invocationId, start: performance.now()});
      this.log.scope({method, tool, invocationId}, () => {
        this.log.write(tool ? "tool.started" : "mcp.request.started", "started",
          tool ? "Weather tool invocation started." : "Processing MCP request.");
        dispatch(message, extra);
      });
    };
    await super.start();
  }

  override async send(message: JSONRPCMessage, options?: {relatedRequestId?: RequestId}) {
    if (!("result" in message || "error" in message) || message.id === undefined) return super.send(message, options);
    const op = this.pending.get(message.id);
    if (!op) return super.send(message, options);
    this.pending.delete(message.id);
    const {method, tool, invocationId, start} = op;
    const fields = {method, tool, invocationId};
    try {
      await super.send(message, options);
    } catch (error) {
      this.log.write(tool ? "tool.finished" : "mcp.request.finished", "failure", "Could not send MCP response.",
        {...fields, durationMs: elapsed(start)});
      throw error;
    }
    const result = "result" in message ? message.result : undefined;
    const failed = "error" in message || result?.isError === true;
    const event = tool ? "tool.finished" : method === "initialize" ? "mcp.initialize" :
      method === "tools/list" ? "mcp.tools.list" : "mcp.request.finished";
    let description = tool ? "Weather tool completed." : "MCP request completed.";
    if (method === "initialize") description = "Returned server capabilities to client.";
    if (method === "tools/list") description = "Returned available tools.";
    if (failed) {
      description = tool ? "Tool execution failed. See correlated diagnostics." : "MCP request failed.";
      if (tool === "unknown") description = "Requested tool is not registered.";
      // SDK validation runs before our handlers. Classify its diagnostic without copying input or error text.
      const content = result?.content;
      if (tool && Array.isArray(content) && typeof content[0]?.text === "string" &&
          content[0].text.includes("Input validation error: Invalid arguments for tool "))
        description = "Tool input failed schema validation.";
    }
    this.log.write(event, failed ? "failure" : "success", description, {...fields,
      durationMs: elapsed(start), rpcErrorCode: "error" in message ? message.error.code : undefined,
      toolCount: method === "tools/list" && Array.isArray(result?.tools) ? result.tools.length : undefined});
  }

  override async close() {
    for (const op of this.pending.values()) {
      this.log.write(op.tool ? "tool.finished" : "mcp.request.finished", "interrupted", "Transport closed before reply.",
        {method: op.method, tool: op.tool, invocationId: op.invocationId, durationMs: elapsed(op.start)});
    }
    this.pending.clear();
    await super.close();
  }
}
