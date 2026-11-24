import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createSessionServer } from "./sessions.mjs";

test("Worker HTTP CRUD, conflicts, immutable snapshots and pre-start restoration", async () => {
  const folder = await mkdtemp(join(tmpdir(), "d14-worker-http-"));
  const database = join(folder, "isolated.sqlite");
  let server, base;
  const start = async () => {
    server = createSessionServer(database);
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    base = `http://127.0.0.1:${server.address().port}/api`;
  };
  const stop = async () => {
    if (server?.listening)
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
  };
  const request = async (path, method = "GET", body) => {
    const response = await fetch(`${base}${path}`, {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }),
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    await start();
    const demos = (await request("/worker-templates")).body;
    assert.deepEqual(demos.map((t) => t.name).sort(), [
      "Chocolate Production",
      "Chocolate Production (V2)",
      "Programming Quiz",
      "Programming Quiz (V2)",
      "Правила дорожного движения — 10 вопросов",
      "Правила дорожного движения — 5 вопросов",
    ]);
    const profile = (await request("/users", "POST", { name: "Worker owner" }))
      .body;
    const chat = (
      await request("/week3/sessions", "POST", { profileId: profile.id })
    ).body;
    const draft = {
      name: "Inspection",
      description: "Before start",
      rules: "No automatic execution",
      document: {
        schemaVersion: 1,
        steps: [{ id: "inspect", type: "action", prompt: "Inspect materials" }],
      },
    };
    const created = await request("/worker-templates", "POST", draft);
    assert.equal(created.status, 201);
    const template = created.body;
    const result = await request("/worker-sessions", "POST", {
      name: "Saved before Start",
      profileId: profile.id,
      templateId: template.id,
    });
    assert.equal(result.status, 201);
    const session = result.body;
    assert.deepEqual(
      [session.state, session.stepIndex, session.attempt, session.revision],
      ["not_started", 0, 1, 1],
    );
    assert.equal(
      (await request(`/worker-sessions/${session.id}/events`)).body.length,
      0,
    );
    assert.equal(
      (
        await request(`/worker-sessions/${session.id}`, "PATCH", {
          state: "in_progress",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await request(`/worker-sessions/${session.id}/events`, "POST", {
          action: "start",
        })
      ).status,
      405,
    );
    const edit = await request(`/worker-templates/${template.id}`, "PATCH", {
      ...draft,
      description: "Edited",
      expectedVersion: 1,
    });
    assert.equal(edit.body.version, 2);
    assert.equal(
      (
        await request(`/worker-templates/${template.id}`, "PATCH", {
          ...draft,
          expectedVersion: 1,
        })
      ).status,
      409,
    );
    assert.equal(
      (await request(`/worker-sessions/${session.id}`)).body.templateSnapshot
        .description,
      "Before start",
    );
    assert.equal((await request("/worker-sessions")).body.length, 1);
    assert.equal(
      (
        await request("/worker-sessions", "POST", {
          name: "Bad",
          profileId: "missing",
          templateId: template.id,
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await request("/worker-templates", "POST", {
          ...draft,
          document: { schemaVersion: 99, steps: [] },
        })
      ).status,
      400,
    );
    assert.equal((await request("/worker-templates/missing")).status, 404);
    await stop();
    await start();
    assert.deepEqual(
      (await request(`/worker-sessions/${session.id}`)).body,
      session,
    );
    assert.equal(
      (await request(`/worker-templates/${template.id}`)).body.version,
      2,
    );
    assert.equal((await request(`/week3/sessions/${chat.id}`)).status, 200);
    assert.equal(
      (await request(`/worker-templates/${template.id}`, "DELETE")).status,
      200,
    );
    const detached = (await request(`/worker-sessions/${session.id}`)).body;
    assert.equal(detached.templateId, null);
    assert.deepEqual(detached.templateSnapshot, session.templateSnapshot);
    // Storage errors are sanitized at the real HTTP boundary.
    const db = new DatabaseSync(database);
    try {
      db.exec(
        "CREATE TRIGGER injected_worker_failure BEFORE INSERT ON worker_templates BEGIN SELECT RAISE(ABORT,'private sqlite diagnostic'); END",
      );
      const failure = await request("/worker-templates", "POST", draft);
      assert.equal(failure.status, 500);
      assert.equal(
        JSON.stringify(failure.body).includes("private sqlite diagnostic"),
        false,
      );
      db.exec("DROP TRIGGER injected_worker_failure");
    } finally {
      db.close();
    }
    const removed = await request(`/users/${profile.id}`, "DELETE");
    assert.equal(removed.status, 200);
    assert.equal((await request(`/worker-sessions/${session.id}`)).status, 404);
    assert.equal((await request(`/week3/sessions/${chat.id}`)).status, 404);
    assert.equal((await request("/worker-templates")).body.length, demos.length);
    // Removing a demo is intentional and is not undone by initialization.
    assert.equal(
      (await request("/worker-templates/quiz", "DELETE")).status,
      200,
    );
    await stop();
    await start();
    assert.equal((await request("/worker-templates/quiz")).status, 404);
  } finally {
    await stop();
    await rm(folder, { recursive: true, force: true });
  }
});
