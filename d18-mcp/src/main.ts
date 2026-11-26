import { Logger } from "./logging.js";
import { readFileSync } from "node:fs";
import { config } from "./config.js";
import { endpoint } from "./http.js";
import { weatherServer } from "./mcp.js";
import { OpenMeteo } from "./provider.js";
import { WeatherStore } from "./repository.js";

process.umask(0o077);
const cfg = config(process.env);
const tls = {cert: readFileSync(cfg.TLS_CERT_PATH), key: readFileSync(cfg.TLS_KEY_PATH)};
const log = new Logger();
function openStore() {
  try { return new WeatherStore(cfg.DATABASE_PATH); }
  catch {
    log.write("sqlite.open.failed", "failure", "Could not initialize weather storage.");
    process.exit(1);
  }
}
const store = openStore();
const provider = new OpenMeteo(cfg.PROVIDER_TIMEOUT_MS, fetch, log);
const authority = new URL(`https://${cfg.MCP_HOST}:${cfg.MCP_PORT}`).host;
const server = endpoint(tls, authority, cfg.MCP_AUTH_TOKEN, cfg.origins, () => weatherServer(provider, store, log), log);
server.listen(cfg.MCP_PORT, cfg.MCP_BIND_HOST ?? cfg.MCP_HOST, () => {
  log.write("listening", "success", "Weather MCP is listening.", {endpoint: `https://${authority}/mcp`});
});
function shutdown() {
  server.close(() => store.close());
}
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
