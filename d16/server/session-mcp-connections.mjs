// Week 4 shares the Week 3 chat session identity. Associations contain no copied
// catalog data or credentials, and neither attachment nor removal opens a transport.
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createSessionMcpRoutes(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS session_mcp_connections (
    session_id TEXT NOT NULL REFERENCES week3_sessions(id) ON DELETE CASCADE,
    connection_id TEXT NOT NULL REFERENCES mcp_connections(id) ON DELETE CASCADE,
    PRIMARY KEY (session_id, connection_id)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS session_mcp_read_consents (
    session_id TEXT NOT NULL, connection_id TEXT NOT NULL,
    tool_id TEXT NOT NULL REFERENCES mcp_tools(id) ON DELETE CASCADE, scope_digest TEXT NOT NULL,
    PRIMARY KEY (session_id, connection_id, tool_id, scope_digest),
    FOREIGN KEY (session_id, connection_id) REFERENCES session_mcp_connections(session_id, connection_id) ON DELETE CASCADE
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS session_mcp_permissions (
    session_id TEXT NOT NULL, connection_id TEXT NOT NULL, grants TEXT NOT NULL CHECK(json_valid(grants)),
    PRIMARY KEY(session_id,connection_id),
    FOREIGN KEY(session_id,connection_id) REFERENCES session_mcp_connections(session_id,connection_id) ON DELETE CASCADE
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS session_mcp_by_connection ON session_mcp_connections(connection_id);`);
  const chat = db.prepare("SELECT 1 FROM week3_sessions WHERE id=?");
  const connection = db.prepare(
    "SELECT deletion_pending FROM mcp_connections WHERE id=?",
  );
  const options =
    db.prepare(`SELECT c.id AS id, c.name, a.connection_id IS NOT NULL AS selected, c.deletion_pending AS pending
    FROM mcp_connections c LEFT JOIN session_mcp_connections a ON a.connection_id=c.id AND a.session_id=?
    WHERE c.deletion_pending=0 OR a.connection_id IS NOT NULL ORDER BY c.name, c.id`);
  const attach =
    db.prepare(`INSERT INTO session_mcp_connections(session_id,connection_id) VALUES(?,?)
    ON CONFLICT(session_id,connection_id) DO NOTHING`);
  const detach = db.prepare(
    "DELETE FROM session_mcp_connections WHERE session_id=? AND connection_id=?",
  );

  return function route(req, path, reply) {
    const match = path.match(
      /^\/api\/week4\/sessions\/([^/]+)\/mcp-connections(?:\/([^/]+))?$/,
    );
    if (!match) return false;
    const [, sessionId, connectionId] = match;
    if (!uuid.test(sessionId) || (connectionId && !uuid.test(connectionId))) {
      reply(400, { error: "Invalid session or connection ID." });
    } else if (!chat.get(sessionId)) {
      reply(404, { error: "Chat session not found." });
    } else if (!connectionId && req.method === "GET") {
      reply(
        200,
        options.all(sessionId).map((row) => ({
          id: row.id,
          name: row.name,
          selected: !!row.selected,
          pendingDeletion: !!row.pending,
        })),
      );
    } else if (
      connectionId &&
      (req.method === "PUT" || req.method === "DELETE")
    ) {
      db.exec("BEGIN IMMEDIATE");
      let status = 200;
      let result = { selected: req.method === "PUT" };
      try {
        const target = connection.get(connectionId);
        if (!chat.get(sessionId) || !target) {
          status = 404;
          result = { error: "The chat or MCP connection no longer exists." };
        } else if (req.method === "PUT" && target.deletion_pending) {
          status = 409;
          result = { error: "This MCP connection is being deleted." };
        } else {
          (req.method === "PUT" ? attach : detach).run(sessionId, connectionId);
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      reply(status, result);
    } else {
      reply(405, { error: "Method not allowed." });
    }
    return true;
  };
}
