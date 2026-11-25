import type { ITokenValidator } from "./token-validator.js";
import type { RequestListener } from "node:http";
import type { Config } from "../../config/config.js";
import type { ILogger } from "../../application/ports/logger.js";
import type { McpSessions } from "./sessions.js";

type HttpSettings = Pick<Config, "authority" | "origin" | "origins">;

export function mcpHandler(config: HttpSettings, sessions: McpSessions, tokens: ITokenValidator, logger: ILogger): RequestListener {
  const hosts = [config.authority, new URL(config.origin).host];
  return async (req, res) => {
    if (req.url !== "/mcp") { res.writeHead(404).end(); return; }
    logger.write("info", "http.request");
    res.once("finish", () => logger.write("info", "http.response", { statusCode: res.statusCode }));
    if (!hosts.includes(req.headers.host ?? "")) {
      logger.write("warn", "http.rejected", { reason: "invalid_host" });
      res.writeHead(403).end(); return;
    }
    const origin = req.headers.origin;
    const preflight = req.method === "OPTIONS" && origin !== undefined &&
      ["GET", "POST", "DELETE"].includes(String(req.headers["access-control-request-method"]));
    if (!preflight) {
      const token = /^Bearer +([^\s]+)$/i.exec(req.headers.authorization ?? "")?.[1];
      if (!token || !tokens.accepts(token)) {
        logger.write("warn", "auth.result", { outcome: "rejected" });
        res.writeHead(401, { "WWW-Authenticate": "Bearer" }).end(); return;
      }
      logger.write("info", "auth.result", { outcome: "accepted" });
    }
    if (origin !== undefined) {
      if (!config.origins.includes(origin)) {
        logger.write("warn", "http.rejected", { reason: "invalid_origin" });
        res.writeHead(403).end(); return;
      }
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id, X-Request-Id");
    }
    if (preflight) {
      logger.write("info", "auth.result", { outcome: "preflight" });
      res.writeHead(204, {
        "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, MCP-Protocol-Version, Mcp-Session-Id, Last-Event-ID"
      }).end();
      return;
    }
    if (!["GET", "POST", "DELETE"].includes(req.method ?? "")) {
      res.writeHead(405, { Allow: "GET, POST, DELETE, OPTIONS" }).end(); return;
    }
    try {
      await sessions.handle(req, res);
    } catch {
      logger.write("error", "http.failed", { reason: "transport_error" });
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  };
}
