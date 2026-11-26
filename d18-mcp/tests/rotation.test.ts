import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { gunzipSync } from "node:zlib";
import { LOG_BUDGET, RotatingLogs } from "../src/rotating-logs.js";

const temporary = () => mkdtempSync(join(tmpdir(), "weather-rotation-"));
const size = (dir: string) => readdirSync(dir).reduce((n,p) => n + statSync(join(dir,p)).size, 0);

test("shared production cap retains the latest bytes from both streams across eviction and reopen", () => {
  const dir = temporary();
  try {
    let logs = new RotatingLogs(dir);
    const streams = {"error.log": [] as Buffer[], "server.log": [] as Buffer[]};
    let peak = 0;
    for (let i = 0; i < 120; i++) {
      const name = i % 3 ? "server.log" : "error.log";
      const data = randomBytes(250000);
      streams[name].push(data);
      logs.write(name, data);
      peak = Math.max(peak, size(dir));
      assert.ok(size(dir) <= LOG_BUDGET);
      if (i === 45) logs = new RotatingLogs(dir);
    }
    for (const name of ["server.log","error.log"] as const) {
      const gz = readdirSync(dir).filter(p => p.startsWith(name + ".") && p.endsWith(".gz")).sort();
      assert.ok(gz.length && !gz[0]!.includes("000000000001"));
      const kept = Buffer.concat([...gz.map(p => gunzipSync(readFileSync(join(dir,p)))),readFileSync(join(dir,name))]);
      assert.ok(kept.length > 0);
      assert.deepEqual(kept, Buffer.concat(streams[name]).subarray(-kept.length));
    }
    console.info(`30,000,000 bytes written; largest sampled aggregate ${peak} bytes.`);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test("interrupted compression resumes and discards partial gzip without losing original bytes", () => {
  const dir = temporary();
  try {
    writeFileSync(join(dir,"server.log.000000000001.raw"),"existing startup\n");
    writeFileSync(join(dir,"server.log.000000000001.tmp"),"partial");
    writeFileSync(join(dir,"error.log"),"previous warning\n");
    const logs = new RotatingLogs(dir,4096);
    logs.write("error.log",Buffer.from("new warning\n"));
    assert.equal(gunzipSync(readFileSync(join(dir,"server.log.000000000001.gz"))).toString(),"existing startup\n");
    assert.equal(readFileSync(join(dir,"error.log"),"utf8"),"previous warning\nnew warning\n");
    assert.ok(readdirSync(dir).every(p => !p.endsWith(".raw") && !p.endsWith(".tmp")));
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test("tail -F follows both live filenames across a rotation without restarting capture", async () => {
  const dir = temporary();
  try {
    const logs = new RotatingLogs(dir, 8192);
    const tail = spawn("tail", ["-n", "+1", "-F", join(dir,"server.log"),join(dir,"error.log")],
      {stdio:["ignore","pipe","pipe"]});
    const closed = once(tail,"close");
    let output = "";
    tail.stdout.on("data",b => {output += b.toString();});
    async function expectBoth(prefix: string) {
      const deadline = Date.now() + 12000;
      while (!output.includes(prefix+"-out") || !output.includes(prefix+"-err")) {
        if (Date.now() > deadline) assert.fail("tail did not receive both " + prefix + " records");
        await delay(50);
      }
    }
    try {
      logs.write("server.log",Buffer.from("before-out\n"));
      logs.write("error.log",Buffer.from("before-err\n"));
      await expectBoth("before");
      logs.write("server.log",Buffer.alloc(1024,10));
      logs.write("server.log",Buffer.from("after-out\n"));
      logs.write("error.log",Buffer.from("after-err\n"));
      await expectBoth("after");
      assert.ok(readdirSync(dir).some(name => name.endsWith(".gz")));
    } finally {tail.kill(); await closed;}
  } finally {rmSync(dir,{recursive:true,force:true});}
});
