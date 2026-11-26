import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { locationSchema, observationSchema, recordSchema } from "../src/model.js";

const url = new URL(process.env.MCP_ENDPOINT!);
const token = process.env.MCP_AUTH_TOKEN;
if (url.protocol !== "https:" || !token) throw Error("Set HTTPS MCP_ENDPOINT and MCP_AUTH_TOKEN.");
const auth = {Authorization: `Bearer ${token}`};
for (const headers of [{}, {Authorization: "Bearer invalid"}, {Authorization: "Bearer "}] as HeadersInit[]) {
  assert.equal((await fetch(url,{method:"POST",headers})).status,401);
}
assert.equal((await fetch(url,{method:"POST",headers:{...auth,Origin:"https://untrusted.invalid"}})).status,403);
const client = new Client({name:"independent-weather-check",version:"1"});
await client.connect(new StreamableHTTPClientTransport(url,{requestInit:{headers:auth}}));
const proofSchema = z.array(z.object({id:z.int().positive(), location:locationSchema, observedAt:z.string()}));
try {
  const names = (await client.listTools()).tools.map(t=>t.name).sort();
  assert.deepEqual(names,["get_weather","read_weather_history","save_weather"]);
  const call = async(name:string,args:Record<string,unknown>) => {
    const r = await client.callTool({name,arguments:args});
    assert.ok(!r.isError, JSON.stringify(r.content)); return z.record(z.string(), z.unknown()).parse(r.structuredContent);
  };
  const proof = process.argv[2] ? proofSchema.parse(JSON.parse(process.argv[2])) : [];
  if (!process.argv[2]) {
    for(const location of [{latitude:43.65,longitude:-79.38},{latitude:45.5,longitude:-73.57}]) {
      const observation = observationSchema.parse((await call("get_weather",{location})).observation);
      const save = await call("save_weather",{observation});
      assert.deepEqual(await call("save_weather",{observation}),{id:save.id,created:false});
      proof.push({id:z.int().positive().parse(save.id),location,observedAt:observation.observedAt});
    }
  }
  assert.equal(proof.length,2); assert.notEqual(proof[0]!.id,proof[1]!.id);
  for(const entry of proof) {
    const to = new Date(Date.parse(entry.observedAt)+1000).toISOString();
    const data = await call("read_weather_history",{location:entry.location,from:entry.observedAt,to});
    const records = z.array(recordSchema).parse(data.records);
    assert.equal(records.length,1); assert.equal(records[0]!.id,entry.id);
    assert.deepEqual(records[0]!.observation.location,entry.location);
    assert.equal(records[0]!.observation.observedAt,entry.observedAt);
  }
  console.log(JSON.stringify(proof));
} finally {await client.close();}
