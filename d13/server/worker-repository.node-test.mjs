import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createContextProfileRepository } from "./context-profile-repository.mjs";
import { createWeek3Routes } from "./week3-sessions.mjs";
import { createWorkerRepository, validDocument } from "./worker-repository.mjs";

test("worker snapshots, versions and profile cleanup", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  const profiles = createContextProfileRepository(db);
  createWeek3Routes(db, () => true);
  const workers = createWorkerRepository(db);
  const alice = profiles.create("Alice", ""),
    bob = profiles.create("Bob", "");
  const doc = {
    schemaVersion: 1,
    steps: [{ id: "s1", type: "action", prompt: "Do this" }],
  };
  assert.equal(validDocument({ ...doc, schemaVersion: 2 }), false);
  const created = workers.createTemplate({
    name: "T",
    description: "before",
    rules: "",
    document: doc,
  }).value;
  const a = workers.createSession({
    name: "A",
    profileId: alice.id,
    templateId: created.id,
  }).value;
  const b = workers.createSession({
    name: "B",
    profileId: bob.id,
    templateId: created.id,
  }).value;
  assert.deepEqual(a.templateSnapshot, created);
  assert.equal(a.state, "not_started");
  assert.equal(a.stepIndex, 0);
  assert.equal(a.attempt, 1);
  assert.equal(a.revision, 1);
  assert.equal(
    workers.updateTemplate(created.id, {
      name: "T",
      description: "after",
      rules: "",
      document: doc,
      expectedVersion: 1,
    }).value.version,
    2,
  );
  assert.equal(
    workers.updateTemplate(created.id, {
      name: "T",
      description: "after",
      rules: "",
      document: doc,
      expectedVersion: 1,
    }).error,
    "conflict",
  );
  assert.equal(workers.getSession(a.id).templateSnapshot.description, "before");
  assert.throws(() =>
    db
      .prepare("UPDATE worker_sessions SET profile_id=? WHERE id=?")
      .run(bob.id, a.id),
  );
  assert.throws(() =>
    db
      .prepare("UPDATE worker_sessions SET template_snapshot='{}' WHERE id=?")
      .run(a.id),
  );
  db.prepare("INSERT INTO worker_events VALUES(?,1,'r1','test',0,'{}',1)").run(
    a.id,
  );
  profiles.deleteWithSessions(alice.id);
  assert.equal(workers.getSession(a.id), null);
  assert.equal(workers.getSession(b.id).profileId, bob.id);
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM worker_events").get().n,
    0,
  );
  assert.equal(workers.deleteTemplate(created.id).value, true);
  assert.equal(workers.getSession(b.id).templateId, null);
  assert.equal(workers.getSession(b.id).templateSnapshot.description, "before");
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  db.close();
});

test("worker data survives reopening and General clearing preserves templates", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "worker-stage2-"));
  const path = join(dir, "test.sqlite");
  try {
    let db = new DatabaseSync(path);
    db.exec("PRAGMA foreign_keys=ON");
    let profiles = createContextProfileRepository(db);
    createWeek3Routes(db, () => true);
    let workers = createWorkerRepository(db);
    const general = workers.createSession({
      name: "General test",
      profileId: "general",
      templateId: "quiz",
    }).value;
    const other = profiles.create("Other", "");
    const owned = workers.createSession({
      name: "Other test",
      profileId: other.id,
      templateId: "quiz",
    }).value;
    db.close();
    db = new DatabaseSync(path);
    db.exec("PRAGMA foreign_keys=ON");
    profiles = createContextProfileRepository(db);
    createWeek3Routes(db, () => true);
    workers = createWorkerRepository(db);
    assert.equal(workers.getSession(general.id).state, "not_started");
    assert.equal(workers.getSession(owned.id).profileId, other.id);
    profiles.clearGeneralSessions();
    assert.equal(workers.getSession(general.id), null);
    assert.ok(workers.getSession(owned.id));
    assert.ok(workers.getTemplate("quiz"));
    assert.throws(() => profiles.deleteWithSessions("general"));
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unknown dependency and failed deletion leave Worker data intact", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  const profiles = createContextProfileRepository(db);
  createWeek3Routes(db, () => true);
  const workers = createWorkerRepository(db);
  const user = profiles.create("A", "");
  const session = workers.createSession({
    name: "A",
    profileId: user.id,
    templateId: "quiz",
  }).value;
  db.exec(
    "CREATE TABLE unexpected(id TEXT PRIMARY KEY, worker_id TEXT REFERENCES worker_sessions(id) ON DELETE CASCADE)",
  );
  db.prepare("INSERT INTO unexpected VALUES(?,?)").run("x", session.id);
  assert.throws(() => profiles.deleteWithSessions(user.id));
  assert.ok(workers.getSession(session.id));
  assert.ok(profiles.get(user.id));
  assert.equal(db.prepare("SELECT count(*) AS n FROM unexpected").get().n, 1);
  db.close();
});

test("Worker HTTP contracts reject invalid data and preserve snapshots", async () => {
  const { createWorkerRoutes } = await import("./worker-routes.mjs");
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  createContextProfileRepository(db);
  createWeek3Routes(db, () => true);
  const routes = createWorkerRoutes(createWorkerRepository(db));
  const call = async (method, path, body) => {
    let status, data;
    const req = {
      method,
      async *[Symbol.asyncIterator]() {
        if (body !== undefined) yield JSON.stringify(body);
      },
    };
    assert.equal(
      await routes(req, path, (s, d) => {
        status = s;
        data = d;
      }),
      true,
    );
    return { status, data };
  };
  const doc = {
    schemaVersion: 1,
    steps: [
      {
        id: "s1",
        type: "question",
        prompt: "Question?",
        options: [
          { id: "a", text: "A" },
          { id: "b", text: "B" },
        ],
      },
    ],
  };
  assert.equal(
    (
      await call("POST", "/api/worker-templates", {
        name: "Bad",
        description: "",
        rules: "",
        document: { ...doc, schemaVersion: 9 },
      })
    ).status,
    400,
  );
  const created = await call("POST", "/api/worker-templates", {
    name: "Quiz",
    description: "Before",
    rules: "",
    document: doc,
  });
  assert.equal(created.status, 201);
  const id = created.data.id;
  const session = await call("POST", "/api/worker-sessions", {
    name: "Test",
    profileId: "general",
    templateId: id,
  });
  assert.equal(session.status, 201);
  assert.equal(session.data.state, "not_started");
  assert.equal(
    (
      await call("PATCH", `/api/worker-templates/${id}`, {
        name: "Quiz",
        description: "After",
        rules: "",
        document: doc,
        expectedVersion: 99,
      })
    ).status,
    409,
  );
  assert.equal(
    (await call("GET", `/api/worker-sessions/${session.data.id}/events`)).data
      .length,
    0,
  );
  assert.equal(
    (await call("DELETE", `/api/worker-templates/${id}`)).status,
    200,
  );
  assert.equal(
    (await call("GET", `/api/worker-sessions/${session.data.id}`)).data
      .templateSnapshot.description,
    "Before",
  );
  db.close();
});

test("profile deletion rolls back Worker deletion on a later failure", () => {
  const real = new DatabaseSync(":memory:");
  real.exec("PRAGMA foreign_keys=ON");
  let fail = false;
  const db = new Proxy(real, {
    get(target, key) {
      if (key === "prepare")
        return (sql) => {
          if (fail && sql.startsWith("DELETE FROM week3_history_events"))
            throw Error("injected");
          return target.prepare(sql);
        };
      const value = target[key];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const profiles = createContextProfileRepository(db);
  createWeek3Routes(db, () => true);
  const workers = createWorkerRepository(db);
  const user = profiles.create("Rollback", "");
  const session = workers.createSession({
    name: "A",
    profileId: user.id,
    templateId: "quiz",
  }).value;
  real
    .prepare("INSERT INTO worker_events VALUES(?,1,'r1','test',0,'{}',1)")
    .run(session.id);
  fail = true;
  assert.throws(() => profiles.deleteWithSessions(user.id));
  fail = false;
  assert.ok(profiles.get(user.id));
  assert.ok(workers.getSession(session.id));
  assert.equal(workers.events(session.id).length, 1);
  assert.deepEqual(real.prepare("PRAGMA foreign_key_check").all(), []);
  real.close();
});

test("document and input validation reject invalid structure, duplicates and limits", () => {
  const action = { id: "s1", type: "action", prompt: "Inspect the batch" };
  const question = {
    id: "q1",
    type: "question",
    prompt: "Choose",
    options: [
      { id: "a", text: "One" },
      { id: "b", text: "Two" },
    ],
  };
  const document = (steps) => ({ schemaVersion: 1, steps });
  assert.equal(validDocument(document([action, question])), true);
  for (const invalid of [
    null,
    {},
    document([]),
    { schemaVersion: 2, steps: [action] },
    document([action, action]),
    document([{ ...action, prompt: " " }]),
    document([{ ...action, type: "unknown" }]),
    document([{ ...action, options: [] }]),
    document([{ ...question, options: question.options.slice(0, 1) }]),
    document([
      {
        ...question,
        options: [
          ...question.options,
          ...question.options,
          ...question.options,
        ],
      },
    ]),
    document([
      { ...question, options: [question.options[0], question.options[0]] },
    ]),
    document([
      { ...question, options: [question.options[0], { id: "b", text: "" }] },
    ]),
    document([{ ...action, prompt: "x".repeat(2001) }]),
    document(
      Array.from({ length: 101 }, (_, i) => ({ ...action, id: `s${i}` })),
    ),
    document(
      Array.from({ length: 100 }, (_, i) => ({
        ...action,
        id: `s${i}`,
        prompt: "x".repeat(1500),
      })),
    ),
  ])
    assert.equal(
      validDocument(invalid),
      false,
      JSON.stringify(invalid)?.slice(0, 150),
    );
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  createContextProfileRepository(db);
  createWeek3Routes(db, () => true);
  const workers = createWorkerRepository(db);
  try {
    for (const value of [
      { name: " ", description: "", rules: "", document: document([action]) },
      {
        name: "A",
        description: "",
        rules: "",
        document: document([action]),
        expectedVersion: 1,
      },
    ])
      assert.equal(workers.createTemplate(value).error, "invalid");
    for (const value of [
      { name: " ", profileId: "general", templateId: "quiz" },
      {
        name: "A",
        profileId: "general",
        templateId: "quiz",
        state: "in_progress",
      },
      { name: "A", profileId: "", templateId: "quiz" },
    ])
      assert.equal(workers.createSession(value).error, "invalid");
    assert.equal(
      workers.createSession({
        name: "A",
        profileId: "missing",
        templateId: "quiz",
      }).error,
      "missing",
    );
    assert.equal(
      workers.createSession({
        name: "A",
        profileId: "general",
        templateId: "missing",
      }).error,
      "missing",
    );
    assert.equal(workers.listSessions().length, 0);
  } finally {
    db.close();
  }
});

test("immutable identities, event constraints and stored snapshot validation", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  createContextProfileRepository(db);
  createWeek3Routes(db, () => true);
  const workers = createWorkerRepository(db);
  try {
    const session = workers.createSession({
      name: "A",
      profileId: "general",
      templateId: "quiz",
    }).value;
    assert.throws(() =>
      db
        .prepare("UPDATE worker_sessions SET template_version=2 WHERE id=?")
        .run(session.id),
    );
    assert.throws(() =>
      db
        .prepare(
          "INSERT OR REPLACE INTO worker_sessions SELECT * FROM worker_sessions WHERE id=?",
        )
        .run(session.id),
    );
    const insert = db.prepare(
      "INSERT INTO worker_events VALUES(?,?,?,?,?,?,?)",
    );
    insert.run(session.id, 1, "r1", "fixture", 0, "{}", 1);
    assert.throws(() => insert.run(session.id, 1, "r2", "fixture", 0, "{}", 1));
    assert.throws(() => insert.run(session.id, 2, "r1", "fixture", 0, "{}", 1));
    assert.throws(() => insert.run("missing", 1, "r3", "fixture", 0, "{}", 1));
    // A corrupted disk snapshot is rejected before being returned to the UI.
    db.exec("DROP TRIGGER worker_session_immutable");
    db.prepare(
      "UPDATE worker_sessions SET template_snapshot='{}' WHERE id=?",
    ).run(session.id);
    assert.throws(
      () => workers.getSession(session.id),
      /Invalid stored snapshot/,
    );
  } finally {
    db.close();
  }
});

test("Worker and Chat cleanup is atomic, scoped, and preserves shared templates", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  const profiles = createContextProfileRepository(db);
  createWeek3Routes(db, () => true);
  const workers = createWorkerRepository(db);
  try {
    const originalTemplateIds = workers.listTemplates().map(template => template.id).sort();
    const alice = profiles.create("Alice"),
      bob = profiles.create("Bob");
    const owners = [alice.id, bob.id, "general"];
    const sessions = owners.map((profileId, i) => {
      const chat = `chat-${i}`;
      db.prepare(
        "INSERT INTO week3_sessions(id,title,createdAt,profile_id) VALUES(?,?,?,?)",
      ).run(chat, "Chat", 1, profileId);
      db.prepare("INSERT INTO week3_history_events VALUES(?,?,1,?,?)").run(
        `event-${i}`,
        chat,
        "message",
        "{}",
      );
      db.prepare("INSERT INTO week3_session_memory VALUES(?,1,?)").run(
        chat,
        "{}",
      );
      const worker = workers.createSession({
        name: `Worker ${i}`,
        profileId,
        templateId: "quiz",
      }).value;
      db.prepare(
        "INSERT INTO worker_events VALUES(?,1,'r1','fixture',0,'{}',1)",
      ).run(worker.id);
      return { chat, worker };
    });
    // Two sessions for one owner are independent records.
    const second = workers.createSession({
      name: "Second",
      profileId: bob.id,
      templateId: "chocolate",
    }).value;
    profiles.deleteWithSessions(alice.id);
    profiles.clearGeneralSessions();
    for (const i of [0, 2]) {
      assert.equal(workers.getSession(sessions[i].worker.id), null);
      assert.equal(workers.events(sessions[i].worker.id).length, 0);
      assert.equal(
        db
          .prepare("SELECT id FROM week3_sessions WHERE id=?")
          .get(sessions[i].chat),
        undefined,
      );
      assert.equal(
        db
          .prepare("SELECT id FROM week3_history_events WHERE sessionId=?")
          .get(sessions[i].chat),
        undefined,
      );
      assert.equal(
        db
          .prepare(
            "SELECT sessionId FROM week3_session_memory WHERE sessionId=?",
          )
          .get(sessions[i].chat),
        undefined,
      );
    }
    assert.ok(workers.getSession(sessions[1].worker.id));
    assert.ok(workers.getSession(second.id));
    assert.equal(workers.events(sessions[1].worker.id).length, 1);
    assert.ok(
      db
        .prepare("SELECT id FROM week3_history_events WHERE sessionId=?")
        .get(sessions[1].chat),
    );
    assert.ok(profiles.get("general"));
    assert.deepEqual(workers.listTemplates().map(template => template.id).sort(), originalTemplateIds);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    db.close();
  }
});
