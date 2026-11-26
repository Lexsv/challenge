# Background MCP resource watches

The backend records the capabilities advertised during initialization. Refresh a previously saved connection once to populate its capability and resource catalog. A watch requires the server to advertise `resources.subscribe` and an explicit watch grant. In Tools, open the connection catalog, select the tool, and choose **Enable automatic watching in attached chats**. This setting is saved for that tool and connection revision. An authorized call supplies its chat and call ID at execution time. New chats that attach the same connection can use the setting immediately. Tool execution permissions remain separate.

For narrower deployment grants or a catalog resource, set `DAY18_MCP_RESOURCE_WATCH_POLICY` before starting the backend. Its default is `[]`.

The following example uses illustrative identifiers. Replace them with the connection's current UUID and configuration revision, the actual chat and tool UUIDs, and an exact URI returned by the server. Keep credentials in the existing MCP connection settings.

```json
[
  {
    "connectionId": "00000000-0000-4000-8000-000000000001",
    "revision": 1,
    "uri": "example:published-resource"
  },
  {
    "connectionId": "00000000-0000-4000-8000-000000000001",
    "revision": 1,
    "sessionId": "00000000-0000-4000-8000-000000000002",
    "toolId": "00000000-0000-4000-8000-000000000003"
  }
]
```

The first grant watches one resource in the connection's catalog. Add `sessionId` to restrict it to an attached chat. The second follows typed MCP resource links and embedded resource references returned by that tool in that chat. An optional `uri` further restricts this grant. Changing the connection's configuration revision requires renewing its grant. Detaching a chat removes its watches. Removing a local tool, or discovering that it has left the remote catalog, revokes its current watch grants in every chat. A locally removed tool stays excluded from future discovery on that connection. Other authorized origins keep their subscriptions to the same resource. Removing a connection stops all of its watches. Both operations retain historical notifications and their known tool-call associations in SQLite for audit. The inbox and Active Subscriptions section show only currently authorized watches. Remote unsubscribe is best effort when disconnected. Removing a watch never cancels the underlying task.

The backend subscribes and reads an initial baseline. It records a notification when a later authorized read observes changed contents. After a restart or connection loss, it resubscribes and compares the latest state with the last persisted checkpoint. Events during an outage can coalesce into one observed change. Servers without subscription support remain available for their other advertised capabilities.

Notifications store bounded sanitized text where available. Protected chats record change metadata only. The header bell shows unread changes for currently authorized watches. Open it to view recent history, page through older entries, or mark notifications as read. Read state is shared across tabs. The Tools registry distinguishes observed SSE and typed references from advertised subscriptions and configured watch grants. Processing runs independently of the browser and uses no model calls.


The Notification Center separates the local subscription from the latest remote resource state. One connection revision shares one remote subscription to a URI across authorized origins. Each chat retains its own checkpoint and notifications. Unsubscribe stops updates for that chat and resource, including after restart. It preserves the remote task and prior notifications. Deleting a chat removes access to its inbox and keeps the underlying notification audit records.

A typed link supplies a name and optional description. A textual JSON resource can supply a title, description, timezone-qualified `scheduledAt`, message and explicit `status` or `state`. Pending, scheduled, queued, running, completed, cancelled, canceled and failed are recognized. Other representations show Unknown and continue tracking. A confirmed terminal snapshot creates the final notification and retires the local watch. A pending baseline contributes zero unread notifications.
