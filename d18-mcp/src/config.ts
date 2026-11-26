import { isAbsolute } from "node:path";
import { isIPv4 } from "node:net";
import { z } from "zod";

const path = z.string().refine(isAbsolute);
const privateAddress = (value: string) => isIPv4(value) &&
  /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(value);
const env = z.object({
  MCP_HOST: z.string().default("127.0.0.1").refine(privateAddress),
  MCP_BIND_HOST: z.string().refine(v => v === "0.0.0.0" || privateAddress(v)).optional(),
  MCP_PORT: z.coerce.number().int().min(1).max(65535).default(3018),
  MCP_AUTH_TOKEN: z.string().min(32).max(512).regex(/^[A-Za-z0-9._~+\/=-]+$/),
  TLS_CERT_PATH: path, TLS_KEY_PATH: path, DATABASE_PATH: path,
  MCP_ALLOWED_ORIGINS: z.string().default(""),
  PROVIDER_TIMEOUT_MS: z.coerce.number().int().min(100).max(30000).default(8000),
});
export function config(input: NodeJS.ProcessEnv) {
  const parsed = env.safeParse(input);
  if (!parsed.success) throw new Error("Invalid configuration fields: " +
    parsed.error.issues.map(i => i.path.join(".")).join(", "));
  const c = parsed.data;
  const origins = c.MCP_ALLOWED_ORIGINS.split(",").map(o => o.trim()).filter(Boolean);
  if (!origins.every(o => {
    try {const u = new URL(o); return u.protocol === "https:" && u.origin === o;}
    catch {return false;}
  })) throw new Error("Invalid MCP_ALLOWED_ORIGINS.");
  return {...c, origins};
}
