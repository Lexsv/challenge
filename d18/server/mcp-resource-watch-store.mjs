import { policyDigest } from "./mcp-execution-policy.mjs";
import { resourceFields } from "./mcp-resource-presentation.mjs";
import { McpProblem } from "./mcp-configuration.mjs";
import { createHash, randomUUID } from "node:crypto";
import { safeToolObservation } from "../src/execution-policy.ts";
import { containsCredential, safeResourceUri } from "./journal-payload.mjs";

// Operator-owned grants. A listed resource may be watched globally or by an
// attached chat. Following typed tool results always requires an exact chat/tool.
export function resourceWatchPolicy(input) {
  const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
  if (
    !Array.isArray(input) ||
    input.length > 64 ||
    input.some(
      (g) =>
        !g ||
        Object.keys(g).some(
          (k) =>
            ![
              "connectionId",
              "revision",
              "sessionId",
              "toolId",
              "uri",
            ].includes(k),
        ) ||
        typeof g.connectionId !== "string" ||
        !uuid.test(g.connectionId) ||
        !Number.isSafeInteger(g.revision) ||
        g.revision < 1 ||
        (g.sessionId !== undefined &&
          (typeof g.sessionId !== "string" || !uuid.test(g.sessionId))) ||
        (g.uri !== undefined && !safeResourceUri(g.uri)) ||
        (g.toolId === undefined
          ? !g.uri
          : typeof g.toolId !== "string" ||
            !uuid.test(g.toolId) ||
            !g.sessionId),
    )
  )
    throw Error("Invalid MCP resource watch policy");
  return input.map((g) => ({ ...g }));
}

export function createWatchStore(db, grants, defaultWatching = true) {
  const notificationColumns = `(
    id INTEGER PRIMARY KEY, watch_id TEXT NOT NULL, connection_id TEXT NOT NULL,
    source_name TEXT NOT NULL, session_id TEXT, uri TEXT NOT NULL, sequence INTEGER NOT NULL,
    kind TEXT NOT NULL, received_at INTEGER NOT NULL, content TEXT, read_at INTEGER,
    UNIQUE(watch_id,sequence))`;
  const hasChats = !!db
    .prepare("SELECT 1 FROM sqlite_master WHERE name='session_mcp_connections'")
    .get();
  transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS mcp_resource_watches (
    id TEXT PRIMARY KEY, connection_id TEXT NOT NULL REFERENCES mcp_connections(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL, scope TEXT NOT NULL, uri TEXT NOT NULL, status TEXT NOT NULL,
    digest TEXT, sequence INTEGER NOT NULL DEFAULT 0, checked_at INTEGER,
    UNIQUE(connection_id,revision,scope,uri));
    CREATE TABLE IF NOT EXISTS mcp_watch_origins (
      watch_id TEXT NOT NULL REFERENCES mcp_resource_watches(id) ON DELETE CASCADE,
      tool_id TEXT NOT NULL, call_id TEXT NOT NULL, PRIMARY KEY(watch_id,tool_id,call_id));
    CREATE TABLE IF NOT EXISTS mcp_resource_notifications ${notificationColumns};
    CREATE TABLE IF NOT EXISTS mcp_tool_watch_revocations (
      tool_id TEXT PRIMARY KEY REFERENCES mcp_tools(id) ON DELETE CASCADE, revision INTEGER NOT NULL
    );`);
    const columns = db
      .prepare("PRAGMA table_info(mcp_resource_watches)")
      .all()
      .map((c) => c.name);
    for (const name of [
      "title",
      "description",
      "scheduled_at",
      "remote_status",
    ]) {
      if (!columns.includes(name))
        db.exec(
          "ALTER TABLE mcp_resource_watches ADD COLUMN " + name + " TEXT",
        );
    }
    if (!columns.includes("updated_at"))
      db.exec(`ALTER TABLE mcp_resource_watches ADD COLUMN updated_at INTEGER;
      UPDATE mcp_resource_watches SET updated_at=checked_at`);
    if (!columns.includes("read_denied"))
      db.exec(`ALTER TABLE mcp_resource_watches ADD COLUMN read_denied INTEGER NOT NULL DEFAULT 0;
      UPDATE mcp_resource_watches SET read_denied=1 WHERE status='suspended'`);
    db.exec(`CREATE TABLE IF NOT EXISTS mcp_tool_watch_settings (
      tool_id TEXT PRIMARY KEY REFERENCES mcp_tools(id) ON DELETE CASCADE, revision INTEGER NOT NULL);
      CREATE TRIGGER IF NOT EXISTS mcp_remove_watch_setting AFTER UPDATE OF present ON mcp_tools
      WHEN NEW.present=0 BEGIN DELETE FROM mcp_tool_watch_settings WHERE tool_id=NEW.id; END;
      DROP TRIGGER IF EXISTS mcp_chat_delete_notifications;`);
    if (!db.prepare("PRAGMA table_info(mcp_tool_watch_settings)").all().some(c => c.name === "enabled"))
      db.exec("ALTER TABLE mcp_tool_watch_settings ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1))");
    // Only first discovery creates a preference. Refresh, restart and migration
    // never opt existing tools in or replace a user's decision.
    db.exec("DROP TRIGGER IF EXISTS temp.mcp_new_tool_watch_default");
    if (defaultWatching) db.exec(`CREATE TEMP TRIGGER mcp_new_tool_watch_default AFTER INSERT ON main.mcp_tools
      WHEN NEW.present=1 BEGIN
      INSERT INTO mcp_tool_watch_settings(tool_id, revision, enabled)
        SELECT NEW.id,revision,1 FROM mcp_connections WHERE id=NEW.connection_id;
      END;`);
    db.exec(`CREATE TEMP TRIGGER IF NOT EXISTS mcp_retain_watch_preference_on_rename
      AFTER UPDATE OF revision ON main.mcp_connections
      WHEN NEW.endpoint IS OLD.endpoint AND NEW.transport IS OLD.transport AND NEW.auth IS OLD.auth
        AND NEW.credential_ref IS OLD.credential_ref
      BEGIN UPDATE mcp_tool_watch_settings SET revision=NEW.revision WHERE revision=OLD.revision
        AND tool_id IN (SELECT id FROM mcp_tools WHERE connection_id=NEW.id AND present=1);
      END;`);
    // Audit rows retain the original connection UUID after its live configuration is removed.
    if (
      db
        .prepare("PRAGMA foreign_key_list(mcp_resource_notifications)")
        .all()
        .some((f) => f.table === "mcp_connections")
    ) {
      db.exec(`CREATE TABLE mcp_notifications_migrating ${notificationColumns};
        INSERT INTO mcp_notifications_migrating SELECT id,watch_id,connection_id,source_name,session_id,
          uri,sequence,kind,received_at,content,read_at FROM mcp_resource_notifications;
        DROP TABLE mcp_resource_notifications;
        ALTER TABLE mcp_notifications_migrating RENAME TO mcp_resource_notifications;
        CREATE INDEX mcp_notifications_history ON mcp_resource_notifications(received_at DESC,id DESC);`);
    }
    db.exec(`CREATE INDEX IF NOT EXISTS mcp_watch_origins_by_tool ON mcp_watch_origins(tool_id);
      CREATE TABLE IF NOT EXISTS mcp_notification_retired_origins (
        notification_id INTEGER NOT NULL REFERENCES mcp_resource_notifications(id) ON DELETE CASCADE,
        tool_id TEXT NOT NULL, call_id TEXT NOT NULL, PRIMARY KEY(notification_id,tool_id,call_id));
      CREATE TRIGGER IF NOT EXISTS mcp_last_watch_origin AFTER DELETE ON mcp_watch_origins BEGIN
        INSERT OR IGNORE INTO mcp_notification_retired_origins
          SELECT id,OLD.tool_id,OLD.call_id FROM mcp_resource_notifications
          WHERE watch_id=OLD.watch_id AND OLD.tool_id<>'';
        DELETE FROM mcp_resource_watches WHERE id=OLD.watch_id
          AND NOT EXISTS(SELECT 1 FROM mcp_watch_origins WHERE watch_id=OLD.watch_id);
      END;
      CREATE TRIGGER IF NOT EXISTS mcp_tool_removed_from_catalog AFTER UPDATE OF present ON mcp_tools
      WHEN OLD.present=1 AND NEW.present=0 BEGIN
        INSERT OR REPLACE INTO mcp_tool_watch_revocations SELECT OLD.id,revision FROM mcp_connections WHERE id=OLD.connection_id;
        DELETE FROM mcp_watch_origins WHERE tool_id=OLD.id;
      END;
      CREATE TRIGGER IF NOT EXISTS mcp_tool_deleted AFTER DELETE ON mcp_tools BEGIN
        DELETE FROM mcp_watch_origins WHERE tool_id=OLD.id;
      END;
      CREATE TRIGGER IF NOT EXISTS mcp_connection_pending_cleanup AFTER UPDATE OF deletion_pending ON mcp_connections
      WHEN NEW.deletion_pending=1 BEGIN
        DELETE FROM mcp_resource_watches WHERE connection_id=NEW.id;
      END;
      INSERT OR IGNORE INTO mcp_tool_watch_revocations
        SELECT t.id,c.revision FROM mcp_tools t JOIN mcp_connections c ON c.id=t.connection_id WHERE t.present=0;
      DELETE FROM mcp_watch_origins WHERE tool_id<>'' AND NOT EXISTS
        (SELECT 1 FROM mcp_tools WHERE id=mcp_watch_origins.tool_id AND present=1);
      DELETE FROM mcp_resource_watches WHERE connection_id IN (SELECT id FROM mcp_connections WHERE deletion_pending=1);`);
    // Retain previously observed references from Phase 2 watch origins.
    db.exec(`INSERT OR IGNORE INTO mcp_tool_event_observations(tool_id,link_revision)
    SELECT DISTINCT t.id,c.revision FROM mcp_watch_origins o JOIN mcp_resource_watches w ON w.id=o.watch_id
    JOIN mcp_connections c ON c.id=w.connection_id AND c.revision=w.revision
    JOIN mcp_tools t ON t.id=o.tool_id AND t.connection_id=c.id`);
    if (hasChats)
      db.exec(`CREATE TRIGGER IF NOT EXISTS mcp_detach_resource_watches
    AFTER DELETE ON session_mcp_connections BEGIN
    DELETE FROM mcp_resource_watches WHERE connection_id=OLD.connection_id AND scope=OLD.session_id; END;`);
  });
  db.prepare(
    "UPDATE mcp_resource_watches SET status=? WHERE status NOT IN ('unsubscribed','suspended')",
  ).run("pending");
  const attached =
    hasChats &&
    db.prepare(
      "SELECT 1 FROM session_mcp_connections WHERE connection_id=? AND session_id=?",
    );
  const connection = db.prepare(
    "SELECT revision,deletion_pending,sync_error,resource_error,capabilities,normalized_endpoint FROM mcp_connections c WHERE id=? AND NOT EXISTS (SELECT 1 FROM mcp_connections other WHERE other.endpoint=c.endpoint AND other.id<>c.id)",
  );
  const listed = db.prepare(
    "SELECT 1 FROM mcp_resources WHERE connection_id=? AND uri=?",
  );
  const present = db.prepare(
    "SELECT 1 FROM mcp_tools WHERE connection_id=? AND id=? AND present=1 AND (? OR NOT EXISTS (SELECT 1 FROM mcp_tool_watch_revocations r WHERE r.tool_id=mcp_tools.id AND r.revision>=?))",
  );
  const watches = db.prepare(
    "SELECT * FROM mcp_resource_watches ORDER BY rowid",
  );
  const origins = db.prepare(
    "SELECT DISTINCT tool_id FROM mcp_watch_origins WHERE watch_id=?",
  );
  const find = db.prepare(
    "SELECT id,status FROM mcp_resource_watches WHERE connection_id=? AND revision=? AND scope=? AND uri=?",
  );
  const listedOrigin = db.prepare(
    "SELECT 1 FROM mcp_resource_watches w JOIN mcp_watch_origins o ON o.watch_id=w.id WHERE connection_id=? AND revision=? AND scope=? AND uri=? AND o.tool_id=''",
  );
  const state = db.prepare(
    "UPDATE mcp_resource_watches SET status=?,updated_at=? WHERE id=? AND status<>?",
  );
  const hasInvariants = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_invariants'",
  );
  const setting = db.prepare(
    "SELECT enabled FROM mcp_tool_watch_settings WHERE tool_id=? AND revision=?",
  );
  function enabledForChat(g) {
    return (
      !!g.sessionId && !!setting.get(g.toolId, g.revision)?.enabled && permits(g, true)
    );
  }
  function isProtected(scope) {
    return (
      scope &&
      hasInvariants.get() &&
      db
        .prepare(
          "SELECT 1 FROM session_invariants WHERE session_id=? AND enabled=1",
        )
        .get("week3:" + scope)
    );
  }
  function permits(g, configured = false) {
    const c = connection.get(g.connectionId);
    return (
      c &&
      c.revision === g.revision &&
      !c.deletion_pending &&
      c.normalized_endpoint &&
      !c.resource_error &&
      JSON.parse(c.capabilities)?.subscribe &&
      (!g.sessionId ||
        (attached && attached.get(g.connectionId, g.sessionId))) &&
      (!g.toolId ||
        (!c.sync_error && setting.get(g.toolId, g.revision)?.enabled !== 0 &&
          present.get(g.connectionId, g.toolId, +configured, g.revision)))
    );
  }
  function authorized(w) {
    if (
      origins.all(w.id).some(
        (o) =>
          o.tool_id &&
          enabledForChat({
            connectionId: w.connection_id,
            revision: w.revision,
            sessionId: w.scope,
            toolId: o.tool_id,
          }),
      )
    )
      return true;
    return grants.some(
      (g) =>
        g.connectionId === w.connection_id &&
        g.revision === w.revision &&
        (g.sessionId ?? "") === w.scope &&
        (!g.uri || g.uri === w.uri) &&
        permits(g) &&
        (g.toolId
          ? origins.all(w.id).some((o) => o.tool_id === g.toolId)
          : listed.get(w.connection_id, w.uri)),
    );
  }
  function add(g, uri, callId = "", title = null, description = null) {
    const scope = g.sessionId ?? "";
    let id = find.get(g.connectionId, g.revision, scope, uri)?.id;
    if (!id) {
      if (
        db
          .prepare(
            "SELECT count(*) AS n FROM mcp_resource_watches WHERE status<>'unsubscribed'",
          )
          .get().n >= 512
      ) {
        if (g.toolId) throw Error("Resource watch capacity reached");
        // A new catalog grant at capacity must not evict other active watches.
        return;
      }
      id = randomUUID();
      db.prepare(
        "INSERT INTO mcp_resource_watches(id,connection_id,revision,scope,uri,status,updated_at) VALUES(?,?,?,?,?,'pending',?)",
      ).run(id, g.connectionId, g.revision, scope, uri, Date.now());
    }
    if (
      db.prepare("SELECT status FROM mcp_resource_watches WHERE id=?").get(id)
        ?.status === "unsubscribed"
    )
      return false;
    if ((title || description) && !isProtected(scope))
      db.prepare(
        "UPDATE mcp_resource_watches SET title=coalesce(?,title),description=coalesce(?,description) WHERE id=?",
      ).run(title, description, id);
    db.prepare("INSERT OR IGNORE INTO mcp_watch_origins VALUES(?,?,?)").run(
      id,
      g.toolId ?? "",
      callId,
    );
    return true;
  }
  function transaction(fn) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  return {
    configured(toolId, revision) {
      return !!setting.get(toolId, revision)?.enabled;
    },
    configure(id, toolId, revision, enabled) {
      transaction(() => {
        const c = connection.get(id);
        if (
          !c ||
          c.deletion_pending ||
          c.revision !== revision ||
          !present.get(id, toolId, 1, revision)
        )
          throw new McpProblem("conflict", 409);
        db.prepare(`INSERT INTO mcp_tool_watch_settings(tool_id, revision, enabled) VALUES(?,?,?)
          ON CONFLICT(tool_id) DO UPDATE SET revision=excluded.revision,enabled=excluded.enabled`)
          .run(toolId, revision, +enabled);
      });
    },
    unsubscribe(id) {
      let found = false;
      transaction(() => {
        const w = db
          .prepare("SELECT * FROM mcp_resource_watches WHERE id=?")
          .get(id);
        if (w && authorized(w)) {
          state.run("unsubscribed", Date.now(), id, "unsubscribed");
          found = true;
        }
      });
      return found;
    },
    subscriptionIds() {
      return watches
        .all()
        .filter((w) => w.status !== "unsubscribed" && authorized(w))
        .map((w) => w.id);
    },
    visibleIds() {
      return watches
        .all()
        .filter(
          (w) => !w.read_denied && w.status !== "suspended" && authorized(w),
        )
        .map((w) => w.id);
    },
    watchEnabled(connectionId, toolId) {
      const c = connection.get(connectionId);
      if (
        c &&
        !c.deletion_pending &&
        !c.sync_error &&
        !c.resource_error &&
        JSON.parse(c.capabilities)?.subscribe &&
        db
          .prepare(
            `SELECT 1 FROM mcp_tool_watch_settings s JOIN mcp_tools t ON t.id=s.tool_id
        WHERE connection_id=? AND s.enabled=1 AND present=1 AND revision=? AND (? IS NULL OR t.id=?)`,
          )
          .get(connectionId, c.revision, toolId ?? null, toolId ?? null)
      )
        return true;
      return grants.some(
        (g) =>
          g.connectionId === connectionId &&
          (!toolId || g.toolId === toolId) &&
          permits(g) &&
          (g.toolId || listed.get(connectionId, g.uri)),
      );
    },
    desired() {
      for (const g of grants)
        if (
          !g.toolId &&
          permits(g) &&
          listed.get(g.connectionId, g.uri) &&
          !listedOrigin.get(
            g.connectionId,
            g.revision,
            g.sessionId ?? "",
            g.uri,
          )
        )
          transaction(() => {
            if (permits(g) && listed.get(g.connectionId, g.uri)) add(g, g.uri);
          });
      return watches.all().filter((w) => {
        if (w.status === "unsubscribed") return false;
        if (authorized(w)) return true;
        state.run("suspended", Date.now(), w.id, "suspended");
        return false;
      });
    },
    capture(destination, content, credentials) {
      const matched = grants.filter(
        (g) =>
          g.toolId &&
          g.connectionId === destination.connectionId &&
          g.revision === destination.revision &&
          g.sessionId === destination.sessionId &&
          g.toolId === destination.toolId,
      );
      let consumedLinks = 0;
      if (
        !destination.toolCallId ||
        !destination.sessionId ||
        (!matched.length && !enabledForChat(destination))
      )
        return consumedLinks;
      transaction(() => {
        for (const block of content) {
          if (block.type !== "resource_link") continue;
          const uri = block.uri;
          if (!safeResourceUri(uri, credentials)) continue;
          const grant = matched.find(
            (g) => (!g.uri || g.uri === uri) && permits(g),
          );
          if (grant || enabledForChat(destination)) {
            const safeLabel = (value) =>
              typeof value === "string" &&
              !containsCredential(value, credentials)
                ? String(safeToolObservation(value)).slice(0, 1024)
                : null;
            if (
              add(
                grant ?? destination,
                uri,
                destination.toolCallId,
                safeLabel(block.title ?? block.name),
                safeLabel(block.description),
              )
            )
              consumedLinks++;
          }
        }
      });
      return consumedLinks;
    },
    allowed(w) {
      const current = find.get(w.connection_id, w.revision, w.scope, w.uri);
      return (
        current?.id === w.id &&
        current.status !== "unsubscribed" &&
        authorized(w)
      );
    },
    status(w, status) {
      if (!this.allowed(w)) return;
      if (status === "suspended")
        db.prepare(
          "UPDATE mcp_resource_watches SET status=?,updated_at=?,read_denied=1 WHERE id=?",
        ).run(status, Date.now(), w.id);
      else state.run(status, Date.now(), w.id, status);
    },
    observe(w, contents, credentials, reconciled, status) {
      // Never follow a link, store a blob, or attribute a different resource's
      // contents to this URI. Only bounded sanitized text enters the inbox.
      const parts = contents.filter((part) => part.uri === w.uri);
      if (!parts.length)
        throw Error("Resource read did not return the requested URI");
      const hash = createHash("sha256");
      const canonical = createHash("sha256");
      const texts = [];
      for (const part of parts) {
        const value = part.text ?? part.blob;
        const encoding = [
          part.mimeType ?? "",
          typeof part.text === "string",
          value,
        ];
        const raw = JSON.stringify(encoding);
        hash.update(raw);
        let comparable = raw;
        if (
          typeof part.text === "string" &&
          Buffer.byteLength(part.text) <= 16384
        ) {
          try {
            const data = JSON.parse(part.text);
            if (data && typeof data === "object")
              comparable = policyDigest([encoding[0], "json", data]);
          } catch {
            /* Plain text is compared verbatim. */
          }
        }
        canonical.update(comparable);
        if (
          typeof part.text === "string" &&
          Buffer.byteLength(part.text) <= 16384 &&
          !containsCredential(part.text, credentials)
        )
          texts.push(safeToolObservation(part.text));
      }
      const legacyDigest = hash.digest("hex");
      const digest = "v2:" + canonical.digest("hex"),
        now = Date.now();
      return transaction(() => {
        if (!this.allowed(w)) return;
        const old = db
          .prepare(
            "SELECT digest,sequence,status,updated_at FROM mcp_resource_watches WHERE id=?",
          )
          .get(w.id);
        const fields = resourceFields(texts);
        const terminal = ["Completed", "Cancelled", "Failed"].includes(
          fields.status,
        );
        const changed =
          old.digest !== digest &&
          old.digest !== legacyDigest &&
          (old.digest !== null || terminal);
        const sequence = old.sequence + Number(changed);
        const protectedChat = isProtected(w.scope);
        if (changed) {
          db.prepare(
            `INSERT INTO mcp_resource_notifications(watch_id,connection_id,source_name,session_id,uri,sequence,kind,received_at,content)
          VALUES(?,?,(SELECT name FROM mcp_connections WHERE id=?),?,?,?,?,?,?)`,
          ).run(
            w.id,
            w.connection_id,
            w.connection_id,
            w.scope || null,
            w.uri,
            sequence,
            reconciled ? "reconciled" : "updated",
            now,
            texts.length && !protectedChat
              ? texts.join("\n").slice(0, 16384)
              : null,
          );
        }
        db.prepare(
          "UPDATE mcp_resource_watches SET read_denied=0,digest=?,sequence=?,checked_at=?,updated_at=?,status=?,remote_status=?,scheduled_at=coalesce(?,scheduled_at),title=coalesce(?,title),description=coalesce(?,description) WHERE id=?",
        ).run(
          digest,
          sequence,
          now,
          changed || old.status !== status || !old.updated_at
            ? now
            : old.updated_at,
          terminal ? "unsubscribed" : status,
          fields.status,
          protectedChat ? null : fields.scheduledAt,
          protectedChat ? null : fields.title,
          protectedChat ? null : fields.description,
          w.id,
        );
        return terminal;
      });
    },
  };
}
