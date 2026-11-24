import { McpProblem } from "./mcp-configuration.mjs";

// Same-origin JSON requests only. Older browsers and some local proxies omit
// Fetch Metadata. A custom header requires a CORS preflight across origins;
// this local server grants no CORS access. Never trust forwarded host headers.
export function localUiRequest(req, action) {
  const {origin, host, "sec-fetch-site":site} = req.headers;
  return /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host ?? "") &&
    ["127.0.0.1","::1","::ffff:127.0.0.1"].includes(req.socket.remoteAddress) &&
    (!origin || origin === "http://" + host) && (!site || site === "same-origin") &&
    ((site === "same-origin" && origin) || req.headers["x-day16-ui"] === action);
}

export async function readConfig(req) {
  if (!req.headers["content-type"]?.startsWith("application/json"))
    throw new McpProblem("invalid", 415);
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    if ((bytes += chunk.length) > 98304) throw new McpProblem("invalid", 413);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    throw new McpProblem("invalid", 400);
  }
}

export function createMcpRoutes(manager) {
  return async function route(req, path, reply) {
    const match = path.match(
      /^\/api\/mcp-connections(?:\/([a-f0-9-]{36})(\/refresh|\/reveal|\/execution-mode)?)?$/,
    );
    if (!match) return false;
    const [, id, action] = match;
    try {
      if (action === "/execution-mode") {
        if (!localUiRequest(req, "execution-mode") || req.headers["x-day16-ui"] !== "execution-mode")
          throw new McpProblem("permission", 403);
        if (req.method === "GET") reply(200, manager.executionMode(id));
        else if (req.method === "PUT" && req.headers.origin === "http://" + req.headers.host)
          reply(200, manager.saveExecutionMode(id, await readConfig(req)));
        else throw new McpProblem("permission", 403);
      } else if (action === "/reveal") {
        // A deliberate settings interaction on the single-user loopback UI.
        if (req.method !== "POST" || !localUiRequest(req, "settings"))
          throw new McpProblem("permission", 403);
        const body = await readConfig(req);
        if (
          !Number.isSafeInteger(body?.revision) ||
          typeof body?.key !== "string"
        )
          throw new McpProblem("invalid", 400);
        reply(200, await manager.reveal(id, body.revision, body.key));
      } else if (req.method === "GET" && !action)
        reply(200, id ? manager.catalog(id) : manager.list());
      else if (req.method === "DELETE" && id && !action) {
        const body = await readConfig(req);
        if (
          !body ||
          Object.keys(body).length !== 1 ||
          !Number.isSafeInteger(body.revision) ||
          body.revision < 1
        )
          throw new McpProblem("invalid", 400);
        reply(200, await manager.remove(id, body.revision));
      } else if (
        (req.method === "POST" && (!id || action)) ||
        (req.method === "PUT" && id && !action)
      ) {
        const result = action
          ? await manager.refresh(id)
          : await manager.save(id, await readConfig(req));
        reply(id ? 200 : 201, result);
      } else reply(405, { error: "Method not allowed." });
    } catch (error) {
      const issue =
        error instanceof McpProblem ? error : new McpProblem("unknown", 500);
      reply(issue.status, { code: issue.code, error: issue.message });
    }
    return true;
  };
}
