// Provisional wire contract for an isolated MCP peer. Production uses discovery.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import { createSessionServer } from "./sessions.mjs";
import { createDevManagerMock } from "../src/dev-manager-mock.ts";
import { policyDigest } from "./mcp-execution-policy.mjs";
import { remote, start, stop } from "./test-fixtures/mcp-peer.mjs";
import { weatherTaskDefinitions } from "../examples/weather-tasks.mjs";

const string = { type: "string" },
  number = { type: "number" };
function object(properties, required = Object.keys(properties)) {
  return { type: "object", properties, required, additionalProperties: false };
}
const observation = object(
  {
    place: string,
    time: string,
    tempC: number,
    humidityPct: number,
    windKph: number,
    condition: string,
  },
  ["place", "time"],
);
const definitions = [
  {
    name: "get_weather",
    description: "Retrieve the current observation for a place.",
    inputSchema: object({ place: string }),
  },
  {
    name: "save_weather",
    description: "Save the supplied observation.",
    inputSchema: object({ observation }),
  },
  {
    name: "read_weather_history",
    description: "Return all observations for place in [from,until).",
    inputSchema: object({ place: string, from: string, until: string }),
  },
];
const success = (structuredContent) => ({ content: [], structuredContent });
const iso = (ms) => new Date(ms).toISOString();

function fixtureReport({ rows, from, until }) {
  const report = { from, until, count: rows.length };
  if (!rows.length)
    return JSON.stringify({ ...report, message: "No observations during the reporting period." });
  for (const field of ["tempC", "humidityPct", "windKph"]) {
    const values = rows.map((row) => row[field]).filter(Number.isFinite);
    const measure = { samples: values.length, missing: rows.length - values.length };
    if (values.length) {
      measure.mean = values.reduce((sum, n) => sum + n, 0) / values.length;
      if (field === "tempC") measure.min = Math.min(...values);
      if (field !== "humidityPct") measure.max = Math.max(...values);
    } else measure.status = "unavailable";
    report[field] = measure;
  }
  report.conditions = [...new Set(rows.map((row) => row.condition).filter(Boolean))];
  return JSON.stringify(report);
}

test(
  "scheduled weather collection and reports cross the MCP boundary and survive backend restart",
  { timeout: 20000 },
  async (t) => {
    const peer = await remote(t);
    peer.state.pages = [definitions.slice(0, 2), [...definitions.slice(2), {name:"optional_metadata", inputSchema:object({
      value:{anyOf:["string","boolean","integer","number","array"].map(type => ({type}))},
    })}]];
    const location = "Fixture Harbour",
      periodHours = 1,
      minute = 60000;
    const startAt = Math.floor(Date.now() / minute) * minute,
      firstReport = startAt + 5 * minute;
    let clock = startAt - minute,
      sensorOffline = false,
      historyOffline = false,
      requireMetadata = false;
    const stored = [],
      calls = [];
    const samples = [
      { tempC: -2, humidityPct: 80, windKph: 0, condition: "Cloudy" },
      { tempC: 0, humidityPct: 60, windKph: 4, condition: "Clear" },
      { tempC: 2, windKph: 2, condition: "Rain" },
      { tempC: 4, humidityPct: 40, condition: "Cloudy" },
      { tempC: 6, humidityPct: 60, windKph: 6, condition: "Clear" },
    ];
    peer.state.execute = ({ name, arguments: args }) => {
      calls.push({ name, args });
      if (name === "get_weather") {
        if (sensorOffline)
          return { isError: true, content: [{ type: "text", text: "Sensor unavailable." }] };
        return success({
          observation: { place: args.place, time: iso(clock), ...samples[(clock - startAt) / minute] },
        });
      }
      if (name === "save_weather") {
        stored.push(structuredClone(args.observation));
        return success({ saved: true, time: args.observation.time });
      }
      if (name === "read_weather_history") {
        if (historyOffline)
          return { isError: true, content: [{ type: "text", text: "History unavailable." }] };
        const { place, from, until } = args;
        return success({
          from,
          until,
          rows: stored.filter((row) => row.place === place && row.time >= from && row.time < until),
        });
      }
      throw Error("Unexpected fixture operation");
    };
    const dir = await mkdtemp(join(tmpdir(), "d18-weather-"));
    const file = join(dir, "sessions.sqlite"),
      grants = [];
    const mock = createDevManagerMock("fixture");
    let unavailableToolId;
    const open = () =>
      createSessionServer(file, {
        executionOptions: { now: () => clock, readMcpPolicy: () => grants },
        schedulerOptions: { pollMs: 10 },
        invariantAdapter: () => ({
          ...mock,
          async complete(input) {
            if (input.memoryProposal || input.messages[0]?.content.startsWith("Review a proposed"))
              return mock.complete(input);
            const tools = input.tools.filter((t) => t.kind === "mcp");
            function call(name, args, dependsOn) {
              const tool = tools.find((t) => t.originalName === name);
              assert.ok(tool, "Expected authorized tool " + name);
              return {
                toolCalls: [
                  {
                    id: name,
                    toolId: tool.id,
                    providerName: "mcp_" + tool.toolId.replaceAll("-", ""),
                    arguments: args,
                    ...(dependsOn && { dependsOn }),
                  },
                ],
              };
            }
            const last = input.messages.at(-1);
            if (last.role === "tool") {
              const outcome = JSON.parse(last.content);
              if (last.toolCallId === "invalid-observation-request") {
                assert.equal(outcome.error.code, "invalid_arguments");
                return call("get_weather", {place:location});
              }
              if (!outcome.ok) return { text: "Weather operation failed. Data unavailable." };
              const output = outcome.output.structuredContent;
              if (last.toolCallId === "get_weather")
                return call("save_weather", { observation: output.observation }, ["get_weather"]);
              if (last.toolCallId === "save_weather")
                return { text: "Saved observation for " + output.time };
              if (requireMetadata) {
                assert.ok(input.messages.some(m => m.content.includes(unavailableToolId)));
                return {text:JSON.stringify({blockedToolIds:[unavailableToolId], partialResult:fixtureReport(output)})};
              }
              return { text: fixtureReport(output) };
            }
            assert.ok(last.content.includes(location));
            if (last.content.includes("read_weather_history")) {
              assert.deepEqual(
                tools.map((t) => t.originalName),
                ["read_weather_history"],
              );
              return call("read_weather_history", {
                place: location,
                from: iso(clock - periodHours * 3600000),
                until: iso(clock),
              });
            }
            assert.deepEqual(tools.map((t) => t.originalName).sort(), ["get_weather", "save_weather"]);
            if (clock === startAt) {
              const proposal = call("get_weather", {place:3});
              proposal.toolCalls[0].id = "invalid-observation-request";
              return proposal;
            }
            return call("get_weather", { place: location });
          },
        }),
      });
    let app = open(),
      base = await start(app);
    const db = new DatabaseSync(file);
    async function close() {
      await app.stopExecutions();
      if (app.listening) await stop(app);
      else {
        const done = new Promise((r) => app.once("close", r));
        app.close();
        await done;
      }
    }
    t.after(async () => {
      await close();
      db.close();
      await rm(dir, { recursive: true });
    });
    async function api(path, body, method) {
      const res = await fetch(base + "/api/" + path, {
        method: method ?? (body ? "POST" : "GET"),
        headers: { "content-type": "application/json" },
        body: body && JSON.stringify(body),
      });
      assert.ok(res.ok, String(res.status));
      return res.json();
    }
    const conn = await api("mcp-connections", peer.config);
    await api("mcp-connections/" + conn.connectionId + "/refresh", {});
    const catalog = await api("mcp-connections/" + conn.connectionId);
    const inputs = {
      location,
      periodHours,
      timezone: "UTC",
      provider: "openai",
      model: "fixture",
      collection: {
        schedule: { kind: "interval", startAt, everyMs: minute },
      },
      reporting: {
        schedule: { kind: "interval", startAt: firstReport, everyMs: minute },
      },
    };
    const templates = weatherTaskDefinitions(catalog, inputs);
    const optional = catalog.tools.find(t => t.originalName === "optional_metadata");
    unavailableToolId = optional.toolId;
    for (const template of [templates.collection, templates.reporting])
      template.permissions.push({connectionId:conn.connectionId, toolId:optional.toolId});
    let readProof;
    for (const name of ["get_weather", "save_weather", "read_weather_history", "optional_metadata"]) {
      const { toolId, document } = catalog.tools.find((t) => t.originalName === name);
      const grant = {
        schedulerScope:true,
        toolId,
        connectionId: conn.connectionId,
        definition: policyDigest(document),
        revision: catalog.connection.revision,
        safety: name === "save_weather" ? "side-effecting" : "read-only",
      };
      if (name === "get_weather") {
        grant.arguments = { place: location };
        readProof = policyDigest(grant);
      } else if (name === "optional_metadata") grant.arguments = {};
      else grant.argumentSchema = document.inputSchema;
      if (name === "save_weather") grant.requires = [readProof];
      grants.push(grant);
    }
    // Use the same local API as the Scheduler workspace to consent, save and start.
    async function ui(path, body, method = body ? "POST" : "GET", status = 200) {
      const res = await fetch(base + "/api/scheduler/" + path, {
        method,
        headers: { origin: base, "x-day18-ui": "scheduler", "content-type": "application/json" },
        body: body && JSON.stringify(body),
      });
      const data = await res.json();
      assert.equal(res.status, status, JSON.stringify(data));
      return data;
    }
    const collectionTools = await ui("catalog");
    const reportingTools = await ui("catalog");
    function definition(name, template, choices) {
      return {
        ...template,
        enabled: false,
        name,
        authorized: true,
        permissions: template.permissions.map((p) => {
          const { revision, definition, eligible } = choices.find((c) => c.toolId === p.toolId);
          assert.ok(eligible);
          return { ...p, revision, definition };
        }),
      };
    }
    const collectDef = definition("Collect observations", templates.collection, collectionTools);
    const reportDef = definition("Observation report", templates.reporting, reportingTools);
    assert.equal((await fetch(base + "/api/scheduler/tasks")).status, 403);
    await ui("tasks", { ...reportDef, timezone: "Invalid/Zone" }, "POST", 400);
    await ui("tasks", { ...reportDef, authorized: false }, "POST", 403);
    await ui("tasks", { ...reportDef, sessionId: "unrelated" }, "POST", 400);
    await ui(
      "tasks",
      { ...reportDef, permissions: [{ ...reportDef.permissions[0], revision: 999 }] },
      "POST",
      409,
    );
    assert.deepEqual(await ui("tasks"), []);
    const collection = await ui("tasks", collectDef, "POST", 201);
    let report = await ui("tasks", reportDef, "POST", 201);
    assert.equal(report.enabled, false);
    const savedScope = db.prepare("SELECT approved_grants FROM scheduled_task_tools WHERE task_id=?");
    const beforeEdit = savedScope.get(report.id).approved_grants;
    // A new deployment grant on an existing tool must not be picked up by a task rename.
    const baseScope = grants.find(g => g.toolId === report.permissions[0].toolId);
    grants.push({...baseScope, argumentSchema: undefined, arguments: {}});

    report = await ui(
      "tasks/" + report.id,
      { ...reportDef, name: "Weather observation report", revision: report.revision },
      "PUT",
    );
    assert.equal(savedScope.get(report.id).approved_grants, beforeEdit);
    grants.pop();
    await ui("tasks/" + report.id, { ...reportDef, revision: report.revision - 1 }, "PUT", 409);
    const controls = (action) => ui("tasks/" + report.id + "/" + action, null, "POST");
    assert.equal((await controls("start")).enabled, true);
    await ui("tasks/" + report.id, { ...reportDef, revision: report.revision }, "PUT", 409);
    assert.equal((await controls("pause")).enabled, false);
    assert.equal((await controls("resume")).enabled, true);
    assert.equal((await controls("stop")).stopped, true);
    await ui("tasks/" + report.id + "/resume", null, "POST", 409);
    await controls("start");
    await ui("tasks/" + collection.id + "/start", null, "POST");
    // All actual turns take place on a backend with no inbound HTTP listener.
    await close();
    app = open();
    async function terminal(task, due) {
      for (let i = 0; i < 400; i++) {
        const row = db
          .prepare("SELECT id FROM scheduled_occurrences WHERE task_id=? AND due_at=?")
          .get(task.id, due);
        if (row) {
          const result = app.scheduledTasks.getOccurrence(row.id);
          if (result.finished_at !== null) return result;
        }
        await sleep(10);
      }
      assert.fail("Occurrence did not finish for scheduled slot " + iso(due));
    }
    const operations = (run) =>
      db
        .prepare(
          "SELECT id,state,display,error FROM week4_operations WHERE run_id=? AND kind='tool' ORDER BY rowid",
        )
        .all(run.id);
    for (let i = 0; i < 5; i++) {
      clock = startAt + i * minute;
      const run = await terminal(collection, clock);
      const all = operations(run);
      if (i === 0) {
        assert.equal(all[0].state, "Failed");
        assert.equal(JSON.parse(all[0].error).code, "invalid_arguments");
        assert.equal(JSON.parse(all[1].display).correctsOperation, all[0].id);
      }
      const ops = i === 0 ? all.slice(1) : all;
      assert.equal(run.state, "Completed", JSON.stringify(ops));
      assert.equal(run.error, null);
      assert.equal(run.resolutionIssues.length, 1);
      assert.equal(run.resolutionIssues[0].schemaPath, "/properties/value/anyOf");
      assert.match(run.resolutionIssues[0].diagnostic, /two alternatives/);
      assert.deepEqual(
        ops.map((op) => [JSON.parse(op.display).name, op.state]),
        [
          ["get_weather", "Success"],
          ["save_weather", "Success"],
        ],
      );
      assert.deepEqual(JSON.parse(ops[1].display).prerequisites, [ops[0].id]);
      assert.deepEqual(stored[i], { place: location, time: iso(clock), ...samples[i] });
      assert.equal((await app.scheduledTasks.executeOccurrence(run.id)).id, run.id);
      assert.equal(stored.length, i + 1);
      if (i === 2) {
        await close();
        app = open();
        assert.equal(app.listening, false);
      }
    }
    sensorOffline = true;
    clock = firstReport;
    const failed = await terminal(collection, clock),
      full = await terminal(report, clock);
    assert.equal(operations(failed)[0].state, "Failed");
    assert.equal(failed.state, "Failed");
    assert.equal(failed.error, JSON.parse(operations(failed)[0].error).code);
    assert.equal(full.state, "Completed");
    assert.deepEqual(
      operations(full).map((op) => [JSON.parse(op.display).name, op.state]),
      [["read_weather_history", "Success"]],
    );
    assert.equal(calls.filter((x) => x.name === "save_weather").length, 5);
    app.scheduledTasks.stop(collection.id);
    clock += minute;
    historyOffline = true;
    const failedReport = await terminal(report, clock);
    assert.equal(failedReport.state, "Failed");
    historyOffline = false;
    requireMetadata = true;
    clock += minute;
    const partial = await terminal(report, clock);
    assert.equal(partial.state, "PartialSuccess");
    assert.equal(partial.error, "unsupported_schema");
    assert.equal(partial.resolutionIssues.find(issue => issue.toolId === optional.toolId).required, true);
    assert.deepEqual(operations(partial).map(op => op.state), ["Success"]);
    assert.ok(JSON.parse(partial.response).count > 0);
    app.scheduledTasks.pause(report.id);
    base = await start(app);
    const savedPartial = () => ui("tasks/" + report.id + "/result");
    assert.deepEqual((await savedPartial()).rows, [{response:partial.response}]);
    app.scheduledTasks.stop(report.id);
    await close();
    app = open();
    base = await start(app);
    assert.deepEqual((await savedPartial()).rows, [{response:partial.response}]);
    requireMetadata = false;
    clock += 2 * 3600000;
    app.scheduledTasks.start(report.id);
    const empty = await terminal(report, clock);
    assert.equal(empty.state, "Completed");
    grants.splice(
      grants.findIndex((g) => g.toolId === reportDef.permissions[0].toolId),
      1,
    );
    const historyReads = calls.filter((call) => call.name === "read_weather_history").length;
    clock += minute;
    const denied = await terminal(report, clock);
    assert.equal(denied.error, "authorization");
    assert.equal(denied.started_at, null);
    assert.equal(calls.filter((call) => call.name === "read_weather_history").length, historyReads);
    app.scheduledTasks.stop(report.id);
    await close();
    app = open();
    base = await start(app);
    assert.deepEqual(await api("week3/sessions"),[]);
    const answer = run=>app.scheduledTasks.getOccurrence(run.id).response;
    // The newer rejected occurrence has no response and must not hide the report.
    assert.equal(answer(denied), null);
    assert.deepEqual((await ui("tasks/" + report.id + "/result")).rows, [{response:answer(empty)}]);
    assert.deepEqual(JSON.parse(answer(full)), {
      from: iso(firstReport - periodHours * 3600000),
      until: iso(firstReport),
      count: 5,
      tempC: { samples: 5, missing: 0, min: -2, max: 6, mean: 2 },
      humidityPct: { samples: 4, missing: 1, mean: 60 },
      windKph: { samples: 4, missing: 1, max: 6, mean: 3 },
      conditions: ["Cloudy", "Clear", "Rain"],
    });
    assert.match(answer(failedReport), /failed|unavailable/i);
    const failedResponse = answer(failed);
    assert.ok(failedResponse);
    assert.deepEqual((await ui("tasks/" + collection.id + "/result")).rows, [{response:failedResponse}]);
    assert.deepEqual(JSON.parse(answer(empty)), {
      from: iso(empty.due_at - periodHours * 3600000),
      until: iso(empty.due_at),
      count: 0,
      message: "No observations during the reporting period.",
    });
    const occurrences=(await ui("tasks/"+collection.id+"/history")).rows;
    const journal=(await Promise.all(occurrences.map(o=>ui("tasks/"+collection.id+"/history/"+o.id+"/journal")))).flat();
    await ui("tasks/"+report.id+"/history/"+occurrences[0].id+"/journal",undefined,"GET",404);
    assert.equal(journal.filter((op) => op.status === "Success").length, 10);
    assert.equal(journal.filter((op) => op.status === "Failed").length, 2);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    const workspace = await ui("tasks");
    const savedReport = workspace.find((t) => t.id === report.id);
    assert.equal(savedReport.name, "Weather observation report");
    assert.equal(savedReport.status, "Stopped");
    assert.equal(savedReport.metrics.denied, 1);
    assert.equal(savedReport.metrics.success, 2);
    assert.equal(savedReport.metrics.failed, 2);
    const page = await ui("tasks/" + report.id + "/history");
    assert.equal(page.hasMore, false);
    const savedRun = page.rows.find((r) => r.id === full.id);
    assert.equal(savedRun.response, answer(full));
    assert.deepEqual(savedRun.structured[0].value.rows, stored);
    assert.equal(page.rows.find((r) => r.id === denied.id).error, "authorization");
    assert.ok(page.rows.find((r) => r.id === failedReport.id).error);
    await ui("tasks/" + report.id + "/history?offset=-1", undefined, "GET", 400);
    await ui(
      "tasks/" + report.id,
      { ...reportDef, sessionId: "unrelated", revision: savedReport.revision },
      "PUT",
      400,
    );
    t.diagnostic("Restored fixture report: " + answer(full));
  },
);
