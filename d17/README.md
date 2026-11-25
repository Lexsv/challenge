# Day 17 · MCP Scheduler

A standalone TypeScript server for one-time reminders. A Streamable HTTP client connects to `http://127.0.0.1:3000/mcp` and calls `create_reminder`. The server persists each reminder before acknowledging it. When it is due, the executor logs the task ID and stores the message as the SQLite execution result.

## Start on this Mac

Run these commands in a terminal. The project-local Node installation on this Mac is ignored by Git. On a fresh checkout, put Node 24.10 or later and npm on your PATH first. Verification used Node 24.14.0, npm 11.9.0 and the official MCP TypeScript SDK 1.32.2. This Node release prints an experimental warning for its built-in SQLite module.

```sh
cd /Users/alex/challenge/d17
export PATH="$PWD/.toolchain/node-v24.14.0-darwin-arm64/bin:$PATH"
npm ci
npm run build
npm start
```

The configured LaunchAgent already has a private `.env`. For a fresh installation, copy `.env.example` to `.env` and supply a high-entropy `MCP_AUTH_TOKEN` before starting. `npm start` loads it. Exported environment variables take precedence. Stop with Ctrl-C or SIGTERM. Shutdown closes the listener, drains active requests and the current polling pass, and closes SQLite.

## Connect the Day 16 client

Choose **Streamable HTTP**, enter the endpoint above, list tools, and invoke `create_reminder`. Local defaults accept requests from native clients without an Origin header. For a browser client on another origin, add its exact origin to `ALLOWED_ORIGINS`. An existing browser application served over HTTPS may require an HTTPS endpoint. The server returns JSON for POST requests and opens a persistent SSE stream on GET at the same endpoint. The SDK carries the negotiated MCP protocol version and session ID on subsequent requests.

Example arguments (choose a time still in the future when running):

```json
{
  "message": "Review tomorrow's schedule",
  "scheduledAt": "2030-04-12T09:00:00-04:00"
}
```

A successful response includes the reminder in `structuredContent` and as JSON text in `content[0]`. The next content item is a standard MCP `resource_link` named `task-status` with MIME type `application/json`. Its URI identifies the readable, subscribable status resource. Example `structuredContent`:

```json
{
  "id": "2259f147-e534-4622-baea-58c29cc1b732",
  "type": "reminder",
  "status": "pending",
  "message": "Review tomorrow's schedule",
  "scheduledAt": "2030-04-12T13:00:00.000Z"
}
```

The use case trims the message, checks calendar validity and requires a future timestamp with an explicit offset or `Z`. Instants use millisecond precision and responses use UTC. Tool errors appear in the MCP error result. Each successful call creates a distinct reminder, including repeated client submissions.

### Receive completion in the Day 16 backend

1. Initialize a long-lived SDK client at `/mcp`. Supply TLS trust and the bearer credential on every request, including the streaming GET and session DELETE. The initialize result advertises `resources.subscribe: true`. The official SDK sends `Mcp-Session-Id` and opens `GET /mcp` with `Accept: text/event-stream`. One GET stream is available per session.
2. Register a handler for `ResourceUpdatedNotificationSchema`. Create the reminder, find the `resource_link` in the result content, and save its URI (`scheduler://tasks/{id}`). This template is discoverable through `resources/templates/list`. Task IDs are not enumerated by resource discovery.
3. Subscribe to that URI with `resources/subscribe`. Read it once after the stream and subscription are established, then read it again whenever `notifications/resources/updated` arrives. The notification contains `params.uri`. The `resources/read` response has one `application/json` text item with `id`, `type`, `status`, and UTC `scheduledAt`. Treat SQLite as the source of truth and handle repeated reads idempotently.
4. After a dropped stream, reconnect and reread outstanding resources. Subscriptions survive a GET reconnect within the same session. HTTP 404 for an expired or restarted session requires fresh initialization, subscription and read. Events that occurred while disconnected are recoverable through the status read; there is no event replay buffer.
5. Call `resources/unsubscribe` when finished tracking a task. When the backend is done with its session, call the transport's `terminateSession()` (DELETE), then `client.close()`. Shutdown clears sessions and closes active streams.

The configured bearer token identifies one trusted backend principal. Authenticated sessions with a known task UUID can read and subscribe to that task, including after a reconnect. Each session receives updates only for its own subscriptions. The task payload, result, and error text are excluded from this status resource.

Example TypeScript using a connected SDK client and the resource link returned by `create_reminder`:

```ts
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

const { uri } = resourceLink;
async function readStatus() {
  const { contents } = await client.readResource({ uri });
  const item = contents[0];
  if (item && "text" in item) return JSON.parse(item.text);
}
client.setNotificationHandler(ResourceUpdatedNotificationSchema, async ({ params }) => {
  if (params.uri === uri) await onTaskStatus(await readStatus());
});
await client.subscribeResource({ uri });
await onTaskStatus(await readStatus());
```

For multiple tasks, register one handler and dispatch by URI. Keep the client running while waiting for the scheduler.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `SERVER_HOST` | `127.0.0.1` | Bind to localhost or a specific interface IP. Wildcard binds are rejected. |
| `SERVER_PORT` | `3000` | TCP port, 1–65535. |
| `DATABASE_PATH` | `./data/tasks.sqlite` | Local SQLite file. Relative paths resolve from the process working directory. The parent directory is created at startup. |
| `POLL_INTERVAL_MS` | `1000` | Milliseconds between completed polling passes, 1–2147483647. |
| `SESSION_IDLE_MS` | `900000` | Session retention after its last connection closes, in milliseconds (1–2147483647). An open GET stream keeps the session active. |
| `DEFAULT_TIMEZONE` | `UTC` | IANA time zone for an optional local display field. The primary timestamp always uses UTC. Tool inputs always carry their own offset. |
| `LOG_DIR` | `./data/logs` | LaunchAgent log directory. Relative paths resolve from the project directory. |
| `LOG_MAX_SIZE_MB` | `10` | Maximum active file size per stream in decimal MB (1–10). |
| `LOG_MAX_ARCHIVES` | `5` | Number of gzip archives retained per stream (1–5). |
| `LOG_LEVEL` | `info` | One of `debug`, `info`, `warn`, `error`. At warn or error level, reminders still execute and persist their results. |
| `MCP_AUTH_TOKEN` | unset | Shared bearer token, at least 32 token characters. Required on every bind. |
| `ALLOWED_ORIGINS` | bound server origin on localhost | Comma-separated exact origins including scheme and non-default port. LAN requires an explicit HTTPS origin list. |
| `TLS_CERT_PATH`, `TLS_KEY_PATH` | unset | PEM certificate chain and private key. Set both for HTTPS. Required on LAN. |

For LAN use, bind to the Mac's specific LAN IP and provision a certificate trusted by the client with that IP in its subject alternative names. Configure both TLS paths, allow the client origin, and set a random token (for example, generate one with `openssl rand -hex 32`). Connect to `https://<bound-ip>:<port>/mcp` with `Authorization: Bearer <token>`. The server validates Host, checks every supplied Origin and authenticates each tool request. Native clients can omit Origin. Browser preflight is supported. Keep the token and private key outside version control.

## Scheduling and recovery

- SQLite stores the task ID, type, status, message, due instant, result and error. An index covers pending tasks by due time and ID.
- A single timer polls immediately at startup and again after each pass. Each pass handles up to 100 due tasks sequentially. A conditional SQLite update claims the earliest pending task and sets it to `running` before invoking its executor.
- Success persists `completed` and the result. An executor exception or missing registration persists `failed` and an error. A guarded repository operation supports `pending → cancelled`. Phase 1 exposes creation through MCP.
- One process owns the database file through an exclusive SQLite lock. A second instance using the same file fails at startup. On restart, pending tasks retain their schedules, including overdue reminders. Interrupted running tasks become failed with an unknown-outcome diagnostic. The scheduler never automatically replays them because a crash can occur after the executor's side effect and before completion is recorded.
- The scheduler publishes completion after SQLite commits the outcome. A presentation-layer subscriber sends a resource update to each interested MCP session. A delivery failure leaves the persisted task outcome intact.

## Code layout

| Location | Responsibility |
| --- | --- |
| `src/domain/` | Task model, state and outcome types, schedule and message rules, domain event types. |
| `src/application/` | CreateReminder, scheduler, executor selection and the clock, repository, executor, scheduler and event publisher ports. |
| `src/infrastructure/` | SQLite statements, system clock, polling timer, reminder executor, logging and local event observation. |
| `src/presentation/mcp/` | Official SDK server, tool schemas and responses, HTTP transport and request authorization. |
| `src/config/`, `src/main.ts` | Validated configuration, constructor wiring, startup, recovery and shutdown. |

To add a task type, define its domain data and persistence mapping, implement `ITaskExecutor`, and register that executor in the composition root. The scheduling loop dispatches by type.

## Verification

```sh
npm run typecheck
npm test
npm run smoke
```

Tests use an injected clock and exercise SQLite claims, failures, cancellation, restart recovery, tool registration and validation. The smoke test starts the built server on a temporary loopback port, uses the official SDK client to initialize, list tools and create a reminder, checks HTTP access controls, and reads the saved row after SIGTERM. Independent SDK clients also verify SSE delivery, per-task isolation, unsubscribe, dropped-stream reconnect, new-session resubscription, idle expiry and explicit session termination. Test databases are isolated under `.test-data/`. Local dependencies, build output, the runtime, secrets and database files are ignored by Git.


## Operate the Mac mini service

The configured service runs under the current user's macOS launchd GUI session. Its job definition, TLS material, database and logs are under the ignored `data/` directory. The job uses the project-local Node executable, reads `.env` on each start and restarts on exit. Closing Terminal leaves the job running. A new login after logout or reboot requires the start command below.

Run these in the same shell, from the project directory:

```sh
cd /Users/alex/challenge/d17
label=local.day17.mcp-scheduler
domain="gui/$(id -u)"
job="$domain/$label"
plist="$PWD/data/launchd/$label.plist"

launchctl print "$job"                  # inspect state and PID
tail -n 0 -F data/logs/scheduler.log    # stream new records
launchctl kill SIGTERM "$job"           # graceful restart via KeepAlive
launchctl bootout "$job"                # stop and unload
launchctl bootstrap "$domain" "$plist"   # start a stopped job
```

The service binds only to the private interface selected in `.env`. To display the configured endpoint without printing credentials:

```sh
.toolchain/node-*/bin/node --env-file=.env -p '"https://" + process.env.SERVER_HOST + ":" + process.env.SERVER_PORT + "/mcp"'
```

Configure the Day 16 backend as the MCP client. Register the scheduler as `day17-scheduler`, using the description “Schedule one-time reminders on the Mac mini.” Choose Streamable HTTP and use the HTTPS endpoint. Supply `Authorization: Bearer <token>` on every MCP request. Provision the `MCP_AUTH_TOKEN` value from the private project `.env` into the client's secret storage. For an SDK client, set the authorization header through the HTTP transport's `requestInit.headers`. The SDK handles protocol headers, including `Content-Type: application/json` and `Accept: application/json, text/event-stream`.

Transfer only the **public** `data/tls/server.pem` to the client using a trusted channel. Compare its SHA-256 fingerprint with `openssl x509 -in data/tls/server.pem -noout -fingerprint -sha256`. For a Node client, point `NODE_EXTRA_CA_CERTS` at its local copy before starting the client process. Other clients need equivalent trust for this self-signed server certificate. The endpoint IP must match the certificate's IP SAN. If the LAN address changes, update the server configuration, issue a matching certificate and update client trust and the endpoint. Check expiry with `openssl x509 -in data/tls/server.pem -noout -enddate`.

The Day 16 backend should omit Origin. The scheduler checks any supplied Origin against its exact allowlist. Store the token in the backend environment and keep it out of browser code. The only advertised tool is `create_reminder`.

## Monitor a Day 16 call

Run this command in a separate Herdr terminal on the Mac mini. It starts at the end of the current log and follows the filename across rotation.

```sh
tail -n 0 -F /Users/alex/challenge/d17/data/logs/scheduler.log
```

At the default info level, each application record contains an ISO 8601 UTC `time`, a `level` and an `event`. Use the server-generated `requestId` (also returned in `X-Request-Id`) to trace HTTP receipt, authentication, MCP method, tool invocation and validation. The `task.created` record connects the request to its `taskId`. Follow that ID through `task.started`, `reminder.executed` and `task.finished`. The final record carries the persisted status. Failures carry a safe reason code. Reminder text, executor result text, raw exceptions, request bodies and headers are excluded. The service also captures stdout in `data/logs/stdout.log`. Node runtime notices can appear on stderr alongside the JSON records.

## File rotation

The LaunchAgent runs `dist/src/service.js` with the existing project-local Node and `--env-file=.env`. This entry point forwards termination signals to the scheduler and drains both pipes on graceful shutdown. It sends the scheduler's full stderr stream (including the existing structured logger) to `scheduler.log`, and stdout to `stdout.log`. The supervisor's launchd `StandardOutPath` and `StandardErrorPath` are both `/dev/null`, so launchd never holds an extra file descriptor on a renamed archive. Foreground `npm start` continues to log to the terminal.

Each stream rotates independently before exceeding its size limit. The writer reserves up to 64 KiB for the final write. The newest archive is `.1.gz`; subsequent rotations replace the oldest archive at the configured retention limit. Reducing retention takes effect when the service next opens the directory. Gzip is always enabled. JSON records keep their original bytes and UTC timestamps. Follow the active filename with `tail -n 0 -F`, or open the active and archived logs in lnav:

```sh
cd /Users/alex/challenge/d17
find data/logs -type f \( -name scheduler.log -o -name 'scheduler.log.*.gz' \) -exec lnav {} +
```

For an existing LaunchAgent using `dist/src/main.js`, set its final program argument to `dist/src/service.js` and both launchd output paths to `/dev/null` in the job plist. After approving the service interruption, unload and bootstrap the job to load the new plist. Subsequent changes to the three log environment settings require a graceful restart. Run only one service writer per log directory.

## Docker deployment on Apple Silicon

The `linux/arm64` image is tagged `mcp-scheduler:1.0.0`. Its runtime contains Node.js, its required Linux shared libraries, production npm packages and the compiled server. It runs as UID/GID 1000. The build context allows the package manifests, TypeScript compiler configuration and application source. The final stage starts from `scratch`. Configuration, credentials, TLS material and the database are provisioned at runtime.

### Build and export

Run from the Day 17 source directory on a Docker host with Buildx:

```sh
docker buildx build --platform linux/arm64 --pull --no-cache --provenance=false \
  --load -t mcp-scheduler:1.0.0 .
mkdir -p /Users/alex/Documents/challenge/d17
docker save --platform linux/arm64 -o /Users/alex/Documents/challenge/d17/mcp-scheduler.tar mcp-scheduler:1.0.0
shasum -a 256 /Users/alex/Documents/challenge/d17/mcp-scheduler.tar
```

Distribute the tar with its SHA-256 checksum. The recipient needs Docker and the archive. Compare the checksum before loading:

```sh
cd /Users/alex/Documents/challenge/d17
shasum -a 256 mcp-scheduler.tar
docker load -i mcp-scheduler.tar
docker image inspect mcp-scheduler:1.0.0 --format '{{.Os}}/{{.Architecture}} {{.Id}}'
```

### Start with persistent storage

For a host-local backend, this example uses port 3100 so it can coexist with the native LaunchAgent on port 3000. It requires Docker Engine on Linux or Docker Desktop with host networking enabled. Configure the same high-entropy bearer token in the client and the container. Supply it through your environment or secret manager.

```sh
: "${MCP_AUTH_TOKEN:?Export the deployed service bearer token first}"
docker volume create day17-container-data
docker run -d --name day17-container --restart unless-stopped \
  --network host --read-only \
  -e MCP_AUTH_TOKEN -e SERVER_HOST=127.0.0.1 -e SERVER_PORT=3100 \
  --mount type=volume,src=day17-container-data,dst=/var/lib/scheduler \
  mcp-scheduler:1.0.0
```

Connect to `http://127.0.0.1:3100/mcp` with the bearer header. For a container-only backend, omit `--network host` and have the backend share the scheduler's network namespace with `--network container:day17-container`. A localhost bind inside a bridge-network container is reachable inside that namespace. [Docker host networking](https://docs.docker.com/engine/network/drivers/host/)

For LAN deployments on a network where the container can bind the selected interface address, supply an explicit `SERVER_HOST`, trusted TLS certificate and matching private key mounted read-only, `TLS_CERT_PATH`, `TLS_KEY_PATH`, and exact HTTPS `ALLOWED_ORIGINS`. The container user needs read access to the mounted TLS files. Docker Desktop host networking has interface-binding limitations; the example above is for loopback access.

The image writes SQLite to `/var/lib/scheduler/tasks.sqlite` and rotating logs to `/var/lib/scheduler/logs`. A fresh volume starts with zero tasks. To replace the container, stop and remove that container, then repeat the run command with the same named volume. Keep one scheduler process per database. Give the container its own volume, separate from the Mac LaunchAgent's project-local `data/`. The application image is read-only in the example. [Docker volumes](https://docs.docker.com/engine/storage/volumes/)
