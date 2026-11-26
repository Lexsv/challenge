import { randomUUID } from "node:crypto";
import { policyDigest } from "./mcp-execution-policy.mjs";
import { endpointUrl, McpProblem } from "./mcp-configuration.mjs";

function migrateEndpoints(db) {
  db.exec("BEGIN IMMEDIATE");
  try {
    if (
      !db
        .prepare("PRAGMA table_info(mcp_connections)")
        .all()
        .some((c) => c.name === "normalized_endpoint")
    ) {
      db.exec(
        "ALTER TABLE mcp_connections ADD COLUMN normalized_endpoint TEXT; ALTER TABLE mcp_connections ADD COLUMN deletion_pending INTEGER NOT NULL DEFAULT 0",
      );
      const seen = new Set();
      const update = db.prepare(
        "UPDATE mcp_connections SET endpoint=?,normalized_endpoint=? WHERE id=?",
      );
      for (const row of db
        .prepare("SELECT id,endpoint FROM mcp_connections ORDER BY rowid")
        .all()) {
        const endpoint = endpointUrl(row.endpoint);
        // Only surplus historical rows are exempt. Keep their UUID, tools and secret reference.
        update.run(endpoint, seen.has(endpoint) ? null : endpoint, row.id);
        seen.add(endpoint);
      }
      db.exec(`CREATE UNIQUE INDEX mcp_unique_endpoint ON mcp_connections(normalized_endpoint);
        CREATE TRIGGER mcp_endpoint_insert BEFORE INSERT ON mcp_connections
        WHEN NEW.normalized_endpoint IS NOT NEW.endpoint OR EXISTS(SELECT 1 FROM mcp_connections WHERE endpoint=NEW.endpoint)
        BEGIN SELECT RAISE(ABORT,'Duplicate or invalid MCP endpoint'); END;
        CREATE TRIGGER mcp_endpoint_update BEFORE UPDATE OF endpoint,normalized_endpoint ON mcp_connections
        WHEN NEW.normalized_endpoint IS NOT NEW.endpoint OR EXISTS(SELECT 1 FROM mcp_connections WHERE endpoint=NEW.endpoint AND id<>OLD.id)
        BEGIN SELECT RAISE(ABORT,'Duplicate or invalid MCP endpoint'); END;`);
    }
    if (!db.prepare("PRAGMA table_info(mcp_connections)").all().some(c => c.name === "auto_scope")) {
      db.exec("ALTER TABLE mcp_connections ADD COLUMN auto_scope TEXT CHECK(auto_scope IS NULL OR json_type(auto_scope)='object')");
    }
    if (!db.prepare("PRAGMA table_info(mcp_connections)").all().some(c => c.name === "capabilities"))
      db.exec("ALTER TABLE mcp_connections ADD COLUMN capabilities TEXT; ALTER TABLE mcp_connections ADD COLUMN resource_error TEXT");
    if (!db.prepare("PRAGMA table_info(mcp_connections)").all().some(c => c.name === "sse_observed"))
      db.exec("ALTER TABLE mcp_connections ADD COLUMN sse_observed INTEGER");
    db.exec(`CREATE TABLE IF NOT EXISTS mcp_tool_event_observations (
      tool_id TEXT PRIMARY KEY REFERENCES mcp_tools(id) ON DELETE CASCADE, link_revision INTEGER NOT NULL)`);
    // Older observations include embedded resources. Only fresh typed links
    // qualify for the resource-link indicator.
    if (!db.prepare("PRAGMA table_info(mcp_tool_event_observations)").all().some(c => c.name === "typed_link_revision"))
      db.exec("ALTER TABLE mcp_tool_event_observations ADD COLUMN typed_link_revision INTEGER");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

// Read only catalog fields needed for routing; transport and authentication
// configuration are deliberately outside this projection.
const catalogProjection = `SELECT c.id AS connectionId,c.name AS connectionName,c.revision,c.deletion_pending AS deleting,
    c.auto_scope IS NOT NULL AS autoApprove,
    json_extract(c.auto_scope,'$."'||t.id||'"') AS approvedDefinition,
    (c.normalized_endpoint IS NULL OR EXISTS (SELECT 1 FROM mcp_connections other
      WHERE other.endpoint=c.endpoint AND other.id<>c.id)) AS endpointConflict,
    c.last_success AS lastSuccess,c.needs_refresh AS needsRefresh,c.sync_error AS syncError,
    t.id AS toolId,t.original_name AS originalName,t.document
    FROM mcp_connections c LEFT JOIN mcp_tools t ON t.connection_id=c.id AND t.present=1`;
export function catalogRows(db, toolId) {
  return toolId === undefined ? db.prepare(catalogProjection+" ORDER BY c.name,t.original_name").all()
    : db.prepare(catalogProjection+" WHERE t.id=?").all(toolId);
}
export function sessionCatalogRows(db, sessionId, toolId) {
  const sql = catalogProjection + ` JOIN session_mcp_connections selected ON c.id=selected.connection_id
    WHERE selected.session_id=?`;
  return toolId === undefined
    ? db.prepare(sql + " ORDER BY c.id,t.id").all(sessionId)
    : db.prepare(sql + " AND t.id=?").all(sessionId,toolId);
}

export function createMcpRepository(db, now = Date.now) {
  db.exec(`CREATE TABLE IF NOT EXISTS mcp_connections (
    id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL COLLATE NOCASE UNIQUE, description TEXT NOT NULL,
    endpoint TEXT NOT NULL, transport TEXT NOT NULL, auth TEXT NOT NULL CHECK(json_valid(auth)),
    credential_ref TEXT, revision INTEGER NOT NULL DEFAULT 1, last_success INTEGER,
    needs_refresh INTEGER NOT NULL DEFAULT 1, sync_error TEXT
  );
  CREATE TABLE IF NOT EXISTS mcp_tools (
    id TEXT PRIMARY KEY NOT NULL, connection_id TEXT NOT NULL REFERENCES mcp_connections(id),
    original_name TEXT NOT NULL, document TEXT NOT NULL CHECK(json_valid(document)),
    present INTEGER NOT NULL CHECK(present IN (0,1)), UNIQUE(connection_id,original_name)
  );
  CREATE TRIGGER IF NOT EXISTS mcp_connection_identity BEFORE UPDATE OF id ON mcp_connections
    WHEN NEW.id IS NOT OLD.id BEGIN SELECT RAISE(ABORT,'Immutable connection identity'); END;
  CREATE TRIGGER IF NOT EXISTS mcp_tool_identity BEFORE UPDATE OF id,connection_id,original_name ON mcp_tools
    WHEN NEW.id IS NOT OLD.id OR NEW.connection_id IS NOT OLD.connection_id OR NEW.original_name IS NOT OLD.original_name
    BEGIN SELECT RAISE(ABORT,'Immutable tool identity'); END;`);
  migrateEndpoints(db);
  db.exec(`CREATE TABLE IF NOT EXISTS mcp_local_tool_removals (
    connection_id TEXT NOT NULL REFERENCES mcp_connections(id) ON DELETE CASCADE,
    original_name TEXT NOT NULL, PRIMARY KEY(connection_id,original_name));
    CREATE TABLE IF NOT EXISTS mcp_resources (
    connection_id TEXT NOT NULL REFERENCES mcp_connections(id) ON DELETE CASCADE,
    uri TEXT NOT NULL, document TEXT NOT NULL, PRIMARY KEY(connection_id,uri))`);
  const lookup = db.prepare("SELECT * FROM mcp_connections WHERE id=?");
  function row(id) {
    const result = lookup.get(id);
    if (!result) throw new McpProblem("missing", 404);
    return result;
  }
  function view(r) {
    return {
      connectionId: r.id,
      deletionPending: !!r.deletion_pending,
      endpointConflict: !!duplicate.get(r.endpoint, r.id),
      name: r.name,
      description: r.description,
      endpoint: r.endpoint,
      transport: r.transport,
      auth: JSON.parse(r.auth),
      revision: r.revision,
      lastSuccess: r.last_success,
      capabilities: JSON.parse(r.capabilities),
      sseObserved: r.sse_observed == null ? null : !!r.sse_observed,
      linkToolCount: db.prepare("SELECT count(*) AS n FROM mcp_tools t JOIN mcp_tool_event_observations e ON e.tool_id=t.id WHERE t.connection_id=? AND t.present=1 AND e.typed_link_revision=?").get(r.id,r.revision).n,
      resourceError: r.resource_error,
      error: r.sync_error,
      stale:
        !!r.needs_refresh ||
        r.last_success == null ||
        now() - r.last_success > 86400000,
      toolCount: db
        .prepare(
          "SELECT COUNT(*) AS n FROM mcp_tools WHERE connection_id=? AND present=1",
        )
        .get(r.id).n,
    };
  }
  function checkName(name, id) {
    if (
      db
        .prepare("SELECT id FROM mcp_connections WHERE name=? AND id<>?")
        .get(name, id)
    )
      throw new McpProblem("name", 409);
  }
  const duplicate = db.prepare(
    "SELECT id FROM mcp_connections WHERE endpoint=? AND id<>? LIMIT 1",
  );
  function checkEndpoint(endpoint, id) {
    if (duplicate.get(endpoint, id)) throw new McpProblem("endpoint", 409);
  }
  function repairLegacyIdentity(endpoint) {
    db.prepare(
      `UPDATE mcp_connections SET normalized_endpoint=endpoint WHERE endpoint=? AND normalized_endpoint IS NULL
      AND (SELECT COUNT(*) FROM mcp_connections WHERE endpoint=?)=1`,
    ).run(endpoint, endpoint);
  }
  function executionMode(id) {
    const connection = row(id);
    const scope = JSON.parse(connection.auto_scope);
    const tools = db.prepare("SELECT id, original_name AS name, document FROM mcp_tools WHERE connection_id=? AND present=1 ORDER BY original_name").all(id)
      .map(({id, name, document}) => ({id, name, definition:policyDigest(JSON.parse(document))}));
    return {
      mode: scope === null ? "attached" : "auto",
      revision: policyDigest([connection.revision, tools, scope]),
      tools: tools.map(tool => ({...tool, approved: scope?.[tool.id] === tool.definition})),
    };
  }
  function saveExecutionMode(id, body) {
    if (!body || !["auto","attached","review"].includes(body.mode) || !Array.isArray(body.toolIds) ||
        !body.toolIds.every(id => typeof id === "string") || new Set(body.toolIds).size !== body.toolIds.length ||
        (body.mode !== "auto" && body.toolIds.length)) throw new McpProblem("invalid", 400);
    db.exec("BEGIN IMMEDIATE");
    try {
      const current = executionMode(id);
      if (body.revision !== current.revision || row(id).deletion_pending) throw new McpProblem("conflict", 409);
      const ids = new Set(body.toolIds);
      const selected = current.tools.filter(tool => ids.has(tool.id));
      if (selected.length !== ids.size) throw new McpProblem("invalid", 400);
      const connection = view(row(id));
      if (body.mode === "auto" && selected.length && (connection.stale || connection.error || connection.endpointConflict))
        throw new McpProblem("conflict", 409);
      const scope = body.mode === "auto" ? JSON.stringify(Object.fromEntries(selected.map(t => [t.id, t.definition]))) : body.mode === "review" ? "{}" : null;
      db.prepare("UPDATE mcp_connections SET auto_scope=? WHERE id=?").run(scope, id);
      const updated = executionMode(id);
      db.exec("COMMIT");
      return updated;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  return {
    executionMode,
    saveExecutionMode,
    row,
    checkName,
    checkEndpoint,
    get: (id) => view(row(id)),
    list: () =>
      db.prepare("SELECT * FROM mcp_connections ORDER BY name").all().map(view),
    catalog(id) {
      const connection = view(row(id));
      const tools = db
        .prepare(
          "SELECT t.*, e.typed_link_revision FROM mcp_tools t LEFT JOIN mcp_tool_event_observations e ON e.tool_id=t.id WHERE t.connection_id=? AND t.present=1 ORDER BY t.original_name",
        )
        .all(id)
        .map((t) => ({
          toolId: t.id,
          connectionId: id,
          originalName: t.original_name,
          resourceLinksObserved: t.typed_link_revision === connection.revision,
          document: JSON.parse(t.document),
        }));
      const resources = db.prepare("SELECT document FROM mcp_resources WHERE connection_id=? ORDER BY uri")
        .all(id).map(r => JSON.parse(r.document));
      return { connection, tools, resources };
    },
    save(id, c, ref, revision, changed) {
      db.exec("BEGIN IMMEDIATE");
      try {
        checkEndpoint(c.endpoint, id);
        checkName(c.name, id);
        const previous = revision === undefined ? null : row(id);
        if (previous?.deletion_pending) throw new McpProblem("deleting", 409);
        const args = [
          c.name,
          c.description,
          c.endpoint,
          c.endpoint,
          c.transport,
          JSON.stringify(c.auth),
          ref,
        ];
        if (revision === undefined)
          db.prepare(
            "INSERT INTO mcp_connections(name,description,endpoint,normalized_endpoint,transport,auth,credential_ref,id) VALUES(?,?,?,?,?,?,?,?)",
          ).run(...args, id);
        else if (
          !db
            .prepare(
              `UPDATE mcp_connections SET name=?,description=?,endpoint=?,normalized_endpoint=?,transport=?,auth=?,credential_ref=?,
        auto_scope=CASE WHEN ? AND auto_scope IS NOT NULL THEN '{}' ELSE auto_scope END,
        revision=revision+1,needs_refresh=CASE WHEN ? THEN 1 ELSE needs_refresh END WHERE id=? AND revision=?`,
            )
            .run(...args, +changed, +changed, id, revision).changes
        )
          throw new McpProblem("conflict", 409);
        if (previous && changed) {
          db.prepare("DELETE FROM mcp_resources WHERE connection_id=?").run(id);
          db.prepare("UPDATE mcp_connections SET capabilities=NULL,resource_error=NULL,sse_observed=NULL WHERE id=?").run(id);
        }
        if (previous && previous.endpoint !== c.endpoint)
          repairLegacyIdentity(previous.endpoint);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return view(row(id));
    },
    removeTool(id, toolId, revision) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const current = row(id);
        if (current.deletion_pending || current.revision !== revision) throw new McpProblem("conflict", 409);
        db.prepare(`INSERT OR IGNORE INTO mcp_local_tool_removals SELECT connection_id,original_name
          FROM mcp_tools WHERE connection_id=? AND id=?`).run(id,toolId);
        db.prepare("DELETE FROM mcp_tools WHERE connection_id=? AND id=?").run(id, toolId);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    markDeleting(id, revision) {
      const current = row(id);
      if (current.revision !== revision) throw new McpProblem("conflict", 409);
      if (
        !db
          .prepare(
            "UPDATE mcp_connections SET deletion_pending=1 WHERE id=? AND revision=?",
          )
          .run(id, revision).changes
      )
        throw new McpProblem("conflict", 409);
      return current.credential_ref;
    },
    finishDeletion(id) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const current = row(id);
        if (!current.deletion_pending) throw new McpProblem("conflict", 409);
        db.prepare("DELETE FROM mcp_tools WHERE connection_id=?").run(id);
        db.prepare("DELETE FROM mcp_connections WHERE id=?").run(id);
        repairLegacyIdentity(current.endpoint);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    fail(id, revision, code) {
      db.prepare(
        "UPDATE mcp_connections SET needs_refresh=1,sync_error=?,resource_error=? WHERE id=? AND revision=? AND deletion_pending=0",
      ).run(code, code, id, revision);
    },
    synchronize(id, revision, tools, capabilities = null, resources = [], resourceError = null, toolError = null) {
      db.exec("BEGIN IMMEDIATE");
      try {
        if (
          !db
            .prepare(
              "UPDATE mcp_connections SET last_success=coalesce(?,last_success),capabilities=?,resource_error=?,needs_refresh=?,sync_error=? WHERE id=? AND revision=? AND deletion_pending=0",
            )
            .run(toolError ? null : now(), JSON.stringify(capabilities), resourceError, +!!toolError, toolError, id, revision).changes
        )
          throw new McpProblem("conflict", 409);
        if (resources !== null) {
          db.prepare("DELETE FROM mcp_resources WHERE connection_id=?").run(id);
          const insert = db.prepare("INSERT INTO mcp_resources VALUES(?,?,?)");
          for (const resource of resources) insert.run(id, resource.uri, JSON.stringify(resource));
        }
        if (tools !== null) {
          db.prepare(`UPDATE mcp_tools SET present=0 WHERE connection_id=? AND present=1
            AND original_name NOT IN (SELECT value FROM json_each(?))`).run(id, JSON.stringify(tools.map(t => t.name)));
          const upsert =
            db.prepare(`INSERT INTO mcp_tools(id,connection_id,original_name,document,present) VALUES(?,?,?,?,1) ON CONFLICT(connection_id,original_name)
            DO UPDATE SET document=excluded.document,present=1`);
          const removed = new Set(db.prepare("SELECT original_name FROM mcp_local_tool_removals WHERE connection_id=?").all(id).map(t=>t.original_name));
          for (const tool of tools)
            if (!removed.has(tool.name)) upsert.run(randomUUID(), id, tool.name, JSON.stringify(tool));
          if (row(id).auto_scope !== null) {
            const valid = executionMode(id).tools.filter(t => t.approved);
            db.prepare("UPDATE mcp_connections SET auto_scope=? WHERE id=?").run(
              JSON.stringify(Object.fromEntries(valid.map(t => [t.id,t.definition]))), id);
          }
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return view(row(id));
    },
  };
}
