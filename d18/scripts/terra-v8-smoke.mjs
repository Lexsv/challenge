// Opt-in live check. Pass the port of the existing local saved-provider proxy.
// Only the provider transport is shared. Chats, settings and receipts use a fresh DB.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createSessionServer } from "../server/sessions.mjs";
import { invariantProvider } from "../server/invariant-provider.mjs";

const port = Number(process.argv[2]);
assert.ok(Number.isInteger(port) && port > 0 && port <= 65535, "Specify the local provider proxy port.");
const proxy = "http://127.0.0.1:" + port;
const directory = await mkdtemp(join(tmpdir(), "d15-v8-"));
let path = join(directory, "chat.sqlite");
const model = "gpt-5.6-terra";
let calls = 0, blocked, server, base;
const { adapter } = invariantProvider(undefined, async (id, request) => {
  assert.equal(id, "openai");
  assert.equal(request.model, model);
  if (blocked) throw Error(blocked);
  calls++;
  let res;
  try {
    res = await fetch(proxy + "/api/credentials/openai/request", {
      method: "POST", headers: {Origin:proxy, "Content-Type":"application/json"},
      body: JSON.stringify(request), signal: AbortSignal.timeout(90000)
    });
  } catch { blocked = "Provider proxy unavailable"; throw Error(blocked); }
  const body = await res.json();
  const status = body.providerError?.status ?? res.status;
  if ([401,403,429].includes(status) || res.status >= 500) {
    blocked = "Provider HTTP " + status + " (local proxy HTTP " + res.status + ")";
    throw Error(blocked);
  }
  assert.equal(res.status,200,"Provider HTTP "+res.status);
  assert.equal(body.model,model);
  return {status:res.status,body};
});
const listen = app => new Promise(resolve=>app.listen(0,"127.0.0.1",resolve));
const close = app => new Promise(resolve=>app.close(resolve));
async function start(){
  server=createSessionServer(path,{invariantAdapter:adapter});
  await listen(server);
  base="http://127.0.0.1:"+server.address().port+"/api/week3/sessions";
}
async function api(route,body){
  const res=await fetch(base+route,body===undefined?{}:{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
  const data=await res.json();
  assert.ok(res.ok,blocked ?? ("Week 3 HTTP "+res.status+" "+(data.stage ?? "")));
  return data;
}
const session=async()=>"/"+(await api("",{})).id;
const command=(question,turnId=crypto.randomUUID())=>({provider:"openai",model,execute:true,turnId,question});
const send=(s,q)=>api(s+"/invariant-turn",command(q));
const memory=s=>api(s+"/memory");
const events=s=>api(s+"/events");
const seed="Поездка на озеро: 20 июля 2027 года. Едут Сергей и Лена.";
function receipts(s){
  const db=new DatabaseSync(path,{readOnly:true});
  try{return db.prepare("SELECT * FROM week3_proposal_receipts WHERE session_id=? ORDER BY turn_id").all(s.slice(1));}
  finally{db.close();}
}
async function restart(){ await close(server); await start(); }
const enable=s=>api(s+"/invariants",{text:"Always mention ПРОВЕРЕНО"});

async function recall(){
  const s=await session(); await send(s,seed);
  const baseline=(await memory(s)).data;
  const detail=command("Для рассказа запомни: на пристани у озера висел «янтарный фонарь», не для плана.");
  await api(s+"/invariant-turn",detail);
  const filler=command("Прочти образец текста. "+"Образец текста. ".repeat(520));
  await api(s+"/invariant-turn",filler);
  const saved=await memory(s);
  assert.ok(saved.data.covered.includes(detail.turnId));
  assert.ok(!saved.data.short.some(g=>g.id===detail.turnId || g.id==="current:user-"+detail.turnId));
  assert.ok(saved.data.summary.includes("янтарный фонарь"));
  assert.deepEqual(saved.data.catalog.cards,baseline.catalog.cards);
  assert.deepEqual(saved.data.facts,baseline.facts);
  assert.ok((await events(s)).some(e=>e.payload.runId===filler.turnId && e.payload.text===filler.question));
  await restart(); assert.deepEqual(await memory(s),saved);
  const query=command("Какой фонарь висел на пристани у озера?");
  await api(s+"/invariant-turn",query);
  const reply=(await events(s)).find(e=>e.payload.role==="assistant" && e.payload.runId===query.turnId);
  assert.match(reply.payload.text,/янтарный фонарь/iu);
}
async function parity(){
  const snapshots=[];
  const s=await session(); await send(s,seed);
  const baseline=await memory(s), baselineHistory=await events(s), baselineReceipts=receipts(s);
  const copy=join(directory,"parity.sqlite");
  const db=new DatabaseSync(path);
  try{db.prepare("VACUUM INTO ?").run(copy);}finally{db.close();}
  const update=command("Перенеси поездку на озеро на 1 сентября 2027 года.");
  for(const protectedChat of [false,true]){
    if(protectedChat){await close(server);path=copy;await start();}
    assert.deepEqual(await memory(s),baseline);
    assert.deepEqual(await events(s),baselineHistory);
    assert.deepEqual(receipts(s),baselineReceipts);
    const initial=(await memory(s)).data.catalog.cards;
    assert.equal(initial.length,1);
    assert.deepEqual(Object.fromEntries(initial[0].changes.map(c=>[c.field,c.value])),{date:"2027-07-20",participants:["Сергей","Лена"]});
    if(protectedChat) await enable(s);
    await api(s+"/invariant-turn",update);
    const snap=await memory(s), transcript=(await events(s)).filter(e=>e.type==="message");
    assert.equal(transcript.length,4);
    const ack=transcript.find(e=>e.payload.runId===update.turnId && e.payload.role==="assistant").payload.text;
    assert.match(ack,/2027-07-20.*2027-09-01/);
    assert.equal(ack.includes("ПРОВЕРЕНО"),protectedChat);
    const fields=snap.data.catalog.cards[0].changes.map(c=>[c.field,c.value]);
    assert.deepEqual(fields.filter(([field])=>field==="date").map(([,value])=>value),["2027-07-20","2027-09-01"]);
    assert.deepEqual(fields.filter(([field])=>field==="participants").map(([,value])=>value),[["Сергей","Лена"]]);
    const stamps=receipts(s);assert.equal(stamps.length,2);assert.ok(stamps.some(r=>r.turn_id===update.turnId));
    snapshots.push({fields,revision:snap.revision,messages:transcript.map(e=>[e.payload.role,e.payload.text.replace(/ ПРОВЕРЕНО$/u,"")]),receipts:stamps});
  }
  assert.deepEqual(snapshots[0],snapshots[1]);
}
async function dropped(protectedChat){
  const s=await session(); await send(s,seed); if(protectedChat) await enable(s);
  const request=command("Перенеси поездку на озеро на 12 декабря 2027 года.");
  let committed, failure;
  const relay=createServer(async (_req,res)=>{
    try {
      committed=await api(s+"/invariant-turn",request);
      assert.ok(receipts(s).some(r=>r.turn_id===request.turnId),"Missing receipt before dropping response");
    }catch(e){failure=e;}
    finally{res.destroy();}
  });
  await listen(relay);
  try{await assert.rejects(fetch("http://127.0.0.1:"+relay.address().port,{method:"POST"}),/fetch failed/i);}
  finally{await close(relay);}
  if(failure)throw failure;
  const saved=await memory(s),history=await events(s),stamps=receipts(s),before=calls;
  assert.equal(committed.status,"completed");
  assert.equal(history.filter(e=>e.type==="message" && e.payload.runId===request.turnId).length,2);
  assert.deepEqual(saved.data.catalog.cards[0].changes.filter(c=>c.field==="date").map(c=>c.value),["2027-07-20","2027-12-12"]);
  await restart();
  assert.deepEqual(await api(s+"/invariant-turn",request),committed);
  assert.equal(calls,before);assert.deepEqual(await memory(s),saved);assert.deepEqual(await events(s),history);assert.deepEqual(receipts(s),stamps);
}
await start();
try{
  for(const [name,run] of [["S12",recall],["S17",parity],["S19 unrestricted",()=>dropped(false)],["S19 protected",()=>dropped(true)]]){
    if(blocked){console.log(name,"NOT EXERCISED");continue;}
    const before=calls;
    try{await run();console.log(name,"PASS",calls-before,"provider calls");}
    catch(e){console.log(name,blocked?"BLOCKED":"FAIL",blocked ?? e.message,calls-before,"provider attempts");process.exitCode=1;}
  }
}finally{await close(server);}
