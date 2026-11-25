import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ResourceLinkSchema, ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

async function connect(url: URL, token: string) {
  const client = new Client({ name: "subscription-check", version: "1" });
  const opened = Promise.withResolvers<Response>();
  const reopened = Promise.withResolvers<Response>();
  let streamAbort = new AbortController();
  let gets = 0;
  const updates: string[] = [];
  client.setNotificationHandler(ResourceUpdatedNotificationSchema, notification => {
    updates.push(notification.params.uri);
  });
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: "Bearer " + token } },
    reconnectionOptions: { initialReconnectionDelay: 50, maxReconnectionDelay: 100,
      reconnectionDelayGrowFactor: 1, maxRetries: 3 },
    fetch: async (input, init) => {
      if (init?.method !== "GET") return fetch(input, init);
      streamAbort = new AbortController();
      const signals = init.signal ? [init.signal, streamAbort.signal] : [streamAbort.signal];
      const response = await fetch(input, { ...init, signal: AbortSignal.any(signals) });
      (++gets === 1 ? opened : reopened).resolve(response);
      return response;
    }
  });
  await client.connect(transport);
  const stream = await opened.promise;
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get("content-type") ?? "", /^text\/event-stream/);
  assert.equal(stream.headers.get("mcp-session-id"), transport.sessionId);
  return { client, transport, updates, async interruptStream() {
    streamAbort.abort();
    const next = await reopened.promise;
    assert.equal(next.status, 200);
    assert.equal(next.headers.get("mcp-session-id"), transport.sessionId);
  } };
}

async function reminder(client: Client, scheduledAt: string) {
  const result = await client.callTool({ name: "create_reminder",
    arguments: { message: "isolated subscription test", scheduledAt } });
  const data = result.structuredContent;
  assert.ok(data && typeof data === "object" && "id" in data && typeof data.id === "string");
  assert.ok(Array.isArray(result.content));
  const link = ResourceLinkSchema.parse(result.content.find(item => item.type === "resource_link"));
  assert.equal(link.uri, "scheduler://tasks/" + data.id);
  assert.equal(link.mimeType, "application/json");
  assert.deepEqual(result.content[0], { type: "text", text: JSON.stringify(data) });
  return link.uri;
}

async function status(client: Client, uri: string) {
  const resource = await client.readResource({ uri });
  const item = resource.contents[0];
  assert.ok(item && "text" in item);
  assert.equal(item.uri, uri);
  assert.equal(item.mimeType, "application/json");
  return JSON.parse(item.text).status;
}

export async function verifySubscriptions(url: URL, token: string) {
  const first = await connect(url, token);
  const peer = await connect(url, token);
  const clients = [first, peer];
  try {
    assert.equal(first.client.getServerCapabilities()?.resources?.subscribe, true);
    const templates = await first.client.listResourceTemplates();
    assert.ok(templates.resourceTemplates.some(t => t.uriTemplate === "scheduler://tasks/{id}"));
    const sid = first.transport.sessionId!;
    const headers = { Authorization: "Bearer " + token, "Mcp-Session-Id": sid, Accept: "text/event-stream" };
    for (const method of ["GET", "POST", "DELETE"]) {
      assert.equal((await fetch(url, { method, headers: { ...headers, Authorization: "Bearer invalid" } })).status, 401);
      assert.equal((await fetch(url, { method, headers: { ...headers, Origin: "https://invalid.example" } })).status, 403);
    }
    assert.equal((await fetch(url, { headers })).status, 409);
    assert.equal((await fetch(url, { headers: { ...headers, "Mcp-Session-Id": randomUUID() } })).status, 404);
    const missing = { uri: "scheduler://tasks/" + randomUUID() };
    await assert.rejects(() => first.client.readResource(missing));
    await assert.rejects(() => first.client.subscribeResource(missing));

    const due = new Date(Date.now() + 1800).toISOString();
    const mine = await reminder(first.client, due);
    const theirs = await reminder(peer.client, due);
    await first.client.subscribeResource({ uri: mine });
    await first.client.close(); // Abandon the session while its subscription exists.
    const again = await connect(url, token);
    clients.push(again);
    assert.notEqual(sid, again.transport.sessionId);
    await again.client.subscribeResource({ uri: mine });
    await again.client.subscribeResource({ uri: mine }); // Idempotent.
    await peer.client.subscribeResource({ uri: mine });
    await peer.client.unsubscribeResource({ uri: mine });
    await peer.client.subscribeResource({ uri: theirs });
    await peer.interruptStream(); // Same-session GET reconnect preserves the subscription.
    assert.equal(await status(again.client, mine), "pending");

    const timeout = Date.now() + 5000;
    while ((!again.updates.length || !peer.updates.length) && Date.now() < timeout) await delay(20);
    assert.equal(await status(again.client, mine), "completed");
    assert.equal(await status(peer.client, theirs), "completed");
    assert.deepEqual(again.updates, [mine]);
    assert.deepEqual(peer.updates, [theirs]);
    assert.equal((await fetch(url, { headers })).status, 404); // Disconnected idle session expired.

    const terminated = peer.transport.sessionId!;
    await peer.transport.terminateSession();
    assert.equal((await fetch(url, { headers: { ...headers, "Mcp-Session-Id": terminated } })).status, 404);
    await again.transport.terminateSession();
  } finally {
    await Promise.all(clients.map(({ client }) => client.close()));
  }
}
