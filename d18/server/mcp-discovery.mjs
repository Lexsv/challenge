import { sanitizedCapture, containsCredential, journalableMcpContent, safeResourceUri } from "./journal-payload.mjs";
export { containsCredential } from "./journal-payload.mjs";
import { safeToolObservation } from "../src/execution-policy.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import {
  ListToolsResultSchema,
  ListResourcesResultSchema,
  ResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { authenticatedFetch, McpProblem } from "./mcp-configuration.mjs";

import { connectionTlsPool } from "./mcp-tls.mjs";

const transports = {
  "streamable-http": (url, options) =>
    new StreamableHTTPClientTransport(url, options),
  sse: (url, options) => new SSEClientTransport(url, options),
};

export function mcpSession(
  config,
  values,
  { fetcher = fetch, connectMs = 10000, resourceAccess, observeSse, openSse, tlsDirectory } = {},
) {
  const controller = new AbortController();
  const client = new Client({ name: "day18-catalog", version: "1.0.0" });
  const pool = connectionTlsPool(config, tlsDirectory);
  const send = authenticatedFetch(config, values, controller.signal,
    pool ? (url, init) => fetcher(url, {...init, dispatcher: pool}) : fetcher);
  let networkError, authorize, observe, markCallDispatch, closing, pushUnavailable = false;
  const transport = transports[config.transport](new URL(config.endpoint), {
    reconnectionOptions: {
      maxRetries: 0,
      initialReconnectionDelay: 1000,
      maxReconnectionDelay: 1000,
      reconnectionDelayGrowFactor: 1,
    },
    fetch: async (input, init) => {
      try {
        const rpc =
          init?.method === "POST" && typeof init.body === "string"
            ? JSON.parse(init.body)
            : null;
        if (rpc?.method === "tools/call" && !authorize?.())
          throw new McpProblem("permission", 403);
        if (resourceAccess && ["resources/read","resources/subscribe"].includes(rpc?.method) &&
            !resourceAccess(rpc.params?.uri)) throw new McpProblem("permission",403);
        const capture = rpc?.method === "tools/call" ? observe : undefined;
        if (capture) capture("request", sanitizedCapture(init.body, values));
        networkError = undefined;
        // Once the tool POST crosses this boundary, a transport error cannot
        // establish absence of effects. Unknown POST encodings stay conservative.
        if (init?.method === "POST" && (!rpc?.method || rpc.method === "tools/call")) markCallDispatch?.();
        const response = await send(input, init);
        if (init?.method === "GET" && config.transport === "streamable-http" && response.status === 405)
          pushUnavailable = true;
        if ((init?.method ?? "GET") === "GET") {
          if (response.ok && response.body && /^text\/event-stream\b/i.test(response.headers.get("content-type") ?? "")) {
            observeSse?.(config, true);
            const closed = openSse?.(config);
            if (closed) {
              // Forward bytes with backpressure. EOF, cancellation and stream errors
              // all release the live observation without logging any event data.
              const stream = new TransformStream();
              void response.body.pipeTo(stream.writable, {signal: controller.signal}).then(closed, closed);
              return new Response(stream.readable, {headers:response.headers, status:response.status, statusText:response.statusText});
            }
          } else if (pushUnavailable && response.status === 405) observeSse?.(config, false);
        }
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
        const caps = client.getServerCapabilities() ?? {};
        return {
          tools: !!caps.tools, toolsListChanged: caps.tools?.listChanged === true,
          resources: !!caps.resources, resourcesListChanged: caps.resources?.listChanged === true,
          subscribe: caps.resources?.subscribe === true,
        };
      } catch (error) {
        if (combined.aborted) throw new McpProblem("timeout", 504);
        throw error;
      }
    },
    async call(name, args, signal, current, capture, onDispatch) {
      markCallDispatch = onDispatch;
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
        markCallDispatch = undefined;
      }
    },
    lastError: () => networkError,
    pushUnavailable: () => pushUnavailable,
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
          await pool?.destroy();
        }
      })());
    },
  };
}

async function listCatalog(client, kind, schema, values, signal, timeout) {
  const documents = [], names = new Set(), cursors = new Set();
  let cursor, bytes = 0;
  do {
    const page = await client.request(
      { method: kind + "/list", params: cursor ? { cursor } : {} }, ResultSchema, { signal, timeout },
    );
    if (!schema.safeParse(page).success) throw new McpProblem("discovery");
    for (const doc of page[kind]) {
      const key = kind === "tools" ? doc.name : doc.uri;
      bytes += Buffer.byteLength(JSON.stringify(doc));
      if (!key || names.has(key) || documents.length >= 10000 || bytes > 8 * 1024 * 1024)
        throw new McpProblem("discovery");
      if (containsCredential(doc, values)) throw new McpProblem("sensitive");
      names.add(key);
      if (kind === "resources") {
        if (!safeResourceUri(doc.uri,values)) throw new McpProblem("sensitive");
        documents.push(safeToolObservation({uri:doc.uri,name:doc.name,
          ...(doc.mimeType && {mimeType:doc.mimeType}), ...(doc.title && {title:doc.title}),
          ...(doc.description && {description:doc.description})}));
      } else documents.push(doc);
    }
    cursor = page.nextCursor;
    if (cursor !== undefined && (!cursor || cursors.has(cursor) || cursors.size >= 1000))
      throw new McpProblem("discovery");
    cursors.add(cursor);
  } while (cursor !== undefined);
  return documents;
}

export async function discoverServer(
  config,
  values,
  { connectMs = 10000, discoveryMs = 20000, fetcher = fetch, signal, observeSse, openSse, tlsDirectory } = {},
) {
  const session = mcpSession(config, values, { connectMs, fetcher, observeSse, openSse, tlsDirectory });
  let stage = "protocol";
  try {
    const capabilities = await session.open(signal);
    stage = "discovery";
    const deadline = () => AbortSignal.any([
      AbortSignal.timeout(discoveryMs), ...(signal ? [signal] : []),
    ]);
    async function catalog(enabled, kind, schema) {
      if (!enabled) return {items: [], failure: null};
      try {
        return {items: await listCatalog(session.client,kind,schema,values,deadline(),discoveryMs), failure:null};
      } catch (error) {
        if (signal?.aborted) throw error;
        const failure = session.lastError() ?? error;
        const timeout = error?.code === -32001 || ["TimeoutError","AbortError"].includes(error?.name);
        return {items:null, failure: timeout ? new McpProblem("timeout",504) :
          failure instanceof McpProblem ? failure : new McpProblem("discovery")};
      }
    }
    const tools = await catalog(capabilities.tools,"tools",ListToolsResultSchema);
    const resources = await catalog(capabilities.resources,"resources",ListResourcesResultSchema);
    return {capabilities, tools:tools.items, toolFailure:tools.failure,
      resources:resources.items, resourceError:resources.failure?.code ?? null};
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

export async function discoverCatalog(config, values, options) {
  const result = await discoverServer(config,values,options);
  if (result.toolFailure) throw result.toolFailure;
  return result.tools;
}
