import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import test, { type TestContext } from "node:test";
import { gunzipSync } from "node:zlib";
import { captureOutput, rotationSettings } from "../src/infrastructure/rotating-output.js";

async function logDirectory(t: TestContext) {
  await mkdir(".test-data", { recursive: true });
  const directory = await mkdtemp(".test-data/rotation-");
  t.after(() => rm(directory, { recursive: true }));
  return directory;
}

test("rotation defaults to 10 MB and five archives; settings enforce the ceilings", () => {
  assert.equal(rotationSettings({}).maxBytes, 10_000_000);
  assert.equal(rotationSettings({}).archives, 5);
  assert.equal(rotationSettings({ LOG_MAX_SIZE_MB: "2", LOG_MAX_ARCHIVES: "3" }).maxBytes, 2_000_000);
  for (const env of [{ LOG_DIR: "" }, { LOG_MAX_SIZE_MB: "0" }, { LOG_MAX_SIZE_MB: "11" },
    { LOG_MAX_ARCHIVES: "6" }, { LOG_MAX_ARCHIVES: "1.5" }]) {
    assert.throws(() => rotationSettings(env));
  }
});

test("both output streams rotate independently, preserve JSON lines and evict oldest gzip archives", async t => {
  const directory = await logDirectory(t);
  const settings = { directory, maxBytes: 4096, archives: 5 };
  for (const name of ["stdout.log", "scheduler.log"] as const) {
    const lines = Array.from({ length: 600 }, (_, index) =>
      JSON.stringify({ time: new Date(0).toISOString(), level: "info", event: "test", name, index }) + "\n");
    const bytes = Buffer.from(lines.join(""));
    await captureOutput(Readable.from([bytes.subarray(0, 7), bytes.subarray(7)]), name, settings);
    const files = (await readdir(directory)).filter(f => f === name || f.startsWith(name + "."));
    assert.equal(files.length, 6);
    const retained: number[] = [];
    for (const suffix of [".5.gz", ".4.gz", ".3.gz", ".2.gz", ".1.gz", ""]) {
      const path = join(directory, name + suffix);
      const raw = await readFile(path);
      if (suffix) assert.deepEqual([...raw.subarray(0, 2)], [0x1f, 0x8b]);
      const plain = suffix ? gunzipSync(raw) : raw;
      assert.ok(plain.length <= settings.maxBytes);
      assert.equal((await stat(path)).mode & 0o777, 0o600);
      for (const line of plain.toString().trimEnd().split("\n").filter(Boolean)) {
        const entry = JSON.parse(line);
        assert.equal(entry.name, name);
        retained.push(entry.index);
      }
    }
    assert.ok(retained[0]! > 0);
    assert.deepEqual(retained, lines.map((_, i) => i).slice(retained[0]));
  }
});

test("reopen handles an existing launchd file and a reduced retention setting", async t => {
  const directory = await logDirectory(t);
  const name = "scheduler.log";
  const path = join(directory, name);
  const initial = Buffer.alloc(4095, 65);
  await writeFile(path, initial);
  await writeFile(path + ".3.gz", "old");
  await writeFile(join(directory, "unrelated.3.gz"), "keep");
  const tail = Buffer.from("runtime output without a final newline");
  await captureOutput(Readable.from([tail]), name, { directory, maxBytes: 4096, archives: 2 });
  assert.deepEqual(gunzipSync(await readFile(path + ".1.gz")), initial);
  assert.deepEqual(await readFile(path), tail);
  assert.deepEqual((await readdir(directory)).sort(), [name, name + ".1.gz", "unrelated.3.gz"]);
});

test("long unbroken native output stays byte-exact across bounded files", async t => {
  const directory = await logDirectory(t);
  const bytes = Buffer.alloc(2700, 0xff);
  const settings = { directory, maxBytes: 1024, archives: 5 };
  await captureOutput(Readable.from([bytes]), "stdout.log", settings);
  const saved = [];
  for (const name of (await readdir(directory)).sort().reverse()) {
    const raw = await readFile(join(directory, name));
    const plain = name.endsWith(".gz") ? gunzipSync(raw) : raw;
    assert.ok(plain.length <= settings.maxBytes);
    saved.push(plain);
  }
  assert.deepEqual(Buffer.concat(saved), bytes);
});
