import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { ILogger } from "../../application/ports/logger.js";
import type { DomainEvent } from "../../domain/task.js";
import { logMcpMessage } from "./server.js";
import { taskStatusUri } from "./task-resource.js";

interface Session {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  subscriptions: Set<string>;
  connections: number;
  expiry?: NodeJS.Timeout;
}

export class McpSessions {
  private readonly sessions = new Map<string, Session>();
  private closing = false;

  constructor(private createServer: (subscriptions: Set<string>) => McpServer,
    private logger: ILogger, private idleMs: number) {}

  private open(): Session {
    const id = randomUUID();
    const subscriptions = new Set<string>();
    const server = this.createServer(subscriptions);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => id, enableJsonResponse: true });
    const session: Session = { server, transport, subscriptions, connections: 0 };
    transport.onmessage = message => logMcpMessage(this.logger, message);
    transport.onclose = () => {
      this.sessions.delete(id);
      subscriptions.clear();
      clearTimeout(session.expiry);
    };
    this.sessions.set(id, session);
    return session;
  }

  async handle(req: IncomingMessage, res: ServerResponse) {
    if (this.closing) { res.writeHead(503).end(); return; }
    const id = req.headers["mcp-session-id"];
    const initialize = id === undefined && req.method === "POST";
    const session = initialize ? this.open() : typeof id === "string" && this.sessions.get(id);
    if (!session) {
      const missing = id === undefined;
      res.writeHead(missing ? 400 : 404, { "Content-Type": "application/json" }).end(JSON.stringify({
        jsonrpc: "2.0", id: null, error: { code: missing ? -32000 : -32001,
          message: missing ? "Mcp-Session-Id required" : "Session not found" }
      }));
      return;
    }

    clearTimeout(session.expiry);
    session.connections++;
    res.once("close", () => {
      session.connections--;
      const key = session.transport.sessionId;
      if (!key) { void session.server.close(); return; }
      if (!session.connections && this.sessions.has(key)) {
        session.expiry = setTimeout(() => { void session.server.close(); }, this.idleMs).unref();
      }
    });
    if (initialize) await session.server.connect(session.transport);
    await session.transport.handleRequest(req, res);
  }

  publish(event: DomainEvent) {
    if (event.kind !== "task.finished") return;
    for (const { subscriptions, server } of this.sessions.values()) {
      if (!subscriptions.has(event.taskId)) continue;
      void server.server.sendResourceUpdated({ uri: taskStatusUri(event.taskId) }).catch(() => {
        this.logger.write("warn", "resource.notification_failed", { taskId: event.taskId });
      });
    }
  }

  async close() {
    this.closing = true;
    await Promise.all(Array.from(this.sessions.values(), session => session.server.close()));
  }
}
