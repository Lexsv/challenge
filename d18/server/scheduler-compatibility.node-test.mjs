import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProviderInputValidator } from "./provider-tool-schema.mjs";
import { schedulerLogger } from "./scheduler-log.mjs";

test("each provider enforces both date-time and the original regular expression", () => {
  for (const provider of ["openai", "opencode-console", "opencode-go"]) {
    const compile = createProviderInputValidator(provider);
    const schema = {
      type: "object",
      properties: {
        stamp: {
          type: "string",
          format: "date-time",
          pattern: "^202[0-9]-[0-9T:.Z-]+$",
        },
      },
    };
    const v = compile(schema, 0);
    assert.equal(v.ok, true);
    assert.equal(v.data({ stamp: "2024-02-29T17:00:00Z" }), true);
    assert.equal(v.data({ stamp: "2023-02-29T17:00:00Z" }), false);
    assert.equal(v.data({ stamp: "2030-02-01T12:00:00Z" }), false);
    for (const rule of [
      { format: "custom" },
      { pattern: "(?:a+)+" },
      { pattern: "^(?=x)x$" },
      { pattern: "^[a-z]+[a-z]+$" },
    ])
      assert.equal(
        compile(
          {
            type: "object",
            properties: { field: { type: "string", ...rule } },
          },
          0,
        ).error.code,
        "unsupported_schema",
      );
  }
});

test("scheduler diagnostics rotate within their combined cap and omit payload fields", () => {
  const dir = mkdtempSync(join(tmpdir(), "sched-logs-"));
  try {
    const log = schedulerLogger(dir, 1200),
      path = join(dir, "scheduler.ndjson");
    for (let i = 0; i < 80; i++)
      log("trigger", {
        issues: i,
        taskName: "System report · Bearer test-secret",
        authorization: "test-secret",
        arguments: { test: "test-secret" },
      });
    assert.ok(statSync(path).size + statSync(path + ".1").size <= 1200);
    const lines = [path + ".1", path].flatMap((p) =>
      readFileSync(p, "utf8").trim().split("\n"),
    );
    assert.ok(lines.every((l) => !l.includes("test-secret")));
    assert.equal(JSON.parse(lines.at(-1)).issues, 79);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
