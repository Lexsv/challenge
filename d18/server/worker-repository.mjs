import { russianRoadQuizzes } from "./russian-road-quizzes.mjs";
import { randomUUID } from "node:crypto";
import { validateProfileDeletionSchema } from "./profile-deletion-safety.mjs";

const idPattern = /^[a-zA-Z0-9-]{1,100}$/;
const text = (v, max) =>
  typeof v === "string" && v.trim().length > 0 && v.length <= max;
const keys = (v, allowed) =>
  v &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  Object.keys(v).every((k) => allowed.includes(k));
export function validDocument(doc) {
  if (
    !keys(doc, ["schemaVersion", "steps", "allowBack"]) ||
    ![1, 2].includes(doc.schemaVersion) ||
    (doc.allowBack !== undefined && (doc.schemaVersion !== 2 || typeof doc.allowBack !== 'boolean')) ||
    !Array.isArray(doc.steps) ||
    !doc.steps.length ||
    doc.steps.length > 100 ||
    Buffer.byteLength(JSON.stringify(doc)) > 100000
  )
    return false;
  const ids = new Set();
  return doc.steps.every((step) => {
    if (
      !keys(step, ["id", "type", "prompt", "options", ...(doc.schemaVersion === 2 ? ['evaluation'] : [])]) ||
      typeof step.id !== "string" ||
      !idPattern.test(step.id) ||
      ids.has(step.id) ||
      !text(step.prompt, 2000)
    )
      return false;
    ids.add(step.id);
    if (doc.schemaVersion === 2) {
      const e = step.evaluation;
      if (!e || !text(e.criteria, 5000) || (step.type === 'question'
        ? !keys(e, ['kind', 'optionId', 'criteria']) || Object.keys(e).length !== 3 || e.kind !== 'correct_option' || !Array.isArray(step.options) || !step.options.some(option => option?.id === e.optionId)
        : !keys(e, ['kind', 'criteria']) || Object.keys(e).length !== 2 || e.kind !== 'acceptance_criteria')) return false;
    }
    if (step.type === "action") return !Object.hasOwn(step, "options");
    if (
      step.type !== "question" ||
      !Array.isArray(step.options) ||
      step.options.length < 2 ||
      step.options.length > 4
    )
      return false;
    const options = new Set();
    return step.options.every((o) => {
      if (
        !keys(o, ["id", "text"]) ||
        typeof o.id !== "string" ||
        !idPattern.test(o.id) ||
        options.has(o.id) ||
        !text(o.text, 500)
      )
        return false;
      options.add(o.id);
      return true;
    });
  });
}
const validTemplate = (v) =>
  keys(v, ["name", "description", "rules", "document", "expectedVersion"]) &&
  text(v.name, 200) &&
  typeof v.description === "string" &&
  v.description.length <= 5000 &&
  typeof v.rules === "string" &&
  v.rules.length <= 20000 &&
  validDocument(v.document);
const parse = (row) => {
  if (!row) return null;
  const document = JSON.parse(row.document);
  if (
    !validDocument(document) ||
    !Number.isSafeInteger(row.version) ||
    row.version < 1
  )
    throw Error("Invalid stored template");
  return { ...row, document };
};
const parseSession = (row) => {
  if (!row) return null;
  const snapshot = JSON.parse(row.templateSnapshot);
  if (
    !keys(snapshot, [
      "id",
      "name",
      "description",
      "rules",
      "version",
      "document",
      "createdAt",
      "updatedAt",
    ]) ||
    typeof snapshot.id !== "string" ||
    !idPattern.test(snapshot.id) ||
    !validTemplate({
      name: snapshot.name,
      description: snapshot.description,
      rules: snapshot.rules,
      document: snapshot.document,
    }) ||
    (snapshot.createdAt !== undefined &&
      (!Number.isSafeInteger(snapshot.createdAt) || snapshot.createdAt < 0)) ||
    (snapshot.updatedAt !== undefined &&
      (!Number.isSafeInteger(snapshot.updatedAt) || snapshot.updatedAt < 0)) ||
    !Number.isSafeInteger(snapshot.version) ||
    snapshot.version < 1 ||
    snapshot.version !== row.templateVersion ||
    (row.templateId !== null && snapshot.id !== row.templateId) ||
    !text(row.name, 200) ||
    !Number.isSafeInteger(row.stepIndex) ||
    row.stepIndex < 0 ||
    row.stepIndex >= snapshot.document.steps.length ||
    !Number.isSafeInteger(row.attempt) ||
    row.attempt < 1 ||
    !Number.isSafeInteger(row.revision) ||
    row.revision < 1
  )
    throw Error("Invalid stored snapshot");
  return { ...row, templateSnapshot: snapshot };
};
export function createWorkerRepository(db) {
  if (db.prepare("PRAGMA foreign_keys").get().foreign_keys !== 1)
    throw Error("Worker persistence requires foreign keys.");
  db.exec("SAVEPOINT worker_init");
  try {
    const isNew = !db
      .prepare(
        "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='worker_templates'",
      )
      .get();
    db.exec(`CREATE TABLE IF NOT EXISTS worker_templates(id TEXT PRIMARY KEY NOT NULL,name TEXT NOT NULL CHECK(length(trim(name))>0),description TEXT NOT NULL,rules TEXT NOT NULL,document TEXT NOT NULL CHECK(json_valid(document)),version INTEGER NOT NULL CHECK(typeof(version)='integer' AND version>=1),created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS worker_sessions(id TEXT PRIMARY KEY NOT NULL,name TEXT NOT NULL CHECK(length(trim(name))>0),profile_id TEXT NOT NULL REFERENCES context_profiles(id),template_id TEXT REFERENCES worker_templates(id) ON DELETE SET NULL,template_version INTEGER NOT NULL CHECK(typeof(template_version)='integer' AND template_version>=1),template_snapshot TEXT NOT NULL CHECK(json_valid(template_snapshot)),state TEXT NOT NULL,step_index INTEGER NOT NULL CHECK(typeof(step_index)='integer' AND step_index>=0),attempt INTEGER NOT NULL CHECK(typeof(attempt)='integer' AND attempt>=1),revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision>=1),created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS worker_events(session_id TEXT NOT NULL REFERENCES worker_sessions(id) ON DELETE CASCADE,sequence INTEGER NOT NULL CHECK(typeof(sequence)='integer' AND sequence>=1),request_id TEXT NOT NULL,action TEXT NOT NULL,step_index INTEGER CHECK(typeof(step_index)='integer' AND step_index>=0),payload TEXT NOT NULL CHECK(json_valid(payload)),created_at INTEGER NOT NULL,PRIMARY KEY(session_id,sequence),UNIQUE(session_id,request_id));
 CREATE TABLE IF NOT EXISTS worker_command_receipts(session_id TEXT NOT NULL REFERENCES worker_sessions(id) ON DELETE CASCADE,request_id TEXT NOT NULL,fingerprint TEXT NOT NULL CHECK(length(fingerprint)=64),action TEXT NOT NULL,outcome TEXT NOT NULL CHECK(outcome IN ('accepted','rejected')),response TEXT NOT NULL CHECK(json_valid(response)),created_at INTEGER NOT NULL,PRIMARY KEY(session_id,request_id));
 CREATE INDEX IF NOT EXISTS worker_sessions_profile_id ON worker_sessions(profile_id);
 CREATE INDEX IF NOT EXISTS worker_sessions_template_id ON worker_sessions(template_id);
 CREATE TRIGGER IF NOT EXISTS worker_session_immutable BEFORE UPDATE OF profile_id,template_snapshot,template_version ON worker_sessions WHEN NEW.profile_id IS NOT OLD.profile_id OR NEW.template_snapshot IS NOT OLD.template_snapshot OR NEW.template_version IS NOT OLD.template_version BEGIN SELECT RAISE(ABORT,'Worker session identity is immutable.'); END;
 CREATE TRIGGER IF NOT EXISTS worker_session_no_replace BEFORE INSERT ON worker_sessions WHEN EXISTS(SELECT 1 FROM worker_sessions WHERE id=NEW.id) BEGIN SELECT RAISE(ABORT,'Worker session already exists.'); END;`);
    if (isNew) {
      const questions = [
        [
          "Which keyword declares a constant in JavaScript?",
          "const",
          "var",
          "let",
          "static",
        ],
        [
          "Which type represents true or false?",
          "string",
          "boolean",
          "number",
          "array",
        ],
        [
          "Which operator checks strict equality in JavaScript?",
          "=",
          "==",
          "===",
          "!=",
        ],
        [
          "Which structure stores ordered items?",
          "Array",
          "Boolean",
          "Null",
          "Function",
        ],
        [
          "Which HTTP method retrieves a resource?",
          "POST",
          "DELETE",
          "GET",
          "PATCH",
        ],
      ];
      const quiz = {
        schemaVersion: 1,
        steps: questions.map((q, i) => ({
          id: `step-${i + 1}`,
          type: "question",
          prompt: q[0],
          options: q
            .slice(1)
            .map((option, n) => ({ id: `option-${n + 1}`, text: option })),
        })),
      };
      const chocolate = {
        schemaVersion: 1,
        steps: [
          "Select and inspect cocoa beans",
          "Roast the beans",
          "Grind and refine the cocoa",
          "Temper the chocolate",
          "Mould and inspect the finished chocolate",
        ].map((prompt, i) => ({ id: `step-${i + 1}`, type: "action", prompt })),
      };
      const insert = db.prepare(
          "INSERT INTO worker_templates VALUES(?,?,?,?,?,1,?,?)",
        ),
        now = Date.now();
      insert.run(
        "quiz",
        "Programming Quiz",
        "Five short multiple-choice programming questions.",
        "Choose one answer for each question.",
        JSON.stringify(quiz),
        now,
        now,
      );
      insert.run(
        "chocolate",
        "Chocolate Production",
        "Walk through five chocolate production steps.",
        "Review each step before validation.",
        JSON.stringify(chocolate),
        now,
        now,
      );
    }
    // A one-time additive seed leaves existing templates and session snapshots intact.
    db.exec('CREATE TABLE IF NOT EXISTS worker_seed_versions(version TEXT PRIMARY KEY NOT NULL)');
    if (!db.prepare("SELECT 1 FROM worker_seed_versions WHERE version='workflow-v2-demos'").get()) {
      const questions = [
        ['Which keyword declares a constant in JavaScript?', ['const','var','let','static'],0],
        ['Which type represents true or false?', ['string','boolean','number','array'],1],
        ['Which operator checks strict equality in JavaScript?', ['=','==','===','!='],2],
        ['Which structure stores ordered items?', ['Array','Boolean','Null','Function'],0],
        ['Which HTTP method retrieves a resource?', ['POST','DELETE','GET','PATCH'],2],
      ];
      const quiz={schemaVersion:2,steps:questions.map(([prompt,choices,correct],i)=>({id:`step-${i+1}`,type:'question',prompt,options:choices.map((text,n)=>({id:`option-${n+1}`,text})),evaluation:{kind:'correct_option',optionId:`option-${correct+1}`,criteria:`The correct answer is ${choices[correct]}.`}}))};
      const tasks=['Select and inspect cocoa beans','Roast the beans','Grind and refine the cocoa','Temper the chocolate','Mould and inspect the finished chocolate'];
      const chocolate={schemaVersion:2,steps:tasks.map((prompt,i)=>({id:`step-${i+1}`,type:'action',prompt,evaluation:{kind:'acceptance_criteria',criteria:`Completion of ${prompt} passes. A reported problem fails this step and must be explained.`}}))};
      const add=db.prepare('INSERT OR IGNORE INTO worker_templates VALUES(?,?,?,?,?,1,?,?)');const now=Date.now();
      add.run('quiz-v2','Programming Quiz (V2)','Five multiple-choice programming questions.','Evaluate each selected answer against its configured correct option.',JSON.stringify(quiz),now,now);
      add.run('chocolate-v2','Chocolate Production (V2)','Five sequential production steps.','Evaluate each reported task result against its acceptance criteria.',JSON.stringify(chocolate),now,now);
      db.prepare("INSERT INTO worker_seed_versions(version) VALUES('workflow-v2-demos')").run();
    }
    if (!db.prepare("SELECT 1 FROM worker_seed_versions WHERE version=?").get("russian-road-quizzes-v1")) {
      const insert = db.prepare("INSERT INTO worker_templates(id,name,description,rules,document,version,created_at,updated_at) VALUES(?,?,?,?,?,1,?,?) ON CONFLICT(id) DO NOTHING");
      const now = Date.now();
      for (const quiz of russianRoadQuizzes) {
        insert.run(quiz.id, quiz.name, quiz.description, quiz.rules, JSON.stringify(quiz.document), now, now);
      }
      db.prepare("INSERT INTO worker_seed_versions(version) VALUES(?)").run("russian-road-quizzes-v1");
    }
    db.exec("RELEASE worker_init");
  } catch (error) {
    db.exec("ROLLBACK TO worker_init");
    db.exec("RELEASE worker_init");
    throw error;
  }
  const templateSql =
    "SELECT id,name,description,rules,document,version,created_at AS createdAt,updated_at AS updatedAt FROM worker_templates";
  const sessionSql =
    "SELECT id,name,profile_id AS profileId,template_id AS templateId,template_version AS templateVersion,template_snapshot AS templateSnapshot,state,step_index AS stepIndex,attempt,revision,created_at AS createdAt,updated_at AS updatedAt FROM worker_sessions";
  const getTemplate = (id) =>
    parse(db.prepare(`${templateSql} WHERE id=?`).get(id));
  const getSession = (id) =>
    parseSession(db.prepare(`${sessionSql} WHERE id=?`).get(id));
  const transaction = (fn) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  };
  return {
    listTemplates: () =>
      db.prepare(`${templateSql} ORDER BY created_at,id`).all().map(parse),
    getTemplate,
    createTemplate(v) {
      if (!validTemplate(v) || Object.hasOwn(v, "expectedVersion"))
        return { error: "invalid" };
      const id = randomUUID(),
        now = Date.now();
      db.prepare("INSERT INTO worker_templates VALUES(?,?,?,?,?,1,?,?)").run(
        id,
        v.name.trim(),
        v.description,
        v.rules,
        JSON.stringify(v.document),
        now,
        now,
      );
      return { value: getTemplate(id) };
    },
    updateTemplate(id, v) {
      if (
        !validTemplate(v) ||
        !Number.isSafeInteger(v.expectedVersion) ||
        v.expectedVersion < 1
      )
        return { error: "invalid" };
      return transaction(() => {
        const current = getTemplate(id);
        if (!current) return { error: "missing" };
        if (current.version !== v.expectedVersion) return { error: "conflict" };
        db.prepare(
          "UPDATE worker_templates SET name=?,description=?,rules=?,document=?,version=version+1,updated_at=? WHERE id=? AND version=?",
        ).run(
          v.name.trim(),
          v.description,
          v.rules,
          JSON.stringify(v.document),
          Date.now(),
          id,
          v.expectedVersion,
        );
        return { value: getTemplate(id) };
      });
    },
    deleteTemplate(id) {
      return transaction(() => {
        validateProfileDeletionSchema(db);
        return {
          value: !!db.prepare("DELETE FROM worker_templates WHERE id=?").run(id)
            .changes,
        };
      });
    },
    listSessions: () =>
      db
        .prepare(`${sessionSql} ORDER BY created_at,id`)
        .all()
        .map(parseSession),
    getSession,
    renameSession(id, input) {
      if (!keys(input, ["name"]) || !text(input.name, 200)) return { error: "invalid" };
      return transaction(() => {
        const changed = db.prepare("UPDATE worker_sessions SET name=?, updated_at=? WHERE id=?")
          .run(input.name.trim(), Date.now(), id).changes;
        return changed ? { value: getSession(id) } : { error: "missing" };
      });
    },
    deleteSession(id) {
      return transaction(() => {
        validateProfileDeletionSchema(db);
        if (db.prepare("PRAGMA foreign_keys").get().foreign_keys !== 1)
          throw new Error("Worker session deletion requires foreign key enforcement.");
        return { value: !!db.prepare("DELETE FROM worker_sessions WHERE id=?").run(id).changes };
      });
    },
    createSession(v) {
      if (
        !keys(v, ["name", "profileId", "templateId"]) ||
        !text(v.name, 200) ||
        typeof v.profileId !== "string" ||
        !idPattern.test(v.profileId) ||
        typeof v.templateId !== "string" ||
        !idPattern.test(v.templateId)
      )
        return { error: "invalid" };
      return transaction(() => {
        const template = getTemplate(v.templateId);
        if (
          !template ||
          !db
            .prepare("SELECT 1 FROM context_profiles WHERE id=?")
            .get(v.profileId)
        )
          return { error: "missing" };
        const { id: templateId, version } = template;
        const snapshot = { ...template };
        const id = randomUUID(),
          now = Date.now();
        db.prepare(
          "INSERT INTO worker_sessions(id,name,profile_id,template_id,template_version,template_snapshot,state,step_index,attempt,revision,created_at,updated_at) VALUES(?,?,?,?,?,?, 'not_started',0,1,1,?,?)",
        ).run(
          id,
          v.name.trim(),
          v.profileId,
          templateId,
          version,
          JSON.stringify(snapshot),
          now,
          now,
        );
        return { value: getSession(id) };
      });
    },
    events: (id) =>
      db
        .prepare(
          "SELECT sequence,request_id AS requestId,action,step_index AS stepIndex,payload,created_at AS createdAt FROM worker_events WHERE session_id=? ORDER BY sequence",
        )
        .all(id)
        .map((row) => ({ ...row, payload: JSON.parse(row.payload) })),
  };
}
