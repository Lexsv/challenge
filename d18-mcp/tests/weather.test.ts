import { z } from "zod";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { WeatherStore } from "../src/repository.js";
import { OpenMeteo } from "../src/provider.js";
import { weatherServer } from "../src/mcp.js";
import { config } from "../src/config.js";
import type { Observation } from "../src/model.js";

const location = {latitude: 43.65, longitude: -79.38};
const first: Observation = { location, observedAt: "2026-01-01T00:00:00Z", temperature: -3.7,
  humidity: 60, windSpeed: 12, conditions: 3, units: {temperature:"°C",humidity:"%",windSpeed:"km/h"}, source: "open-meteo" };
const second = {...first, observedAt: "2026-01-01T00:15:00Z"};
const query = {location, from: first.observedAt, to: "2026-01-02T00:00:00Z"};

test("SQLite history survives reopen, handles concurrent connections and preserves the first value", () => {
  const dir = mkdtempSync(join(tmpdir(), "d18-test-"));
  try {
    const file = join(dir, "test.sqlite");
    const store = new WeatherStore(file), other = new WeatherStore(file);
    try {
      store.save(second);
      const {id} = store.save(first);
      assert.deepEqual(other.save({...first, location:{...location,latitude:43.6500001},
        observedAt:"2025-12-31T19:00:00-05:00", temperature:99}), {id,created:false});
      other.save({...first, location:{...location,longitude:0}});
      assert.equal(store.history({...query,to:second.observedAt}).records.length,1);
      const page = store.history({...query,limit:1});
      assert.equal(page.records[0]?.observation.temperature,-3.7);
      assert.equal(page.nextOffset,1);
      assert.equal(store.history({...query,offset:1}).records[0]?.observation.observedAt,"2026-01-01T00:15:00.000Z");
    } finally { other.close(); store.close(); }
    const reopened = new WeatherStore(file);
    try {
      const {records} = reopened.history(query);
      assert.equal(records.length,2);
      assert.equal(records[0]?.observation.temperature,-3.7);
      assert.deepEqual(records[0]?.observation.location,location);
      assert.equal(records[0]?.observation.observedAt,"2026-01-01T00:00:00.000Z");
    } finally { reopened.close(); }
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test("provider checks units, normalizes Unix time, and requests canonical coordinates",async () => {
  const provider = new OpenMeteo(500, async url => {
    assert.equal(new URL(String(url)).searchParams.get("latitude"),"43.65");
    return Response.json({current_units:{time:"unixtime",temperature_2m:"°C",relative_humidity_2m:"%",
      wind_speed_10m:"km/h",weather_code:"wmo code"},current:{time:1767225600,temperature_2m:-3.7,
      relative_humidity_2m:60,wind_speed_10m:12,weather_code:3}});
  });
  assert.deepEqual(await provider.current(location),{...first,observedAt:"2026-01-01T00:00:00.000Z"});
});
test("provider surfaces safe rate-limit, network and invalid-response errors", async () => {
  for (const [request, message] of [
    [async () => new Response(null,{status:429}), /rate limit/],
    [async () => Response.json({current_units:{temperature_2m:"°F"}}), /invalid measurements/],
    [async () => {throw Error("internal detail");}, /failed or timed out/],
  ] as const) await assert.rejects(new OpenMeteo(100,request).current(location),message);
});
test("SDK discovers schemas, validates input and executes each tool", async () => {
  const store = new WeatherStore(":memory:");
  const server = weatherServer({current:async () => first},store);
  const client = new Client({name:"weather-test",version:"1"});
  const [a,b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a); await client.connect(b);
    const {tools} = await client.listTools();
    assert.deepEqual(tools.map(t=>t.name).sort(),["get_weather","read_weather_history","save_weather"]);
    assert.ok(tools.every(t=>t.outputSchema));
    const get = await client.callTool({name:"get_weather",arguments:{location}});
    assert.deepEqual(get.structuredContent,{observation:first});
    const save = await client.callTool({name:"save_weather",arguments:{observation:first}});
    assert.equal(z.object({created:z.boolean()}).parse(save.structuredContent).created,true);
    const history = await client.callTool({name:"read_weather_history",arguments:query});
    assert.equal(z.object({records:z.array(z.unknown())}).parse(history.structuredContent).records.length,1);
    for(const [name,args] of [
      ["get_weather",{location:{...location,latitude:-91}}],
      ["save_weather",{observation:{...first,humidity:102}}],
      ["read_weather_history",{...query,from:query.to}],
      ["read_weather_history",{...query,from:"yesterday"}],
    ] as const) assert.equal((await client.callTool({name,arguments:args})).isError,true);
  } finally {await client.close(); await server.close(); store.close();}
});
test("unsafe bind addresses and origins are rejected and errors redact token values", () => {
  const input = {MCP_AUTH_TOKEN:"bad-secret",MCP_HOST:"0.0.0.0",TLS_CERT_PATH:"/cert",TLS_KEY_PATH:"/key",DATABASE_PATH:"/db"};
  assert.throws(()=>config(input), (e: Error)=>e.message.includes("MCP_HOST") && !e.message.includes("bad-secret"));
  assert.throws(()=>config({...input,MCP_AUTH_TOKEN:"a".repeat(40),MCP_HOST:"127.0.0.1",MCP_ALLOWED_ORIGINS:"http://invalid.example"}),/ORIGINS/);
});

test("Docker can bind its bridge while preserving the configured HTTPS authority", () => {
  const input = {MCP_AUTH_TOKEN:"a".repeat(40),TLS_CERT_PATH:"/cert",TLS_KEY_PATH:"/key",DATABASE_PATH:"/db"};
  assert.equal(config(input).MCP_BIND_HOST,undefined);
  const cfg = config({...input,MCP_BIND_HOST:"0.0.0.0"});
  assert.equal(cfg.MCP_HOST,"127.0.0.1");
  assert.equal(cfg.MCP_BIND_HOST,"0.0.0.0");
  assert.throws(()=>config({...input,MCP_BIND_HOST:"invalid"}),/MCP_BIND_HOST/);
});
