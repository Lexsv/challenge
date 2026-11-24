import { parameterRows, parameterEndpoint, sensitiveParameter } from "../src/mcp-parameters.ts";
import { executionError, retryAfterMs } from '../src/execution-policy.ts';
import { isIP } from "node:net";

import { normalizedMcpEndpoint } from "../src/mcp-endpoint.ts";

const messages = {
  tool: "The remote tool reported an execution error.",
  result: "The remote result did not meet the reviewed output contract.",
  endpoint: "This endpoint already belongs to another MCP connection.",
  deleting: "Deletion is pending. Retry Delete to finish local cleanup.",
  cleanup:
    "The saved credential could not be removed. Retry Delete to finish local cleanup.",
  delete_failed: "Local deletion could not be completed. Retry Delete.",
  cancelled: "Discovery stopped because the connection is being deleted.",
  invalid:
    "Check the connection fields and enter a valid endpoint and authentication settings.",
  name: "A connection with this name already exists.",
  missing: "The connection is unavailable.",
  conflict: "The connection changed. Reopen settings and try again.",
  busy: "Discovery is already in progress.",
  credential: "The saved credential is unavailable. Re-enter it in Settings.",
  transport:
    "Could not reach the configured MCP endpoint. Check its address and transport.",
  authentication:
    "The endpoint returned HTTP 401. Check the connection credentials.",
  permission: "The endpoint returned HTTP 403. Check access permissions.",
  protocol: "The server did not complete a compatible MCP handshake.",
  discovery: "The server did not return a complete, valid tool catalog.",
  timeout: "The MCP operation timed out. The previous catalog is preserved.",
  redirect: "A redirect or different-origin request was refused.",
  sensitive:
    "Discovery returned credential material. The catalog was not saved.",
  unknown: "The MCP operation could not be completed.",
};
export class McpProblem extends Error {
  constructor(code, status = 502) {
    super(messages[code]);
    this.code = code;
    this.status = status;
  }
  toExecutionError(stage, at, certainty = "known") {
    const code = { authentication:"authentication", permission:"authorization", protocol:"protocol",
      timeout:"timeout", cancelled:"cancelled", transport:"connection", credential:"authentication",
      redirect:"authorization", invalid:"invalid_arguments", discovery:"schema" }[this.code] ?? "execution_error";
    const issue = executionError(code,"mcp",stage,at,certainty);
    // Discovery's transport code also covers incompatible HTTP endpoints.
    if (this.code === "transport") issue.retryable = false;
    return issue;
  }
}
const invalid = () => {
  throw new McpProblem("invalid", 400);
};
const record = (value) =>
  !!value && typeof value === "object" && !Array.isArray(value);
export function endpointUrl(input, authParameter) {
  const identity = normalizedMcpEndpoint(input, authParameter);
  if (!identity) invalid();
  const url = new URL(identity);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const local =
    host === "localhost" ||
    (isIP(host) === 4 &&
      /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) ||
    (isIP(host) === 6 && (host === "::1" || /^f[cd]/i.test(host)));
  if (
    typeof input !== "string" ||
    input.length > 2048 ||
    url.username ||
    url.password ||
    !(url.protocol === "https:" || (url.protocol === "http:" && local))
  )
    invalid();
  return url.href;
}

const safeHeader = /^[A-Za-z][A-Za-z0-9-]{0,99}$/;
const reservedHeader =
  /^(?:host|connection|cookie|set-cookie|content-.*|transfer-encoding|proxy-.*|sec-.*|mcp-.*|last-event-id|accept|origin|upgrade|forwarded|x-forwarded-.*|keep-alive|trailer|te|expect)$/i;
export function parseConfiguration(body) {
  if (
    !record(body) ||
    Object.keys(body).some(
      (k) =>
        ![
          "name",
          "description",
          "endpoint",
          "transport",
          "auth",
          "secretValues",
          "revision",
        ].includes(k),
    )
  )
    invalid();
  const { name, description, transport, auth, secretValues } = body;
  if (
    typeof name !== "string" ||
    !name.trim() ||
    name.length > 120 ||
    typeof description !== "string" ||
    description.length > 2000 ||
    !["streamable-http", "sse"].includes(transport) ||
    !record(auth)
  )
    invalid();
  const type = auth.type;
  if (!["none", "bearer", "query", "headers"].includes(type)) invalid();
  const table = Object.hasOwn(auth, "rows");
  const keys = table
    ? ["type", "rows"]
    : type === "query"
      ? ["type", "parameter"]
      : type === "headers"
        ? ["type", "headers"]
        : ["type"];
  if (Object.keys(auth).some((k) => !keys.includes(k))) invalid();
  if (
    !table &&
    type === "query" &&
    (typeof auth.parameter !== "string" ||
      !/^[A-Za-z0-9_.~-]{1,100}$/.test(auth.parameter))
  )
    invalid();
  if (
    !table &&
    type === "headers" &&
    (!Array.isArray(auth.headers) ||
      !auth.headers.length ||
      auth.headers.length > 16 ||
      auth.headers.some(
        (h) =>
          typeof h !== "string" ||
          !safeHeader.test(h) ||
          reservedHeader.test(h),
      ) ||
      new Set(auth.headers.map((h) => h.toLowerCase())).size !==
        auth.headers.length)
  )
    invalid();
  if (table) {
    if (
      !["query", "headers"].includes(type) ||
      !Array.isArray(auth.rows) ||
      auth.rows.length > 16
    )
      invalid();
    const names = new Set();
    for (const row of auth.rows) {
      if (
        !record(row) ||
        Object.keys(row).some(
          (k) => !["key", "enabled", "secret", "value"].includes(k),
        ) ||
        typeof row.enabled !== "boolean" ||
        typeof row.secret !== "boolean" ||
        typeof row.key !== "string" ||
        !(type === "headers"
          ? safeHeader.test(row.key) && !reservedHeader.test(row.key)
          : /^[A-Za-z0-9_.~-]{1,100}$/.test(row.key))
      )
        invalid();
      const key = type === "headers" ? row.key.toLowerCase() : row.key;
      if (names.has(key)) invalid();
      names.add(key);
      if (
        row.secret
          ? Object.hasOwn(row, "value")
          : sensitiveParameter(row.key) ||
            typeof row.value !== "string" ||
            row.value.length > 4096 ||
            /[^\x20-\x7e]/.test(row.value)
      )
        invalid();
    }
  }
  const rows = parameterRows(auth);
  const count = rows.filter((r) => r.secret).length;
  if (
    secretValues !== undefined &&
    (!Array.isArray(secretValues) ||
      secretValues.length !== count ||
      secretValues.some(
        (v) =>
          v !== null &&
          (typeof v !== "string" ||
            !v.trim() ||
            v.length > 4096 ||
            /[^\x20-\x7e]/.test(v)),
      ))
  )
    invalid();
  const config = {
    name: name.trim(),
    description: description.trim(),
    transport,
    endpoint: endpointUrl(
      body.endpoint,
      !table && type === "query" ? auth.parameter : undefined,
    ),
    auth,
  };
  config.endpoint = endpointUrl(parameterEndpoint(config.endpoint, auth));
  if (secretValues?.length) {
    const publicConfig = JSON.stringify(config);
    const queryValues = Array.from(
      new URL(config.endpoint).searchParams.values(),
    );
    if (
      secretValues.some(
        (v) =>
          v !== null &&
          (publicConfig.includes(v) || queryValues.some((q) => q.includes(v))),
      )
    )
      invalid();
  }
  return { config, secretValues };
}

export function authenticatedFetch(config, values, signal, fetcher = fetch) {
  const origin = new URL(config.endpoint).origin;
  return async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.origin !== origin || url.username || url.password)
      throw new McpProblem("redirect");
    const headers = new Headers(
      input instanceof Request ? input.headers : undefined,
    );
    new Headers(init.headers).forEach((v, k) => headers.set(k, v));
    switch (config.auth.type) {
      case "bearer":
        headers.set("Authorization", "Bearer " + values[0]);
        break;
      case "query":
      case "headers": {
        let index = 0;
        for (const row of parameterRows(config.auth)) {
          const value = row.secret ? values[index++] : row.value;
          if (row.enabled)
            (config.auth.type === "query" ? url.searchParams : headers).set(
              row.key,
              value,
            );
        }
        break;
      }
    }
    let response;
    try {
      response = await fetcher(url, {
        ...init,
        headers,
        credentials: "omit",
        redirect: "manual",
        signal: AbortSignal.any([signal, init.signal].filter(Boolean)),
      });
    } catch {
      throw new McpProblem(signal.aborted ? "timeout" : "transport");
    }
    if (response.status >= 300 && response.status < 400)
      throw new McpProblem("redirect");
    if (response.status === 401) throw new McpProblem("authentication", 401);
    if (response.status === 403) throw new McpProblem("permission", 403);
    if (
      response.status === 405 &&
      init.method === "GET" &&
      config.transport === "streamable-http"
    )
      return response;
    if (!response.ok) {
      const problem = new McpProblem(
        [404, 405, 406, 415].includes(response.status)
          ? "transport"
          : "unknown",
        response.status,
      );
      problem.httpStatus = response.status;
      problem.retryAfter = retryAfterMs(
        response.headers.get("retry-after"),
        Date.now(),
      );
      throw problem;
    }
    return response;
  };
}
