import { ToolSchema } from "@modelcontextprotocol/sdk/types.js";
import { executionError } from "../src/execution-policy.ts";

const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
/** @returns {import("../src/app-result.ts").AppResult<import("../src/tool-runtime.ts").McpToolCatalogItem,import("../src/execution-policy.ts").ExecutionError>} */
export function adaptMcpTool(row, now) {
  try {
    const document = JSON.parse(row.document);
    if (
      !uuid.test(row.connectionId) ||
      !uuid.test(row.toolId) ||
      !row.originalName?.trim() ||
      document?.name !== row.originalName ||
      !ToolSchema.safeParse(document).success
    )
      throw Error();
    const { name, description, inputSchema, outputSchema, ...metadata } =
      document;
    return {
      ok: true,
      data: {
        kind: "mcp",
        source: "mcp",
        id: "mcp:" + row.toolId,
        toolId: row.toolId,
        connectionId: row.connectionId,
        originalName: name,
        name,
        description: description ?? "",
        executable: true,
        inputSchema,
        ...(outputSchema && { outputSchema }),
        metadata,
      },
    };
  } catch {
    return {
      ok: false,
      error: executionError(
        "invalid_definition",
        "resolver",
        "resolution",
        now,
      ),
    };
  }
}
