import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpError, SubscribeRequestSchema, UnsubscribeRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ITaskStatusReader } from "../../application/ports/index.js";

const taskUri = /^scheduler:\/\/tasks\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export function taskStatusUri(id: string): string {
  return "scheduler://tasks/" + id;
}

export function registerTaskResource(server: McpServer, reader: ITaskStatusReader, subscriptions: Set<string>) {
  function lookup(uri: string) {
    const id = taskUri.exec(uri)?.[1];
    const task = id && reader.findStatus(id);
    if (!task) throw new McpError(-32002, "Task resource not found");
    return task;
  }

  server.registerResource("task-status", new ResourceTemplate(taskStatusUri("{id}"), { list: undefined }),
    { description: "Persisted status of a scheduled task", mimeType: "application/json" }, uri => {
      const task = lookup(uri.href);
      const text = JSON.stringify({ ...task, scheduledAt: new Date(task.scheduledAt).toISOString() });
      return { contents: [{ uri: uri.href, mimeType: "application/json", text }] };
    });
  server.server.registerCapabilities({ resources: { subscribe: true } });
  server.server.setRequestHandler(SubscribeRequestSchema, ({ params }) => {
    subscriptions.add(lookup(params.uri).id);
    return {};
  });
  server.server.setRequestHandler(UnsubscribeRequestSchema, ({ params }) => {
    subscriptions.delete(lookup(params.uri).id);
    return {};
  });
}
