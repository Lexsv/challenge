import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ILogger } from "../../application/ports/logger.js";
import type { JSONRPCMessage, ResourceLink } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { CreateReminder } from "../../application/use-cases/create-reminder.js";
import { ValidationError } from "../../domain/task.js";
import { taskStatusUri } from "./task-resource.js";

const reminderInput = z.object({
  message: z.string().trim().min(1),
  scheduledAt: z.string().describe("ISO 8601 timestamp with Z or an explicit numeric timezone offset")
});

// The SDK can reject a call before its registered callback runs. Observe decoded
// envelopes and use the same input schema without changing the transport's routing.
export function logMcpMessage(logger: ILogger, message: JSONRPCMessage): void {
  if (!("method" in message)) return;
  const knownMethods = ["initialize", "notifications/initialized", "ping", "tools/list", "tools/call",
    "resources/templates/list", "resources/read", "resources/subscribe", "resources/unsubscribe"];
  const method = knownMethods.includes(message.method) ? message.method : "other";
  logger.write("info", "mcp.request", { method });
  if (method !== "tools/call") return;

  const tool = message.params?.name === "create_reminder" ? "create_reminder" : "unknown";
  logger.write("info", "tool.invoked", { tool });
  if (tool === "unknown") {
    logger.write("warn", "tool.rejected", { tool, reason: "unknown_tool" });
  } else if (!reminderInput.safeParse(message.params?.arguments).success) {
    logger.write("warn", "tool.validation", { tool, outcome: "rejected", reason: "invalid_arguments" });
  }
}

export function createMcpServer(reminders: CreateReminder, logger: ILogger) {
  const server = new McpServer({ name: "day17-scheduler", version: "1.0.0" });
  server.registerTool("create_reminder", {
    description: "Schedule a one-time reminder at a future instant.",
    inputSchema: reminderInput,
    outputSchema: {
      id: z.string(), type: z.literal("reminder"), status: z.literal("pending"),
      message: z.string(), scheduledAt: z.string()
    }
  }, async ({ message, scheduledAt }) => {
    try {
      const task = reminders.execute(message, scheduledAt);
      logger.write("info", "tool.validation", { tool: "create_reminder", outcome: "accepted", taskId: task.id });
      const result = { id: task.id, type: task.type, status: task.status,
        message: task.message, scheduledAt: new Date(task.scheduledAt).toISOString() };
      const link: ResourceLink = {
        type: "resource_link", uri: taskStatusUri(task.id), name: "task-status", mimeType: "application/json"
      };
      return { structuredContent: result, content: [{ type: "text", text: JSON.stringify(result) }, link] };
    } catch (error) {
      if (error instanceof ValidationError) {
        logger.write("warn", "tool.validation", { tool: "create_reminder", outcome: "rejected", reason: "invalid_reminder" });
      } else {
        logger.write("error", "tool.failed", { tool: "create_reminder", reason: "creation_failed" });
      }
      const text = error instanceof ValidationError ? error.message : "Could not create the reminder";
      return { isError: true, content: [{ type: "text", text }] };
    }
  });
  return server;
}
