import { createServer } from "node:http";
import { once } from "node:events";

export const token = "fixture-value-7824";
export const tool = (name) => ({
  name,
  description: "Fixture lookup",
  inputSchema: {
    type: "object",
    properties: {
      filters: {
        type: "array",
        items: {
          type: "object",
          properties: { count: { type: "integer", minimum: 2 } },
        },
      },
    },
  },
  outputSchema: { type: "object", additionalProperties: false },
  annotations: { readOnlyHint: true },
  _meta: { revision: 2 },
  vendorExtension: { units: ["one", "two"] },
});
export async function start(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return "http://127.0.0.1:" + server.address().port;
}
export async function stop(server) {
  const closed = once(server, "close");
  server.close();
  server.closeAllConnections();
  await closed;
}
export async function remote(
  t,
  transport = "streamable-http",
  auth = { type: "none" },
) {
  const state = {
    pages: [[tool("search_items")], [tool("other")]],
    calls: [],
    status: 0,
    hang: null,
    repeat: false,
  };
  let stream;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const valid =
      auth.type === "none" ||
      (auth.type === "query" &&
        url.searchParams.get(auth.parameter) === token) ||
      (auth.type === "bearer" &&
        req.headers.authorization === "Bearer " + token) ||
      (auth.type === "headers" &&
        req.headers["x-first"] === token &&
        req.headers["x-second"] === "fixture-second");
    if (!valid || state.status) {
      res.writeHead(state.status || 401).end(token);
      return;
    }
    if (req.method === "GET") {
      if (transport !== "sse") {
        res.writeHead(405).end();
        return;
      }
      stream = res;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write("event: endpoint\ndata: /messages?session=123\n\n");
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    const msg = JSON.parse(body);
    state.calls.push(msg.method);
    if (state.hang === msg.method) return;
    let result;
    if (msg.method === "initialize")
      result = {
        protocolVersion: msg.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "fixture", version: "1" },
      };
    else if (msg.method === "notifications/initialized") {
      res.writeHead(202).end();
      return;
    } else if (msg.method === "tools/list") {
      const i = Number(msg.params?.cursor ?? 0);
      if (state.breakPage && i > 0) {
        res.writeHead(502).end(token);
        return;
      }
      result = {
        tools: state.pages[i] ?? [],
        ...(i + 1 < state.pages.length || state.repeat
          ? { nextCursor: state.repeat ? "1" : String(i + 1) }
          : {}),
      };
    } else if (msg.method === "tools/call" && state.execute) {
      const reply = await state.execute(msg.params);
      if (reply.drop) {
        req.socket.destroy();
        return;
      }
      if (reply.status) {
        res.writeHead(reply.status, reply.headers).end("fixture");
        return;
      }
      if (reply.rpcError) {
        res.writeHead(200, { "Content-Type": "application/json" }).end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            error: reply.rpcError,
          }),
        );
        return;
      }
      result = reply;
    } else {
      res.writeHead(400).end();
      return;
    }
    const data = JSON.stringify({ jsonrpc: "2.0", id: msg.id, result });
    if (transport === "sse") {
      res.writeHead(202).end();
      stream.write("event: message\ndata: " + data + "\n\n");
    } else res.writeHead(200, { "Content-Type": "application/json" }).end(data);
  });
  const endpoint = (await start(server)) + "/mcp";
  t.after(() => stop(server));
  return {
    state,
    endpoint,
    config: { name: "Fixture", description: "", endpoint, transport, auth },
  };
}
