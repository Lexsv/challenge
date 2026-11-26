import { appendFileSync, chmodSync, closeSync, openSync, readdirSync, readFileSync,
  renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

export const LOG_BUDGET = 10_000_000;
const channels = ["server.log", "error.log"] as const;
export type Channel = typeof channels[number];
const archivePattern = /^(server\.log|error\.log)\.(\d{12})\.(raw|gz|tmp)$/;

// One writer owns both pipes. Rotate both streams at the same boundary so a
// quiet stderr cannot keep stale records while newer stdout is being evicted.
export class RotatingLogs {
  private activeBytes = 0;
  private archiveBytes = 0;
  private generation = 0;
  private readonly segmentBytes: number;
  private readonly archives: {generation: number; path: string; bytes: number}[] = [];

  constructor(private readonly directory: string, private readonly budget = LOG_BUDGET) {
    if (!Number.isSafeInteger(budget) || budget < 1024 || budget > LOG_BUDGET)
      throw new Error("Log budget must be between 1024 and 10000000 bytes.");
    this.segmentBytes = Math.floor(budget / 8);
    const rawFiles: string[] = [];
    for (const name of readdirSync(directory).sort()) {
      const match = archivePattern.exec(name);
      if (!match) continue;
      const path = join(directory, name), generation = Number(match[2]);
      this.generation = Math.max(this.generation, generation);
      if (match[3] === "tmp") unlinkSync(path);
      if (match[3] === "raw") rawFiles.push(path);
      if (match[3] === "gz") this.remember(path, generation);
    }
    this.archives.sort((a, b) => a.generation - b.generation);
    for (const name of channels) {
      const path = join(directory, name);
      closeSync(openSync(path, "a", 0o600));
      chmodSync(path, 0o600);
      this.activeBytes += statSync(path).size;
    }
    // Recover a capture process interrupted between rename and compression.
    for (const path of rawFiles) this.activeBytes += statSync(path).size;
    for (const path of rawFiles) this.compress(path);
    this.makeRoom(0);
    if (this.activeBytes >= this.segmentBytes) this.rotate();
  }

  private remember(path: string, generation: number) {
    const bytes = statSync(path).size;
    this.archives.push({generation, path, bytes});
    this.archiveBytes += bytes;
  }

  private makeRoom(extra: number) {
    while (this.archiveBytes + this.activeBytes + extra > this.budget) {
      const oldest = this.archives[0]?.generation;
      if (oldest === undefined) throw new Error("Existing logs exceed available rotation space.");
      while (this.archives[0]?.generation === oldest) {
        const file = this.archives.shift()!;
        unlinkSync(file.path);
        this.archiveBytes -= file.bytes;
      }
    }
  }

  private compress(raw: string) {
    const base = raw.slice(0, -4);
    const final = base + ".gz";
    const bytes = statSync(raw).size;
    if (!this.archives.some(a => a.path === final)) {
      const compressed = gzipSync(readFileSync(raw));
      // Include the temporary gzip AND its source in the high-water mark.
      this.makeRoom(compressed.length);
      writeFileSync(base + ".tmp", compressed, {flag: "wx", mode: 0o600});
      renameSync(base + ".tmp", final);
      this.remember(final, Number(base.slice(-12)));
    }
    unlinkSync(raw);
    this.activeBytes -= bytes;
  }

  private rotate() {
    const generation = String(++this.generation).padStart(12, "0");
    for (const name of channels) {
      const path = join(this.directory, name);
      if (statSync(path).size === 0) continue;
      const raw = path + "." + generation + ".raw";
      renameSync(path, raw);
      closeSync(openSync(path, "ax", 0o600));
      this.compress(raw);
    }
  }

  write(channel: Channel, bytes: Buffer) {
    let start = 0;
    while (start < bytes.length) {
      // Prefer to keep each native pipe chunk (usually whole log lines) together.
      if (this.activeBytes && bytes.length - start > this.segmentBytes - this.activeBytes)
        this.rotate();
      const part = bytes.subarray(start, start + this.segmentBytes);
      this.makeRoom(part.length);
      appendFileSync(join(this.directory, channel), part);
      this.activeBytes += part.length;
      start += part.length;
    }
  }
}
