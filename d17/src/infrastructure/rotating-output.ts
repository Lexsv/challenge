import { mkdir, readdir, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createStream } from "rotating-file-stream";
import { integer } from "../config/config.js";

export function rotationSettings(env: NodeJS.ProcessEnv) {
  const directory = env.LOG_DIR ?? "./data/logs";
  if (!directory.trim()) throw new Error("LOG_DIR is empty");
  return {
    directory: resolve(directory),
    maxBytes: integer("LOG_MAX_SIZE_MB", env.LOG_MAX_SIZE_MB ?? "10", 10) * 1_000_000,
    archives: integer("LOG_MAX_ARCHIVES", env.LOG_MAX_ARCHIVES ?? "5", 5)
  };
}

type Settings = ReturnType<typeof rotationSettings>;

// Pipe reads may coalesce many JSON lines or split a single line. Pass whole
// records to the rotator; fragment unusually long native diagnostic lines.
async function* records(input: AsyncIterable<Buffer>, blockSize: number) {
  let remainder: Buffer = Buffer.alloc(0);
  for await (const chunk of input) {
    const buffer = remainder.length ? Buffer.concat([remainder, chunk]) : chunk;
    let start = 0;
    while (start < buffer.length) {
      const block = buffer.subarray(start, start + blockSize);
      const newline = block.indexOf(10);
      if (newline < 0 && block.length < blockSize) break;
      const length = newline < 0 ? block.length : newline + 1;
      yield block.subarray(0, length);
      start += length;
    }
    remainder = buffer.subarray(start);
  }
  if (remainder.length) yield remainder;
}

export async function captureOutput(input: Readable, name: "stdout.log" | "scheduler.log", settings: Settings) {
  const { directory, maxBytes, archives } = settings;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // Classical rotation replaces the last numbered archive. Also honor a
  // reduced retention setting immediately when reopening an existing series.
  for (const file of await readdir(directory)) {
    if (!file.startsWith(name + ".")) continue;
    const match = /^(\d+)\.gz$/.exec(file.slice(name.length + 1));
    if (match && Number(match[1]) > archives) await unlink(join(directory, file));
  }

  // The library checks size after each write. Reserve one bounded write so
  // even the final record cannot take a file past the configured byte limit.
  const blockSize = Math.min(64 * 1024, Math.max(1, Math.floor(maxBytes / 16)));
  const output = createStream(name, {
    path: directory, size: `${maxBytes - blockSize + 1}B`,
    rotate: archives, compress: "gzip", mode: 0o600
  });
  await pipeline(records(input, blockSize), output);
}
