import {
  subscriptionState,
  resourceFields,
} from "./mcp-resource-presentation.mjs";
import { localUiRequest } from "./mcp-routes.mjs";

// The local inbox belongs to this installation. Re-evaluate the operator's grants
// and chat attachment on every read and mutation, including count-only requests.
export function createNotificationRoutes(
  db,
  visibleWatchIds,
  subscriptionIds = visibleWatchIds,
  unsubscribe,
) {
  const visible = `watch_id IN (SELECT value FROM json_each(?)) AND EXISTS (
      SELECT 1 FROM mcp_resource_watches w WHERE w.id=mcp_resource_notifications.watch_id
      AND w.connection_id=mcp_resource_notifications.connection_id
      AND w.uri=mcp_resource_notifications.uri AND w.scope=coalesce(mcp_resource_notifications.session_id,''))`;
  db.exec(
    "CREATE INDEX IF NOT EXISTS mcp_notifications_history ON mcp_resource_notifications(received_at DESC,id DESC)",
  );
  const counts =
    db.prepare(`SELECT count(*) AS unread,coalesce(max(id),0) AS through
    FROM mcp_resource_notifications WHERE read_at IS NULL AND ${visible}`);
  const page =
    db.prepare(`SELECT id,kind,source_name AS source,received_at AS receivedAt,read_at AS readAt,
    session_id AS sessionId,content,EXISTS(SELECT 1 FROM session_invariants
      WHERE session_id='week3:'||mcp_resource_notifications.session_id AND enabled=1) AS protected
    FROM mcp_resource_notifications WHERE ${visible} AND (received_at,id)<(?,?)
    ORDER BY received_at DESC,id DESC LIMIT ?`);
  const subscriptions =
    db.prepare(`SELECT w.id,c.name AS source,w.uri,w.status,w.remote_status AS remoteStatus,w.title,w.description,
    w.scheduled_at AS scheduledAt,w.updated_at AS updatedAt,s.title AS chat,
    (SELECT json_group_array(DISTINCT t.original_name) FROM mcp_watch_origins o JOIN mcp_tools t ON t.id=o.tool_id WHERE o.watch_id=w.id) AS tools,
    (w.read_denied OR EXISTS(SELECT 1 FROM session_invariants WHERE session_id='week3:'||w.scope AND enabled=1)) AS protected
    FROM mcp_resource_watches w JOIN mcp_connections c ON c.id=w.connection_id LEFT JOIN week3_sessions s ON s.id=w.scope
    WHERE w.id IN (SELECT value FROM json_each(?)) ORDER BY c.name,w.uri,w.id`);
  const mark =
    db.prepare(`UPDATE mcp_resource_notifications SET read_at=coalesce(read_at,?)
    WHERE ${visible} AND id=? RETURNING id`);
  const markAll = db.prepare(`UPDATE mcp_resource_notifications SET read_at=?
    WHERE read_at IS NULL AND ${visible} AND id<=?`);
  return function route(req, path, reply) {
    if (
      path !== "/api/notifications" &&
      !path.startsWith("/api/notifications/")
    )
      return false;
    if (!localUiRequest(req, "notifications")) {
      reply(403, { error: "Local UI access required." });
      return true;
    }
    const grants = JSON.stringify(visibleWatchIds());
    const params = new URL(req.url, "http://localhost").searchParams;
    const numeric = (s) =>
      /^\d+$/.test(s ?? "") && Number.isSafeInteger(Number(s));
    if (req.method === "GET" && path === "/api/notifications/unread")
      reply(200, counts.get(grants));
    else if (req.method === "GET" && path === "/api/notifications") {
      const limit = params.get("limit") ?? "15";
      const cursor = params.get("before")?.split(".");
      if (
        !numeric(limit) ||
        +limit < 1 ||
        +limit > 50 ||
        (cursor && (cursor.length !== 2 || !cursor.every(numeric)))
      ) {
        reply(400, { error: "Invalid notification page." });
        return true;
      }
      const [at, id] = cursor?.map(Number) ?? [
        Number.MAX_SAFE_INTEGER,
        Number.MAX_SAFE_INTEGER,
      ];
      const rows = page.all(grants, at, id, +limit + 1);
      const more = rows.length > +limit;
      if (more) rows.pop();
      const items = rows.map(({ protected: restricted, ...row }) => {
        if (restricted) {
          row.content = null;
          row.source = "MCP connection";
        }
        let status = null;
        try {
          const data = JSON.parse(row.content);
          const value = data?.status ?? data?.state;
          if (typeof value === "string" && value.trim() && value.length <= 80)
            status = value;
        } catch {
          /* Plain text is a valid resource representation. */
        }
        return {
          ...row,
          status,
          message: resourceFields([row.content]).message,
        };
      });
      const last = rows.at(-1);
      reply(200, {
        ...counts.get(grants),
        items,
        subscriptions: subscriptions
          .all(JSON.stringify(subscriptionIds()))
          .filter((w) => w.status !== "unsubscribed")
          .map(({ protected: restricted, ...w }) => ({
            ...w,
            status: subscriptionState[w.status],
            remoteStatus: w.remoteStatus ?? "Unknown",
            tools: JSON.parse(w.tools),
            ...(restricted && {
              source: "MCP connection",
              uri: null,
              title: null,
              chat: null,
              description: null,
              tools: [],
              scheduledAt: null,
              remoteStatus: "Unknown",
            }),
          })),
        next: more ? last.receivedAt + "." + last.id : null,
      });
    } else if (
      req.method === "DELETE" &&
      /^\/api\/notifications\/subscriptions\/[a-f0-9-]{36}$/.test(path)
    ) {
      const found = unsubscribe?.(path.split("/").at(-1));
      reply(
        found ? 200 : 404,
        found ? counts.get(grants) : { error: "Subscription unavailable." },
      );
    } else if (req.method === "PUT" && path === "/api/notifications/read-all") {
      const through = params.get("through");
      if (!numeric(through))
        reply(400, { error: "A notification cutoff is required." });
      else {
        markAll.run(Date.now(), grants, +through);
        reply(200, counts.get(grants));
      }
    } else if (
      req.method === "PUT" &&
      /^\/api\/notifications\/\d+\/read$/.test(path)
    ) {
      const id = path.split("/")[3];
      if (numeric(id) && mark.get(Date.now(), grants, +id))
        reply(200, counts.get(grants));
      else reply(404, { error: "Notification unavailable." });
    } else reply(405, { error: "Unsupported notification operation." });
    return true;
  };
}
