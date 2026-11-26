import test from "node:test";
import assert from "node:assert/strict";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Logger } from "../src/logging.js";
import { weatherServer } from "../src/mcp.js";
import { OpenMeteo } from "../src/provider.js";
import { ObservedTransport } from "../src/observed-transport.js";

function capture() {
  const rows: Record<string, unknown>[] = [];
  return {rows, log: new Logger(line => rows.push(JSON.parse(line)))};
}

test("interleaved RPC outcomes retain invocation IDs and SDK validation errors exclude client text", async t => {
  const {rows, log} = capture();
  t.mock.method(StreamableHTTPServerTransport.prototype, "send", async () => {});
  const transport = new ObservedTransport(log);
  transport.onmessage = () => {};
  await transport.start();
  await log.scope({requestId:"test-request"}, async () => {
    for (const name of ["get_weather","do-not-log-secret"]) {
      transport.onmessage!({jsonrpc:"2.0",method:"tools/call",id:name,params:{name}});
    }
    for (const name of ["do-not-log-secret","get_weather"]) {
      await transport.send({jsonrpc:"2.0", id:name, result:{isError:true,content:[{type:"text",
        text:"Input validation error: Invalid arguments for tool get_weather: do-not-log-secret"}]}});
    }
    await transport.close();
  });
  assert.deepEqual(rows.map(r => [r.tool,r.status]), [
    ["get_weather","started"], ["unknown","started"], ["unknown","failure"], ["get_weather","failure"],
  ]);
  assert.equal(rows[0]?.invocationId,rows[3]?.invocationId);
  assert.equal(rows[1]?.invocationId,rows[2]?.invocationId);
  assert.notEqual(rows[0]?.invocationId,rows[1]?.invocationId);
  assert.ok(rows.every(r=>r.requestId==="test-request"));
  assert.equal(rows[3]?.message,"Tool input failed schema validation.");
  assert.ok(!JSON.stringify(rows).includes("do-not-log-secret"));
});

test("provider and storage diagnostics log safe operational details without raw exceptions", async () => {
  const {rows, log} = capture();
  const provider = new OpenMeteo(1000, async () => new Response("private-secret",{status:429}), log);
  const location = {latitude:45,longitude:-80};
  await assert.rejects(provider.current(location),/rate limit/);
  assert.equal(rows.at(-1)?.httpStatus,429);
  assert.equal(rows.at(-1)?.latitude,45);
  assert.equal(typeof rows.at(-1)?.durationMs,"number");
  const broken = () => {throw Object.assign(new Error("private-secret"),{errcode:5});};
  const server = weatherServer(provider,{save:broken,history:broken},log);
  const client = new Client({name:"test", version:"1"});
  const [a,b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a); await client.connect(b);
    const history = await client.callTool({name:"read_weather_history",arguments:{
      location,from:"2026-01-01T00:00:00Z",to:"2026-01-02T00:00:00Z"}});
    assert.equal(history.isError,true);
    assert.equal(rows.at(-1)?.event,"sqlite.history.failed");
    assert.equal(rows.at(-1)?.sqliteCode,5);
    assert.ok(!JSON.stringify(rows).includes("private-secret"));
  } finally { await client.close(); await server.close(); }
});
