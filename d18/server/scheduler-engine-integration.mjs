import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { once } from "node:events";
import { createSessionServer } from "./sessions.mjs";
import { createMcpRepository } from "./mcp-repository.mjs";
import { policyDigest } from "./mcp-execution-policy.mjs";
import { createDevManagerMock } from "../src/dev-manager-mock.ts";

async function until(check) {
  for (let i = 0; i < 300; i++) {
    if (check()) return;
    await sleep(10);
  }
  assert.ok(check(), "Scheduler did not reach the expected state");
}
async function fixture(t, adapter = () => createDevManagerMock("fixture"), permissions = []) {
  const dir = await mkdtemp(join(tmpdir(), "d18-engine-"));
  const path = join(dir, "test.sqlite");
  const clock = { value: Date.now() };
  const servers = new Set();
  const open = () => {
    const app = createSessionServer(path, {
      invariantAdapter: adapter,
      executionOptions: { now: () => clock.value, readMcpPolicy: () => permissions },
      schedulerOptions: { pollMs: 10 },
    });
    assert.equal(app.listening, false);
    servers.add(app);
    return app;
  };
  const app = open(),
    db = new DatabaseSync(path);
  async function close(server) {
    await server.stopExecutions();
    const closed = once(server, "close");
    server.close();
    await closed;
    servers.delete(server);
  }
  t.after(async () => {
    for (const server of servers) await close(server);
    db.close();
    await rm(dir, { recursive: true });
  });
  const define = (schedule, model = "fixture") => {
    return {
      instructions: "Report the current fixture status.",
      provider: "openai",
      model,
      timezone: "America/Toronto",
      schedule,
      enabled: false,
    };
  };
  const runs = (id) =>
    db
      .prepare(
        `SELECT r.state,r.answer,o.due_at,r.id,r.owner FROM scheduled_occurrences o
    JOIN week4_runs r ON r.id=o.id WHERE o.task_id=? ORDER BY o.due_at`,
      )
      .all(id);
  return { app, db, clock, open, close, define, runs };
}

function createStarted(service, definition) {
  const task = service.createTask(definition);
  return service.start(task.id);
}

test("recurring and one-time turns run headlessly; downtime coalesces and lifecycle controls persist", async (t) => {
  const { app, db, clock, open, close, define, runs } = await fixture(t);
  const start = clock.value;
  let tasks = app.scheduledTasks;
  const task = createStarted(tasks, define({ kind: "interval", startAt: start - 100000, everyMs: 1000 }));
  const onceTask = createStarted(tasks, define({ kind: "once", at: start - 85000 }));
  const completed = (id, n) => runs(id).filter((x) => x.state === "Completed").length === n;
  await until(() => completed(task.id, 1) && completed(onceTask.id, 1));
  clock.value += 1000;
  await until(() => completed(task.id, 2));
  await close(app);
  clock.value += 900000;
  const restarted = open();
  tasks = restarted.scheduledTasks;
  await until(() => completed(task.id, 3));
  assert.deepEqual(
    runs(task.id).map((x) => x.due_at),
    [start, start + 1000, start + 901000],
  );
  assert.ok(runs(task.id).every((x) => x.answer === "delivered"));
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM scheduled_occurrences WHERE task_id=? AND response IS NOT NULL").get(task.id).n,
    3,
  );
  assert.equal(runs(onceTask.id).length, 1);
  assert.equal(tasks.getTask(onceTask.id).next_due_at, null);
  tasks.pause(task.id);
  await close(restarted);
  clock.value += 10500;
  const resumed = open();
  tasks = resumed.scheduledTasks;
  await sleep(50);
  assert.equal(tasks.getTask(task.id).enabled, false);
  assert.equal(runs(task.id).length, 3);
  tasks.resume(task.id);
  clock.value += 500;
  await until(() => completed(task.id, 4));
  tasks.stop(task.id);
  await close(resumed);
  tasks = open().scheduledTasks;
  assert.equal(tasks.getTask(task.id).stopped, true);
  assert.throws(() => tasks.resume(task.id), { status: 409 });
  assert.throws(() => tasks.configure(task.id, tasks.getTask(task.id).revision, { enabled: true }), {
    status: 409,
  });
  clock.value += 5000;
  await sleep(40);
  assert.equal(runs(task.id).length, 4);
  tasks.start(task.id);
  await until(() => completed(task.id, 5));
  assert.equal(runs(onceTask.id).length, 1);
});

test("two backends serialize different slots, drain admitted work on shutdown, and isolate task failures", async (t) => {
  const release = Promise.withResolvers();
  const mock = createDevManagerMock("fixture");
  let held = false;
  const { app, clock, open, define, runs } = await fixture(t, (_provider, model) => ({
    ...mock,
    async complete(input) {
      if (model === "fail") throw Error("Synthetic provider failure");
      if (model === "slow" && !held) {
        held = true;
        await release.promise;
      }
      return mock.complete(input);
    },
  }));
  const task = createStarted(app.scheduledTasks,
    define({ kind: "interval", startAt: clock.value, everyMs: 1000 }, "slow"),
  );
  const start = clock.value;
  try {
    await until(() => held);
    const other = open();
    clock.value += 3000;
    const secondSlot = other.scheduledTasks.materialize(task.id, clock.value);
    await assert.rejects(other.scheduledTasks.executeOccurrence(secondSlot), { status: 409 });
    const fail = createStarted(other.scheduledTasks, define({ kind: "once", at: start }, "fail"));
    const good = createStarted(other.scheduledTasks, define({ kind: "once", at: start }));
    await until(() => runs(fail.id)[0]?.state === "Failed" && runs(good.id)[0]?.state === "Completed");
    assert.deepEqual(
      runs(task.id).map((x) => x.state),
      ["Running"],
    );
    let drained = false;
    const shutdown = app.stopExecutions().then(() => {
      drained = true;
    });
    await sleep(20);
    assert.equal(drained, false);
    other.scheduledTasks.pause(task.id);
    release.resolve();
    await shutdown;
    assert.deepEqual(
      runs(task.id).map((x) => x.state),
      ["Completed"],
    );
    other.scheduledTasks.resume(task.id);
    await until(() => runs(task.id).length === 2 && runs(task.id)[1].state === "Completed");
    assert.equal(runs(task.id)[1].id, secondSlot);
    assert.deepEqual(
      runs(task.id).map((x) => x.due_at),
      [start, start + 3000],
    );
  } finally {
    release.resolve();
  }
});

test("automatic admission persists a revoked grant failure before invoking any provider", async (t) => {
  const grants = [];
  let calls = 0;
  const { app, db, clock, define } = await fixture(
    t,
    () => {
      calls++;
      return createDevManagerMock("fixture");
    },
    grants,
  );
  const definition = define({ kind: "once", at: clock.value + 1000 });
  const connectionId = randomUUID();
  const repo = createMcpRepository(db, () => clock.value);
  const doc = { name: "inspect", inputSchema: { type: "object", properties: {} } };
  repo.save(
    connectionId,
    {
      name: "Fixture",
      description: "Local fixture",
      endpoint: "http://127.0.0.1:1/mcp",
      transport: "streamable-http",
      auth: { type: "none" },
    },
    null,
    undefined,
    true,
  );
  repo.synchronize(connectionId, 1, [doc]);

  const toolId = repo.catalog(connectionId).tools[0].toolId;
  grants.push({
    schedulerScope:true,
    connectionId,
    toolId,
    revision: 1,
    definition: policyDigest(doc),
    arguments: {},
    safety: "read-only",
  });
  const task = createStarted(app.scheduledTasks, { ...definition, permissions: [{ connectionId, toolId }] });
  grants.length = 0;
  clock.value += 1000;
  const occurrence = db.prepare("SELECT id FROM scheduled_occurrences WHERE task_id=?");
  await until(() => occurrence.get(task.id));
  const failed = app.scheduledTasks.getOccurrence(occurrence.get(task.id).id);
  assert.equal(failed.state, "Failed");
  assert.equal(failed.error, "authorization");
  assert.equal(failed.started_at, null);
  assert.equal(failed.finished_at, clock.value);
  assert.equal(calls, 0);
});

test("Step 2 database upgrade preserves consumed slots and paused one-time work", async (t) => {
  const { app, db, clock, define, open, close, runs } = await fixture(t);
  const task = createStarted(app.scheduledTasks, define({ kind: "once", at: clock.value }));
  const due = clock.value + 1000;
  const pending = createStarted(app.scheduledTasks, define({ kind: "once", at: due }));
  const pendingId = app.scheduledTasks.materialize(pending.id, due);
  app.scheduledTasks.pause(pending.id);
  await until(() => runs(task.id)[0]?.state === "Completed");
  await close(app);
  // Return only this disposable database to the Step 2 table layout. Keep
  // both occurrences, the real journal receipt and the application history.
  db.exec(
    "DROP INDEX scheduled_due; ALTER TABLE scheduled_tasks DROP COLUMN pending_start; ALTER TABLE scheduled_tasks DROP COLUMN stopped; ALTER TABLE scheduled_tasks DROP COLUMN next_due_at",
  );
  clock.value = due + 10000;
  const upgraded = open().scheduledTasks;
  await until(() => upgraded.getTask(task.id).next_due_at === null);
  assert.equal(runs(task.id).length, 1);
  assert.equal(upgraded.getTask(pending.id).pending_start,0);
  await assert.rejects(upgraded.executeOccurrence(pendingId), { status: 409 });
  assert.equal(upgraded.getOccurrence(pendingId).state, "Pending");
  upgraded.resume(pending.id);
  await until(() => upgraded.getOccurrence(pendingId).state === "Completed");
  assert.equal(runs(pending.id).length, 1);
  assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("each occurrence has a fresh Manager context and an atomic task-owned result",async t=>{
  const seen=[];
  const {app,db,clock,define}=await fixture(t,()=>({complete:async request=>{
    const previous=seen.length;
    assert.equal(request.messages.filter(m=>m.role==="user").length,1);
    assert.ok(request.messages.every(m=>!m.content.includes("prior-result")));
    assert.deepEqual(request.tools,[]);
    seen.push(request.messages.at(-1).content);
    return {text:JSON.stringify({version:1,format:"text",content:"prior-result-"+previous})};
  }}));
  const task=createStarted(app.scheduledTasks, define({kind:"interval",startAt:clock.value,everyMs:1000}));
  const results=()=>db.prepare("SELECT response,result_format FROM scheduled_occurrences WHERE task_id=? AND response IS NOT NULL ORDER BY due_at").all(task.id);
  await until(()=>results().length===1);clock.value+=1000;await until(()=>results().length===2);
  assert.equal(seen.length,2);
  assert.deepEqual(results().map(r=>[r.result_format,JSON.parse(r.response).content]),[["text","prior-result-0"],["text","prior-result-1"]]);
  assert.equal(db.prepare("SELECT count(*) n FROM week3_sessions").get().n,0);
});

test("a delivered answer cannot complete an occurrence whose granted tool failed schema resolution", async t => {
  const grants=[];
  const {app,db,clock,define,runs}=await fixture(t,()=>({complete:async request=>{
    assert.equal(request.tools.length,0);
    if (request.messages.some(message => message.role === "user" && message.content.includes("text-only fixture")))
      return {text:JSON.stringify({blockedToolIds:[], partialResult:"Text-only fixture result."})};
    return {text:"The model produced an answer."};
  }}),grants);
  const repo=createMcpRepository(db,()=>clock.value), connectionId=randomUUID();
  repo.save(connectionId,{name:"Fixture",description:"",endpoint:"http://localhost:9000/mcp",transport:"streamable-http",auth:{type:"none"}},null,undefined,true);
  const doc={name:"test_tool",inputSchema:{type:"object",properties:{field:{type:"string",format:"unknown-format"}}}};
  repo.synchronize(connectionId,1,[doc]);
  const {toolId}=repo.catalog(connectionId).tools[0];
  grants.push({connectionId,toolId,schedulerScope:true,revision:1,safety:"read-only",definition:policyDigest(doc),arguments:{}});
  const task=createStarted(app.scheduledTasks, {...define({kind:"once",at:clock.value}),permissions:[{connectionId,toolId}]});
  await until(()=>runs(task.id)[0]?.owner===null);
  const result=app.scheduledTasks.getOccurrence(runs(task.id)[0].id);
  assert.equal(result.result.answer,"delivered");
  assert.equal(result.state,"Failed");
  assert.equal(result.error,"unsupported_schema");
  assert.equal(result.resolutionIssues[0].toolId,toolId);
  assert.equal(result.resolutionIssues[0].schemaSide,"input");
  assert.equal(result.resolutionIssues[0].schemaPath,"/properties/field/format");
  assert.match(result.resolutionIssues[0].diagnostic,/date-time/);
  const offline = createStarted(app.scheduledTasks, {...define({kind:"once",at:clock.value}),
    instructions:"Write a text-only fixture summary.",permissions:[{connectionId,toolId}]});
  await until(()=>runs(offline.id)[0]?.owner===null);
  const summary = app.scheduledTasks.getOccurrence(runs(offline.id)[0].id);
  assert.equal(summary.state, "Completed");
  assert.equal(summary.response, "Text-only fixture result.");
  assert.equal(summary.resolutionIssues[0].toolId,toolId);
});

test("retirement fences new admissions, drains the running occurrence and preserves history across restart", async t => {
  const release = Promise.withResolvers();
  const entered = Promise.withResolvers();
  const response = JSON.stringify({version:1,format:"chart",chartType:"bar",x:"region",y:"value",rows:[{region:"East",value:2}]});
  const {app,clock,db,define,open,close,runs} = await fixture(t,()=>({complete:async()=>{
    entered.resolve(); await release.promise; return {text:response};
  }}));
  const start = clock.value, schedule = {kind:"interval",startAt:start,everyMs:1000};
  const task = createStarted(app.scheduledTasks, define(schedule));
  const pending = app.scheduledTasks.materialize(task.id,start+1000);
  await entered.promise;
  const deleting = app.scheduledTasks.deleteTask(task.id);
  let acknowledged = false;
  deleting.then(()=>{acknowledged=true});
  try {
    assert.equal(app.scheduledTasks.getTask(task.id).enabled,false);
    assert.throws(()=>app.scheduledTasks.start(task.id),{status:409});
    assert.equal(app.scheduledTasks.getOccurrence(pending).state,"Cancelled");
    clock.value+=10000;
    await sleep(35);
    assert.equal(runs(task.id).length,1);
    assert.equal(acknowledged,false);
  } finally { release.resolve(); }
  await deleting;
  await app.scheduledTasks.deleteTask(task.id);
  assert.throws(()=>app.scheduledTasks.getTask(task.id),{status:404});
  await close(app);
  const second=open();
  clock.value+=10000; await sleep(45);
  assert.equal(runs(task.id).length,1);
  assert.equal(second.scheduledTasks.getOccurrence(runs(task.id)[0].id).response,response);
  assert.equal(db.prepare("SELECT result_format FROM scheduled_occurrences WHERE id=?").get(runs(task.id)[0].id).result_format,"chart");
  assert.throws(()=>second.scheduledTasks.start(task.id),{status:404});
});

test("task controls publish committed transitions, skip no-ops and retain history after deletion", async t=>{
  const {app,db,clock,define,close}=await fixture(t);
  await close(app);
  const events=[];
  const path=db.location();
  const active=createSessionServer(path,{schedulerOptions:{log:(event,fields)=>events.push({event,...fields})}});
  t.after(async()=>{await active.stopExecutions(); const closed=once(active,"close");active.close();await closed});
  const svc=active.scheduledTasks;
  const task=svc.createTask({...define({kind:"once",at:Date.now()+3600000}),name:"Lifecycle sample",enabled:false});
  svc.start(task.id);svc.pause(task.id);svc.resume(task.id);svc.stop(task.id);svc.stop(task.id);
  assert.throws(()=>svc.resume(task.id),{status:409});
  await svc.deleteTask(task.id);
  await assert.rejects(svc.deleteTask(randomUUID()),{status:404});
  assert.deepEqual(events.map(event=>event.event),["task_created","task_started","task_paused","task_resumed","task_stopped","task_delete_requested","task_deleted","task_delete_failed"]);
  assert.ok(events.slice(0,-1).every(e=>e.taskName==="Lifecycle sample"&&e.taskId===task.id));
});

test("restart completes an interrupted retirement without removing another task's grant or shared catalog",async t=>{
  const grants=[];
  const {app,db,clock,define,open,close}=await fixture(t,undefined,grants);
  const repo=createMcpRepository(db,()=>clock.value), connectionId=randomUUID();
  repo.save(connectionId,{name:"Shared fixture",description:"",endpoint:"http://localhost:9000/mcp",transport:"streamable-http",auth:{type:"none"}},null,undefined,true);
  const doc={name:"inspect",inputSchema:{type:"object"}};
  repo.synchronize(connectionId,1,[doc]);
  const {toolId}=repo.catalog(connectionId).tools[0];
  grants.push({connectionId,toolId,schedulerScope:true,revision:1,safety:"read-only",definition:policyDigest(doc),arguments:{}});
  const def={...define({kind:"once",at:clock.value+60000}),permissions:[{toolId,connectionId}],enabled:false};
  const retiring=app.scheduledTasks.createTask(def), other=app.scheduledTasks.createTask(def);
  await close(app);
  // Crash boundary after durable deactivation, before the cleanup transaction.
  db.prepare("UPDATE scheduled_tasks SET deletion_state=1,stopped=1,next_due_at=NULL WHERE id=?").run(retiring.id);
  const restarted=open();
  await until(()=>db.prepare("SELECT deletion_state s FROM scheduled_tasks WHERE id=?").get(retiring.id).s===2);
  assert.equal(db.prepare("SELECT count(*) n FROM scheduled_task_tools WHERE task_id=?").get(retiring.id).n,0);
  assert.deepEqual(restarted.scheduledTasks.getTask(other.id).permissions,[{connectionId,toolId}]);
  assert.equal(repo.catalog(connectionId).tools[0].toolId,toolId);
});

test("consumed one-time tasks restart with a new occurrence; an uncertain write needs occurrence-specific confirmation", async t=>{
 const {app,db,clock,define,runs,open,close}=await fixture(t);
 const svc=app.scheduledTasks;
 const task=createStarted(svc, define({kind:"once",at:clock.value}));
 await until(()=>runs(task.id)[0]?.state==="Completed");
 const first=runs(task.id)[0].id;
 // Simulate a lost run receipt; even the absence of visible tool calls cannot establish safety.
 db.prepare("UPDATE week4_runs SET state='RequiresReview' WHERE id=?").run(first);
 svc.stop(task.id);
 const api = await client(app);
 const denial = await api("/" + task.id + "/resume", "POST", undefined, 409);
 assert.match(denial.error, /Review the uncertain execution/);
 assert.throws(()=>svc.start(task.id),{status:409});
 assert.throws(()=>svc.review(task.id,{confirmed:true,revision:task.revision,occurrenceIds:[randomUUID()]}),{status:409});
 svc.review(task.id,{confirmed:true,revision:task.revision,occurrenceIds:[first]});
 await close(app);
 const restored=open().scheduledTasks;
 assert.equal(restored.getTask(task.id).stopped,true);
 clock.value+=10;
 restored.start(task.id);
 await until(()=>runs(task.id).some(r=>r.state==="Completed"));
 assert.equal(runs(task.id).length,2);
 assert.equal(restored.getOccurrence(first).state,"RequiresReview");
});

test("pause, continue and stop fence multiple future intervals without duplicating occurrences", async t=>{
 const {app,clock,define,runs}=await fixture(t);
 const svc=app.scheduledTasks;
 const task=createStarted(svc, define({kind:"interval",startAt:clock.value,everyMs:1000}));
 await until(()=>runs(task.id)[0]?.state==="Completed");
 svc.pause(task.id);clock.value+=3000;
 await sleep(55);assert.equal(runs(task.id).length,1);
 svc.resume(task.id);
 await until(()=>runs(task.id).filter(r=>r.state==="Completed").length===2);
 clock.value+=1000;
 await until(()=>runs(task.id).filter(r=>r.state==="Completed").length===3);
 svc.stop(task.id);clock.value+=3000;await sleep(55);
 assert.equal(runs(task.id).length,3);
 assert.equal(new Set(runs(task.id).map(r=>r.due_at)).size,3);
});

test("failed and paused tasks can be retired without losing their original outcomes",async t=>{
 const {app,clock,define,runs}=await fixture(t,()=>({complete:async()=>{throw Error("simulated provider failure")}}));
 const svc=app.scheduledTasks;
 const failed=createStarted(svc, define({kind:"once",at:clock.value}));
 await until(()=>runs(failed.id)[0]?.state==="Failed");
 const id=runs(failed.id)[0].id;
 await svc.deleteTask(failed.id);
 assert.equal(svc.getOccurrence(id).state,"Failed");
 const paused=svc.createTask({...define({kind:"interval",startAt:clock.value,everyMs:10}),enabled:false});
 svc.start(paused.id);
 svc.pause(paused.id);
 await svc.deleteTask(paused.id);
 assert.throws(()=>svc.resume(paused.id),{status:404});
 assert.equal(runs(paused.id).length,0);
});

async function client(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = "http://127.0.0.1:" + server.address().port;
  return async (path, method = "GET", body, expected = 200, ifMatch) => {
    const r = await fetch(origin + "/api/scheduler/tasks" + path, {
      method, headers: { origin, "x-day18-ui": "scheduler", "content-type": "application/json",
        ...(ifMatch && {"if-match":ifMatch}) },
      body: body && JSON.stringify(body),
    });
    assert.equal(r.status, expected);
    return r.json();
  };
}

for (const resumeBeforeFinish of [true, false]) {
  test(`an admitted execution finishes with scheduling ${resumeBeforeFinish ? "resumed" : "paused"}`, async t => {
    const release = Promise.withResolvers();
    let calls = 0;
    const {app, clock, define, runs, close, open} = await fixture(t, () => ({
      complete: async () => {
        if (++calls === 1) await release.promise;
        return {text:"Stored fixture result " + calls};
      },
    }));
    const start = clock.value, interval = 1000;
    const task = createStarted(app.scheduledTasks, define({kind:"interval", startAt:start, everyMs:interval}));
    let api = await client(app);
    const path = "/" + task.id;
    const read = async () => (await api("")).find(row => row.id === task.id);
    const token = row => `"${row.revision}-${row.updated_at}"`;
    try {
      await until(() => calls === 1);
      const original = runs(task.id)[0].id;
      let row = await read();
      for (let i = 0; i < 3; i++) {
        const oldToken = token(row);
        row = await api(path + "/pause", "POST", undefined, 200, oldToken);
        assert.equal(row.schedulingState, "Paused");
        assert.equal(row.executionActive, true);
        assert.equal((await read()).metrics.active, 1);
        if (i === 2 && !resumeBeforeFinish) break;
        row = await api(path + "/resume", "POST", undefined, 200, token(row));
        assert.equal(row.schedulingState, "Running");
        assert.equal(row.executionActive, true);
        const repeated = await api(path + "/resume", "POST", undefined, 200, token(row));
        assert.equal(repeated.updated_at, row.updated_at);
        assert.equal(repeated.schedulingState, "Running");
        // An old tab still sees Running, but cannot undo the newer Continue.
        await api(path + "/pause", "POST", undefined, 409, oldToken);
      }
      clock.value += interval * 3;
      await sleep(45);
      assert.deepEqual(runs(task.id).map(r => [r.id,r.state]), [[original,"Running"]]);
      release.resolve();
      await until(() => runs(task.id)[0].state === "Completed");
      if (resumeBeforeFinish) await until(() => runs(task.id)[1]?.state === "Completed");
      const count = resumeBeforeFinish ? 2 : 1;
      const slots = runs(task.id).map(r => r.due_at);
      assert.deepEqual(slots, resumeBeforeFinish ? [start,clock.value] : [start]);
      const before = await api(path + "/history");
      assert.equal(before.rows.length, count);
      const report = await api(path + "/result");
      assert.equal(report.rows[0].response, "Stored fixture result " + count);
      await close(app);
      api = await client(open());
      row = await read();
      assert.equal(row.schedulingState, resumeBeforeFinish ? "Running" : "Paused");
      assert.equal(row.metrics.active, 0);
      assert.deepEqual(await api(path + "/history"), before);
      assert.deepEqual(await api(path + "/result"), report);
      if (!resumeBeforeFinish) {
        await api(path + "/resume", "POST", undefined, 200, token(row));
        await until(() => runs(task.id)[1]?.state === "Completed");
      }
      clock.value += interval;
      await until(() => runs(task.id)[2]?.state === "Completed");
      await api(path + "/stop", "POST");
      clock.value += 2 * interval;
      await sleep(45);
      assert.equal(calls, 3);
      assert.equal((await read()).schedulingState, "Stopped");
      assert.equal(new Set(runs(task.id).map(r => r.due_at)).size, 3);
    } finally { release.resolve(); }
  });
}

for (const action of ["resume", "stop"]) {
  test(`${action} during an admitted one-time occurrence does not rearm it`, async t => {
    const release = Promise.withResolvers();
    let calls = 0;
    const {app, clock, define, runs} = await fixture(t, () => ({
      complete: async () => { calls++; await release.promise; return {text:"One-time fixture"}; },
    }));
    const svc = app.scheduledTasks;
    const task = createStarted(svc, define({kind:"once", at:clock.value}));
    try {
      await until(() => calls === 1);
      svc.pause(task.id);
      svc[action](task.id);
      if (action === "stop") assert.throws(() => svc.start(task.id), {status:409});
      release.resolve();
      await until(() => runs(task.id)[0].state === "Completed");
      clock.value += 10000;
      await sleep(45);
      assert.equal(svc.getTask(task.id).next_due_at, null);
      assert.equal(svc.getTask(task.id).stopped, action === "stop");
      assert.equal(runs(task.id).length, 1);
      assert.equal(calls, 1);
    } finally { release.resolve(); }
  });
}

test("a new task remains Pending through edits, polling and restart until Start arms its schedule", async t => {
  const { app, clock, open, close, define, runs } = await fixture(t);
  let api = await client(app);
  const interval = 10_000;
  const def = { ...define({ kind: "interval", startAt: clock.value, everyMs: interval }),
    name: "Pending fixture", permissions: [] };
  assert.throws(() => app.scheduledTasks.createTask({ ...def, enabled: true }), {status:400});
  const task = await api("", "POST", def, 201);
  assert.equal(task.status, "Pending");
  assert.equal(task.next_due_at, null);
  const path = "/" + task.id;
  for (const action of ["pause","resume","stop"]) await api(path + "/" + action, "POST", undefined, 409);
  assert.throws(() => app.scheduledTasks.configure(task.id, task.revision, {enabled:true}), {status:409});
  const edited = await api(path, "PUT", { ...def, revision: task.revision,
    schedule: { ...def.schedule, startAt: clock.value + interval } });
  assert.equal(edited.status, "Pending");
  assert.equal(edited.next_due_at, null);
  clock.value += 3 * interval;
  await sleep(45);
  await close(app);
  api = await client(open());
  const [restored] = await api("");
  assert.equal(restored.status, "Pending");
  assert.equal(restored.enabled, false);
  assert.equal(restored.next_due_at, null);
  assert.deepEqual((await api(path + "/history")).rows, []);
  assert.deepEqual((await api(path + "/result")).rows, []);
  assert.equal((await api(path + "/start", "POST")).status, "Scheduled");
  await until(() => runs(task.id)[0]?.state === "Completed");
  assert.equal((await api(path + "/pause", "POST")).status, "Paused");
  clock.value += 2 * interval;
  await sleep(45);
  assert.equal(runs(task.id).length, 1);
  assert.equal((await api(path + "/resume", "POST")).status, "Scheduled");
  await until(() => runs(task.id)[1]?.state === "Completed");
  assert.equal((await api(path + "/stop", "POST")).status, "Stopped");
  clock.value += 3 * interval;
  await sleep(45);
  assert.equal(runs(task.id).length, 2);
});

test("task list orders persisted lifecycle groups by newest creation across transitions and restart", async t => {
  const {app,clock,define,open,close} = await fixture(t);
  let api = await client(app);
  const ids = [];
  for (let i = 0; i < 8; i++) {
    clock.value++;
    const task = app.scheduledTasks.createTask(define({kind:"once", at:clock.value + 100000}));
    ids.push(task.id);
  }
  const order = async (...positions) => assert.deepEqual((await api("")).map(task => task.id), positions.map(i => ids[i]));
  await order(7,6,5,4,3,2,1,0);
  for (const i of [0,1,2,3,4,5]) app.scheduledTasks.start(ids[i]);
  for (const i of [3,4]) app.scheduledTasks.pause(ids[i]);
  for (const i of [0,5]) app.scheduledTasks.stop(ids[i]);
  await order(7,6,4,3,2,1,5,0);
  app.scheduledTasks.resume(ids[4]);
  await order(7,6,3,4,2,1,5,0);
  await close(app);
  api = await client(open());
  await order(7,6,3,4,2,1,5,0);
});
