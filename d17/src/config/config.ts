import { isIP } from "node:net";
import { resolve } from "node:path";

import { logLevels, type LogLevel } from "../application/ports/logger.js";

export function integer(name: string, raw: string, max: number) {
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < 1 || n > max) {
    throw new Error(name + " must be an integer between 1 and " + max);
  }
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv) {
  const host = env.SERVER_HOST ?? "127.0.0.1";
  if (host !== "localhost" && !isIP(host)) throw new Error("SERVER_HOST must be localhost or an IP address");
  const local = ["127.0.0.1", "::1", "localhost"].includes(host);
  const port = integer("SERVER_PORT", env.SERVER_PORT ?? "3000", 65535);
  const pollInterval = integer("POLL_INTERVAL_MS", env.POLL_INTERVAL_MS ?? "1000", 2147483647);
  const sessionIdleMs = integer("SESSION_IDLE_MS", env.SESSION_IDLE_MS ?? "900000", 2147483647);
  const timezone = env.DEFAULT_TIMEZONE ?? "UTC";
  if (!timezone.trim()) throw new Error("DEFAULT_TIMEZONE is empty");
  new Intl.DateTimeFormat("en", { timeZone: timezone });
  const level = (env.LOG_LEVEL ?? "info") as LogLevel;
  if (!logLevels.includes(level)) throw new Error("Invalid LOG_LEVEL");
  const database = env.DATABASE_PATH ?? "./data/tasks.sqlite";
  if (!database.trim() || database.includes("\0")) throw new Error("Invalid DATABASE_PATH");

  const token = env.MCP_AUTH_TOKEN;
  if (!token || !/^[A-Za-z0-9._~+\/-]{32,}={0,2}$/.test(token)) {
    throw new Error("MCP_AUTH_TOKEN requires at least 32 bearer-token characters");
  }
  const origins = (env.ALLOWED_ORIGINS ?? "").split(",").map(s => s.trim()).filter(Boolean);
  for (const origin of origins) {
    const url = new URL(origin);
    if (url.origin !== origin || !["http:", "https:"].includes(url.protocol) ||
        (!local && url.protocol !== "https:")) throw new Error("Invalid allowed origin");
  }
  const tlsCert = env.TLS_CERT_PATH;
  const tlsKey = env.TLS_KEY_PATH;
  if (Boolean(tlsCert) !== Boolean(tlsKey)) throw new Error("Configure both TLS files");
  if (!local && (!tlsCert || !origins.length)) {
    throw new Error("LAN binding requires MCP_AUTH_TOKEN, TLS files and ALLOWED_ORIGINS");
  }
  if (["0.0.0.0", "::"].includes(host)) throw new Error("Bind a specific interface address");
  const hostname = isIP(host) === 6 ? "[" + host + "]" : host;
  const authority = hostname + ":" + port;
  const origin = new URL((tlsCert ? "https://" : "http://") + authority).origin;
  return { host, port, sessionIdleMs, database: resolve(database), pollInterval, timezone, level, token,
    origins: origins.length ? origins : [origin], authority, origin, tlsCert, tlsKey };
}
export type Config = ReturnType<typeof loadConfig>;
