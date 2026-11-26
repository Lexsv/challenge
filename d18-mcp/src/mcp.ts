import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { canonicalLocation, historyInput, locationSchema, observationSchema, recordSchema } from "./model.js";
import { silent } from "./logging.js";
import { ProviderError, type WeatherProvider } from "./provider.js";
import type { WeatherStore } from "./repository.js";

function result(data: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }], structuredContent: data };
}
function failure(message: string) {
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

function sqliteErrorCode(error: unknown) {
  if (error && typeof error === "object" && "errcode" in error && typeof error.errcode === "number")
    return error.errcode;
}

export function weatherServer(provider: WeatherProvider, store: Pick<WeatherStore, "save" | "history">, log = silent) {
  const server = new McpServer({name: "d18-mcp", version: "1.0.0"});
  server.registerTool("get_weather", {
    description: "Fetch current modelled weather from Open-Meteo for the given coordinates.",
    inputSchema: {location: locationSchema},
    outputSchema: {observation: observationSchema},
    annotations: {readOnlyHint: true},
  }, async ({location}) => {
    log.write("tool.validated", "success", "Validated weather lookup coordinates.", canonicalLocation(location));
    try { return result({observation: await provider.current(location)}); }
    catch (e) { return failure(e instanceof ProviderError ? e.message : "Weather lookup failed."); }
  });
  server.registerTool("save_weather", {
    description: "Store an observation returned by get_weather. A retry returns the original record ID.",
    inputSchema: {observation: observationSchema},
    outputSchema: {id: z.int().positive(), created: z.boolean()},
    annotations: {destructiveHint: false, idempotentHint: true},
  }, ({observation}) => {
    log.write("tool.validated", "success", "Validated observation for saving.",
      {...canonicalLocation(observation.location), observedAt: new Date(observation.observedAt).toISOString()});
    try {
      const saved = store.save(observation);
      log.write(saved.created ? "sqlite.inserted" : "sqlite.duplicate", "success",
        saved.created ? "Inserted a new observation." : "Observation already exists.",
        {observationId: saved.id, created: saved.created});
      return result(saved);
    } catch (error) {
      log.write("sqlite.save.failed", "failure", "SQLite could not save the observation.", {sqliteCode: sqliteErrorCode(error)});
      return failure("Could not save the weather observation.");
    }
  });
  server.registerTool("read_weather_history", {
    description: "Read observations for coordinates in [from, to), oldest first.",
    inputSchema: historyInput,
    outputSchema: {records: z.array(recordSchema), nextOffset: z.int().nonnegative().nullable()},
    annotations: {readOnlyHint: true},
  }, (query) => {
    log.write("tool.validated", "success", "Validated history query fields.",
      {...canonicalLocation(query.location), from: new Date(query.from).toISOString(), to: new Date(query.to).toISOString(),
        limit: query.limit ?? 100, offset: query.offset ?? 0});
    try {
      const page = store.history(query);
      log.write("sqlite.history", "success", "Read observation history.", {recordCount: page.records.length});
      return result(page);
    } catch (error) {
      if (error instanceof RangeError) {
        log.write("history.range.invalid", "failure", "History start must precede end.");
        return failure("from must precede to.");
      }
      log.write("sqlite.history.failed", "failure", "SQLite could not read history.", {sqliteCode: sqliteErrorCode(error)});
      return failure("Could not read weather history.");
    }
  });
  return server;
}
