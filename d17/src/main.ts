import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { createServer as httpServer, type RequestListener } from "node:http";
import { createServer as httpsServer } from "node:https";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { loadConfig } from "./config/config.js";
import { CreateReminder } from "./application/use-cases/create-reminder.js";
import { Scheduler, TaskExecution } from "./application/scheduler.js";
import { SqliteTasks } from "./infrastructure/sqlite-tasks.js";
import { LocalEventPublisher, PollTimer, ReminderExecutor, SystemClock } from "./infrastructure/runtime.js";
import { Logger, logTaskEvent } from "./infrastructure/logger.js";
import { StaticTokenValidator } from "./infrastructure/static-token-validator.js";
import { mcpHandler } from "./presentation/mcp/http.js";

import { McpSessions } from "./presentation/mcp/sessions.js";
import { createMcpServer } from "./presentation/mcp/server.js";
import { registerTaskResource } from "./presentation/mcp/task-resource.js";

async function main() {
  const config = loadConfig(process.env);
  const logger = new Logger(config.level, config.timezone);
  mkdirSync(dirname(config.database), { recursive: true });
  const db = new DatabaseSync(config.database);
  try {
    const events = new LocalEventPublisher(event => logTaskEvent(logger, event));
    const tasks = new SqliteTasks(db, events);
    const clock = new SystemClock();
    const create = new CreateReminder(tasks, clock, events, randomUUID);
    const sessions = new McpSessions(subscriptions => {
      const server = createMcpServer(create, logger);
      registerTaskResource(server, tasks, subscriptions);
      return server;
    }, logger, config.sessionIdleMs);
    events.addObserver(event => sessions.publish(event));
    const handleMcp = mcpHandler(config, sessions, new StaticTokenValidator(config.token), logger);
    const handler: RequestListener = (req, res) => {
      const requestId = randomUUID();
      res.setHeader("X-Request-Id", requestId);
      return logger.withRequest(requestId, () => handleMcp(req, res));
    };
    const server = config.tlsCert && config.tlsKey
      ? httpsServer({ cert: readFileSync(config.tlsCert), key: readFileSync(config.tlsKey) }, handler)
      : httpServer(handler);
    const executor = new ReminderExecutor((_message, taskId) => logger.write("info", "reminder.executed", { taskId }));
    const scheduler = new Scheduler(tasks, clock, new TaskExecution([executor]), events);
    const timer = new PollTimer(scheduler, config.pollInterval, () => {
      logger.write("error", "scheduler.poll_failed");
      process.exitCode = 1;
      void shutdown();
    });
    tasks.recoverInterrupted();

    server.listen(config.port, config.host);
    await once(server, "listening");
    let closing = false;
    async function shutdown() {
      if (closing) return;
      closing = true;
      const drained = new Promise<void>(resolve => server.close(() => resolve()));
      await Promise.all([drained, timer.stop(), sessions.close()]);
      db.close();
    }
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    logger.write("info", "server.listening");
    timer.start();
  } catch (error) {
    db.close();
    throw error;
  }
}

main().catch(() => {
  new Logger("error", "UTC").write("error", "server.startup_failed");
  process.exitCode = 1;
});
