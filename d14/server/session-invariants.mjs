import { randomUUID, createHash } from "node:crypto";
import {
  classifyRule,
  contextualRules,
  redactLiterals,
  redactValue,
  REDACTION,
} from "./invariant-validator.mjs";

export function createInvariantStore(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS invariant_scopes (
    id TEXT PRIMARY KEY, chat_id TEXT UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
    week3_id TEXT UNIQUE REFERENCES week3_sessions(id) ON DELETE CASCADE,
    CHECK ((chat_id IS NULL) != (week3_id IS NULL)));
    CREATE TABLE IF NOT EXISTS session_invariants (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES invariant_scopes(id) ON DELETE CASCADE,
    rule_text TEXT NOT NULL CHECK(length(trim(rule_text)) BETWEEN 1 AND 1000),
    rule_type TEXT NOT NULL CHECK(rule_type IN ('literal','recommendation','semantic')), enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS invariants_by_session ON session_invariants(session_id);
    CREATE TABLE IF NOT EXISTS invariant_audit_log (
    id INTEGER PRIMARY KEY, session_id TEXT NOT NULL REFERENCES invariant_scopes(id) ON DELETE CASCADE,
    invariant_id TEXT NOT NULL, action TEXT NOT NULL CHECK(action IN ('add','edit','remove','enable','disable')), previous_value TEXT, new_value TEXT, timestamp INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS invariant_audit_by_session ON invariant_audit_log(session_id,id);
    CREATE TABLE IF NOT EXISTS invariant_security_events (
    id INTEGER PRIMARY KEY, session_id TEXT NOT NULL REFERENCES invariant_scopes(id) ON DELETE CASCADE,
    chat_id TEXT NOT NULL, turn_id TEXT NOT NULL, invariant_id TEXT NOT NULL, action TEXT NOT NULL CHECK(action IN ('blocked','redacted','withheld')),
    fingerprint TEXT NOT NULL, timestamp INTEGER NOT NULL, UNIQUE(session_id,turn_id));
    CREATE TABLE IF NOT EXISTS invariant_history_policies (
    session_id TEXT NOT NULL REFERENCES invariant_scopes(id) ON DELETE CASCADE,
    chat_id TEXT NOT NULL, through_sequence INTEGER NOT NULL CHECK(through_sequence > 0),
    rules TEXT NOT NULL CHECK(json_valid(rules)), PRIMARY KEY(session_id,chat_id,through_sequence));
    CREATE TABLE IF NOT EXISTS invariant_content_checks (
    session_id TEXT NOT NULL REFERENCES invariant_scopes(id) ON DELETE CASCADE, content_id TEXT NOT NULL,
    digest TEXT NOT NULL, PRIMARY KEY(session_id,content_id));`);
  function scope(week3, id) {
    const table = week3 ? "week3_sessions" : "sessions";
    if (!db.prepare("SELECT id FROM " + table + " WHERE id=?").get(id))
      return null;
    const parent = week3
      ? null
      : db
          .prepare(
            "SELECT parentId FROM sliding_sessions WHERE childId=? UNION ALL SELECT parentId FROM sticky_sessions WHERE childId=? UNION ALL SELECT parentId FROM memory_sessions WHERE childId=?",
          )
          .get(id, id, id);
    const root = parent?.parentId ?? id;
    return { key: (week3 ? "week3:" : "chat:") + root, root, id, week3 };
  }
  function list(s) {
    return db
      .prepare(
        "SELECT id,rule_text AS text,rule_type AS type,enabled FROM session_invariants WHERE session_id=? ORDER BY rowid",
      )
      .all(s.key)
      .map((r) => ({ ...r, enabled: !!r.enabled }));
  }
  const active = (s) => list(s).filter((r) => r.enabled);
  // Save only the sequence boundary and previous policy. Events remain append-only.
  function sealHistory(s) {
    const streams = s.week3 ? [{ id: s.root }] : db.prepare(
      "SELECT ? AS id UNION ALL SELECT childId FROM sliding_sessions WHERE parentId=? " +
      "UNION ALL SELECT childId FROM sticky_sessions WHERE parentId=? " +
      "UNION ALL SELECT childId FROM memory_sessions WHERE parentId=?"
    ).all(s.root, s.root, s.root, s.root);
    const table = s.week3 ? "week3_history_events" : "history_events";
    const save = db.prepare(`INSERT INTO invariant_history_policies
      SELECT ?, ?, MAX(sequence), ? FROM ${table} WHERE sessionId=?
      HAVING MAX(sequence)>0 ON CONFLICT(session_id,chat_id,through_sequence) DO NOTHING`);
    const rules = JSON.stringify(active(s));
    for (const { id } of streams) save.run(s.key, id, rules, id);
  }

  // A cloned stream contains the source's already-sanitized display payloads.
  // Seal that prefix before the destination's active rules can reinterpret it.
  function sealCopiedHistory(s) {
    db.prepare(`INSERT INTO invariant_history_policies
      SELECT ?, ?, MAX(sequence), '[]' FROM history_events
      WHERE sessionId=? AND EXISTS (SELECT 1 FROM invariant_scopes WHERE id=?)
      HAVING MAX(sequence)>0 ON CONFLICT DO NOTHING`).run(s.key, s.id, s.id, s.key);
  }
  function historyView(s) {
    const current = active(s);
    const ranges = db.prepare(`SELECT through_sequence, rules FROM invariant_history_policies
      WHERE session_id=? AND chat_id=? ORDER BY through_sequence`).all(s.key, s.id)
      .map(row => ({ end: row.through_sequence, rules: JSON.parse(row.rules) }));
    return event => {
      const range = ranges.find(row => event.sequence <= row.end);
      return sanitizeEvent(s, range?.rules ?? current, event);
    };
  }
  function change(s, id, update) {
    const previous = list(s).find((r) => r.id === id);
    if (id && !previous) return false;
    if (previous && update?.enabled === previous.enabled && update.text === undefined)
      return true;
    const now = Date.now();
    db.prepare(
      "INSERT OR IGNORE INTO invariant_scopes(id,chat_id,week3_id) VALUES(?,?,?)",
    ).run(s.key, s.week3 ? null : s.root, s.week3 ? s.root : null);
    sealHistory(s);
    const next = update && {
      id: id ?? randomUUID(),
      text: update.text ?? previous.text,
      enabled: update.enabled ?? previous?.enabled ?? true,
    };
    if (next) {
      const kind = classifyRule(next.text).type;
      next.type =
        kind === "forbidden_literal"
          ? "literal"
          : kind === "recommendation"
            ? kind
            : "semantic";
    }
    if (!next)
      db.prepare(
        "DELETE FROM session_invariants WHERE session_id=? AND id=?",
      ).run(s.key, id);
    else if (id)
      db.prepare(
        "UPDATE session_invariants SET rule_text=?,rule_type=?,enabled=?,updated_at=? WHERE session_id=? AND id=?",
      ).run(next.text, next.type, +next.enabled, now, s.key, id);
    else
      db.prepare("INSERT INTO session_invariants VALUES(?,?,?,?,?,?,?)").run(
        next.id,
        s.key,
        next.text,
        next.type,
        +next.enabled,
        now,
        now,
      );
    const action = !previous
      ? "add"
      : !next
        ? "remove"
        : previous.enabled !== next.enabled
          ? next.enabled
            ? "enable"
            : "disable"
          : "edit";
    db.prepare(
      "INSERT INTO invariant_audit_log(session_id,invariant_id,action,previous_value,new_value,timestamp) VALUES(?,?,?,?,?,?)",
    ).run(
      s.key,
      id ?? next.id,
      action,
      previous ? JSON.stringify(previous) : null,
      next ? JSON.stringify(next) : null,
      now,
    );
    return true;
  }
  const digest = (rules, event) =>
    createHash("sha256")
      .update(
        JSON.stringify(["enforcement-v3", rules, event.type, event.payload]),
      )
      .digest("hex");
  function attest(s, rules, event) {
    db.prepare(
      "INSERT INTO invariant_content_checks VALUES(?,?,?) ON CONFLICT(session_id,content_id) DO UPDATE SET digest=excluded.digest",
    ).run(s.key, event.id, digest(rules, event));
  }
  function approved(s, rules, event) {
    const checked = db
      .prepare(
        "SELECT digest FROM invariant_content_checks WHERE session_id=? AND content_id=?",
      )
      .get(s.key, event.id);
    return checked?.digest === digest(rules, event);
  }
  function sanitizeEvent(s, rules, event) {
    if (!rules.length) return event;
    const p = { ...event.payload };
    if (event.type === "message" && p.role === "user") return event;
    // Old approvals can predate support for some localized spellings. Always
    // apply literal masking; only unreviewed semantic evidence needs withholding.
    const semantic = (rules.some(rule => rule.type === "semantic") || contextualRules(rules).length > 0)
      && !approved(s, rules, event);
    for (const key of [
      "text",
      "summary",
      "output",
      "arguments",
      "error",
      "actualModel",
      "model",
      "toolId",
      "toolCallId",
    ]) {
      if (p[key] == null) continue;
      if (semantic && !["model", "toolId", "toolCallId"].includes(key))
        p[key] = REDACTION;
      else if (typeof p[key] === "string")
        p[key] = redactLiterals(p[key], rules);
      else p[key] = redactValue(p[key], rules);
    }
    return { ...event, payload: p };
  }
  function securityEvent(s, turnId) {
    return db
      .prepare(
        "SELECT * FROM invariant_security_events WHERE session_id=? AND turn_id=?",
      )
      .get(s.key, turnId);
  }
  function record(s, input, rule, action) {
    db.prepare(
      "INSERT INTO invariant_security_events(session_id,chat_id,turn_id,invariant_id,action,fingerprint,timestamp) VALUES(?,?,?,?,?,?,?)",
    ).run(
      s.key,
      s.id,
      input.turnId,
      rule.id,
      action,
      input.fingerprint,
      Date.now(),
    );
  }
  function status(s) {
    const revision = db
      .prepare(
        "SELECT COALESCE(MAX(id),0) AS revision FROM invariant_audit_log WHERE session_id=?",
      )
      .get(s.key).revision;
    const counts = { blocked: 0, redacted: 0, withheld: 0 };
    for (const row of db
      .prepare(
        "SELECT action,COUNT(*) AS n FROM invariant_security_events WHERE session_id=? GROUP BY action",
      )
      .all(s.key))
      counts[row.action] = row.n;
    const events = db
      .prepare(
        `SELECT chat_id AS sessionId,turn_id AS turnId,invariant_id AS invariantId,action,timestamp,
          EXISTS (SELECT 1 FROM ${s.week3 ? "week3_history_events" : "history_events"}
            WHERE id='blocked:' || chat_id || ':' || turn_id) AS recordedQuestion
         FROM invariant_security_events WHERE session_id=? ORDER BY id DESC LIMIT 100`,
      )
      .all(s.key)
      .map(({ recordedQuestion, ...e }) => ({
        ...e,
        ...(recordedQuestion ? { recordedQuestion: true } : {}),
        type: "SECURITY",
        stage: e.action === "blocked" ? "input" : "output",
      }));
    return { revision, counts, events };
  }
  return {
    scope,
    list,
    active,
    change,
    attest,
    approved,
    historyView,
    sealCopiedHistory,
    securityEvent,
    record,
    status,
  };
}
