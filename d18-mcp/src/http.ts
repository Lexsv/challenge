import { createServer, type ServerOptions } from "node:https";
import type { Socket } from "node:net";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { elapsed, Logger } from "./logging.js";
import { ObservedTransport } from "./observed-transport.js";

const digest = (value: string) => createHash("sha256").update(value).digest();
export function endpoint(tls: ServerOptions, authority: string, token: string, origins: string[],
  makeServer: () => McpServer, log: Logger) {
  const expected = digest(token);
  const connections = new WeakMap<Socket, string>();
  const listener = createServer({...tls, minVersion: "TLSv1.2", requestTimeout: 15000, headersTimeout: 10000});
  listener.on("secureConnection", socket => {
    const connectionId = randomUUID();
    connections.set(socket, connectionId);
    log.write("tls.connected", "success", "TLS connection established.", {connectionId});
    socket.once("close", hadError => log.write("tls.closed", hadError ? "interrupted" : "success",
      "TLS connection closed.", {connectionId, hadError}));
  });
  listener.on("tlsClientError", () => log.write("tls.handshake.failed", "failure", "TLS handshake failed."));
  listener.on("request", (req, res) => {
    const fields = {requestId: randomUUID(), connectionId: connections.get(req.socket)};
    const start = performance.now();
    res.setHeader("X-Request-Id", fields.requestId);
    res.once("close", () => {
      const complete = res.writableFinished;
      log.write("http.finished", complete ? (res.statusCode < 400 ? "success" : "failure") : "interrupted",
        complete ? "HTTP response finished." : "Connection closed before the response finished.",
        {...fields, httpStatus: complete ? res.statusCode : undefined, durationMs: elapsed(start)});
    });
    void log.scope(fields, async () => {
      log.write("http.received", "started", "Received an HTTPS request.",
        {verb: ["POST","GET","DELETE","OPTIONS"].includes(req.method ?? "") ? req.method : "other"});
      const reject = (status: number, message: string) => {
        log.write(status === 401 ? "auth.rejected" : "http.rejected", "failure", message, {httpStatus: status});
        res.writeHead(status).end();
      };
      if (req.headers.host !== authority) return reject(403, "Host check failed.");
      if (req.url !== "/mcp") return reject(404, "Unknown endpoint.");
      const match = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization ?? "");
      if (!match?.[1] || !timingSafeEqual(digest(match[1]), expected)) {
        res.setHeader("WWW-Authenticate", 'Bearer realm="d18-mcp"');
        return reject(401, "Bearer authentication failed.");
      }
      log.write("auth.accepted", "success", "Bearer authentication succeeded.");
      if (req.headers.origin !== undefined && !origins.includes(req.headers.origin)) return reject(403, "Origin check failed.");
      if (req.method !== "POST") {
        res.setHeader("Allow", "POST"); return reject(405, "Endpoint requires POST.");
      }
      if (req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json")
        return reject(415, "Expected JSON content type.");
      let size = 0;
      const chunks: Buffer[] = [];
      try {
        for await (const chunk of req.iterator({destroyOnReturn: false})) {
          size += chunk.length;
          if (size > 65536) { res.setHeader("Connection","close"); return reject(413, "Request exceeded size limit."); }
          chunks.push(chunk);
        }
        let body: unknown;
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
        catch { return reject(400, "Invalid JSON."); }
        const server = makeServer();
        const transport = new ObservedTransport(log);
        res.once("close", () => log.scope(fields, () => {
          void server.close().catch(() => log.write("transport.error", "failure", "Could not close request transport."));
        }));
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
      } catch {
        log.write("transport.error", "failure", "Could not process or deliver the HTTP exchange.");
        if (!res.headersSent && !res.destroyed) res.writeHead(500).end();
        else if (!res.writableEnded) res.destroy();
      }
    });
  });
  return listener;
}
