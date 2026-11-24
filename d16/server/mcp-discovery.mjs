import { sanitizedCapture, containsCredential, journalableMcpContent } from "./journal-payload.mjs";
export { containsCredential } from "./journal-payload.mjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import {
  ListToolsResultSchema,
  ResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { authenticatedFetch, McpProblem } from "./mcp-configuration.mjs";

const transports = {
  "streamable-http": (url, options) =>
    new StreamableHTTPClientTransport(url, options),
  sse: (url, options) => new SSEClientTransport(url, options),
};

export function mcpSession(
  config,
  values,
  { fetcher = fetch, connectMs = 10000 } = {},
) {
  const controller = new AbortController();
  const client = new Client({ name: "day16-catalog", version: "1.0.0" });
  const send = authenticatedFetch(config, values, controller.signal, fetcher);
  let networkError, authorize, observe, closing;
  const transport = transports[config.transport](new URL(config.endpoint), {
    reconnectionOptions: {
      maxRetries: 0,
      initialReconnectionDelay: 1000,
      maxReconnectionDelay: 1000,
      reconnectionDelayGrowFactor: 1,
    },
    fetch: async (input, init) => {
      try {
        if (
          init?.method === "POST" &&
          typeof init.body === "string" &&
          JSON.parse(init.body).method === "tools/call" &&
          !authorize?.()
        )
          throw new McpProblem("permission", 403);
        const rpc =
          init?.method === "POST" && typeof init.body === "string"
            ? JSON.parse(init.body)
            : null;
        const capture = rpc?.method === "tools/call" ? observe : undefined;
        if (capture) capture("request", sanitizedCapture(init.body, values));
        const response = await send(input, init);
        if (
          !capture ||
          !response.body ||
          !/^application\/json\b/i.test(
            response.headers.get("content-type") ?? "",
          )
        )
          return response;
        // Tap only this JSON response; SSE streams may carry unrelated messages.
        let length = 0;
        const chunks = [];
        const stream = response.body.pipeThrough(
          new TransformStream({
            transform(chunk, out) {
              length += chunk.byteLength;
              if (length <= 65536) chunks.push(chunk);
              out.enqueue(chunk);
            },
            flush() {
              if (length <= 65536)
                capture(
                  "response",
                  sanitizedCapture(
                    Buffer.concat(chunks).toString("utf8"),
                    values,
                    rpc => !Object.hasOwn(rpc ?? {}, "result") || journalableMcpContent(rpc.result),
                  ),
                );
            },
          }),
        );
        return new Response(stream, {
          headers: response.headers,
          status: response.status,
          statusText: response.statusText,
        });
      } catch (error) {
        networkError = error;
        throw error;
      }
    },
  });
  async function guarded(action, signal) {
    signal?.throwIfAborted();
    let rejectAbort;
    const aborted = new Promise((_, reject) => {
      rejectAbort = reject;
    });
    const abort = () => {
      controller.abort();
      rejectAbort(signal.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      networkError = undefined;
      return await Promise.race([action(), aborted]);
    } catch (error) {
      throw networkError ?? error;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }
  return {
    client,
    async open(signal) {
      const timeout = AbortSignal.timeout(connectMs);
      const combined = AbortSignal.any([timeout, ...(signal ? [signal] : [])]);
      try {
        await guarded(
          () =>
            client.connect(transport, { timeout: connectMs, signal: combined }),
          combined,
        );
        if (!client.getServerCapabilities()?.tools)
          throw new McpProblem("discovery");
      } catch (error) {
        if (combined.aborted) throw new McpProblem("timeout", 504);
        throw error;
      }
    },
    async call(name, args, signal, current, capture) {
      observe = capture;
      authorize = current;
      try {
        return await guarded(() => {
          if (!current()) throw new McpProblem("permission", 403);
          return client.callTool({ name, arguments: args }, ResultSchema, {
            signal,
            timeout: 2147483647,
          });
        }, signal);
      } finally {
        authorize = undefined;
        observe = undefined;
      }
    },
    lastError: () => networkError,
    close() {
      return (closing ??= (async () => {
        const timer = setTimeout(() => controller.abort(), 1000);
        try {
          if (transport.sessionId && transport.terminateSession)
            await transport.terminateSession();
        } catch {
          /* Unsupported termination or closed peer. */
        } finally {
          clearTimeout(timer);
          controller.abort();
          await client.close().catch(() => {});
        }
      })());
    },
  };
}

export async function discoverCatalog(
  config,
  values,
  { connectMs = 10000, discoveryMs = 20000, fetcher = fetch, signal } = {},
) {
  const session = mcpSession(config, values, { connectMs, fetcher });
  let stage = "protocol";
  try {
    await session.open(signal);
    stage = "discovery";
    const timeout = AbortSignal.timeout(discoveryMs);
    const discoverySignal = AbortSignal.any([
      timeout,
      ...(signal ? [signal] : []),
    ]);
    const { client } = session;
    const tools = [],
      names = new Set(),
      cursors = new Set();
    let cursor,
      bytes = 0;
    do {
      // Validate with the SDK but retain the original JSON, including extension metadata.
      const result = await client.request(
        { method: "tools/list", params: cursor ? { cursor } : {} },
        ResultSchema,
        { signal: discoverySignal, timeout: discoveryMs },
      );
      if (!ListToolsResultSchema.safeParse(result).success)
        throw new McpProblem("discovery");
      for (const tool of result.tools) {
        if (!tool.name || names.has(tool.name))
          throw new McpProblem("discovery");
        const json = JSON.stringify(tool);
        bytes += Buffer.byteLength(json);
        if (bytes > 8 * 1024 * 1024 || tools.length >= 10000)
          throw new McpProblem("discovery");
        if (containsCredential(tool, values)) throw new McpProblem("sensitive");
        names.add(tool.name);
        tools.push(tool);
      }
      cursor = result.nextCursor;
      if (
        cursor !== undefined &&
        (!cursor || cursors.has(cursor) || cursors.size >= 1000)
      )
        throw new McpProblem("discovery");
      cursors.add(cursor);
    } while (cursor !== undefined);
    return tools;
  } catch (error) {
    const failure = session.lastError() ?? error;
    if (
      signal?.aborted ||
      error?.code === -32001 ||
      error?.name === "TimeoutError" ||
      error?.name === "AbortError"
    )
      throw new McpProblem("timeout", 504);
    if (failure instanceof McpProblem) throw failure;
    throw new McpProblem(stage);
  } finally {
    await session.close();
  }
}
