# Day 16 — MCP Servers

Labs → Week 4 lets a chat use tools from several Model Context Protocol (MCP) servers in one request. Each chat owns its connection selection. Week 4 shares the existing Manager, session history, context strategies, versioned topic cards and session rules with the Week 3 chat. Worker sessions keep their own workflow.

## Run locally

Use Node.js 24 or later and pnpm. From `d16/`, install the locked dependencies with `pnpm install --frozen-lockfile`. In separate terminals run `pnpm server` and `pnpm dev`. Open <http://127.0.0.1:5180>. The development frontend proxies the application API to port 3016. The backend creates `data/sessions.sqlite` on first startup. Configure a tool-capable chat provider and model in the application before sending live requests.

## Connect a server

1. Open **Tools → Add custom tool → MCP Plugin**. Enter a unique connection name, a description, the endpoint and its transport. The client supports Streamable HTTP and legacy HTTP with SSE.
2. Select no authentication, a bearer token, a query parameter or custom headers. Enter credentials in the authentication controls. Use HTTPS for remote services. HTTP is available for explicitly configured local development endpoints.
3. Select **Connect**. The backend initializes the MCP connection and follows every page of `tools/list`. Open the saved connection to inspect tool names, descriptions, original schemas and discovery status. **Refresh** synchronizes the catalog. A failed refresh preserves the last successful catalog.
4. Open a Chat in **Labs → Week 4** and choose **+ Add Tools** beneath the session name. Attach one or more connections. Removing a chip detaches the connection from that chat. The global connection and its catalog stay available.

SQLite stores connection settings, credential references, the cached catalog and chat associations. Secret values use the backend credential store. Each connection has an immutable UUID and a unique normalized endpoint. Each tool has its own UUID and belongs to a connection by its original remote name. Refreshing or renaming a connection preserves tool identity. Two servers can expose identical names and schemas.

## How a tool call runs

1. The session resolver combines eligible internal tools with authorized tools from the attached catalogs. The adapter builds stable provider-facing aliases from immutable identities. The provider receives descriptions and compatible argument schemas. A schema that cannot be represented safely excludes that tool from the request.
2. The Manager assembles the user request with applicable session context and rules. It can select tools from several servers, generate arguments, and use earlier results in subsequent model calls. Service endpoints and authentication details stay on the backend.
3. The router resolves the alias to a connection, tool UUID and original remote name. It checks current session membership, catalog availability, arguments, permissions and required evidence at dispatch. The execution service records intent before the executor calls the original tool through the MCP SDK.
4. Each result is recorded separately and returned to the Manager under its provider call identifier. A later model failure leaves the completed tool outcomes available for the final report and journal.

### Authorization, dependencies and recovery

In local attached-connection mode the Manager can invoke in-scope tools with dynamically generated arguments without a per-call approval dialog. Explicit session restrictions, pinned tool definitions in Auto-approve mode, and operator-managed grants can narrow access. An operator can configure deployment grants with `DAY16_MCP_EXECUTION_POLICY_FILE`. The backend enforces their scope at dispatch and rechecks it before recovery. Attaching a connection can authorize writes, including deletion. Attach only services trusted for the task.

A dependent operation must reference a successful prerequisite in the current run and have the evidence it requires. The Manager can propose calls one at a time when batch independence is unproven. An unrelated operation may proceed when authorization, inputs and independence are established. A different server alone does not establish independence. The journal preserves completed steps, retry budgets and uncertain outcomes across restart. An interrupted write that may have reached the remote service requires reconciliation or review before it can be repeated.

### Responses and the Execution Journal

A correlated, valid MCP success reply can contain content that the application cannot display. The Manager receives supported text, structured data, usable references and a compatibility warning. Unsupported binary content is omitted. A warning alone supplies neither an artifact URL nor prerequisite evidence. An explicit tool error is recorded as a failure. A lost response to a possibly completed write remains uncertain.

Expand **Tools** in Session Stats to inspect logical call counts, retries and cumulative duration. **Open Execution Journal** shows chronological calls with service and status filters. Expand a row for authorization, argument validation, attempt details, sanitized arguments, results and diagnostics. Chat logs show compact outcome entries.

| Journal status | Meaning |
| --- | --- |
| Success · green | The tool returned a supported success result. |
| Success with warning · yellow | The operation completed with a result limitation. Inspect the retained content and warning. |
| Skipped · gray | The Manager withheld dispatch. The diagnostic identifies the reason. Skips are counted separately from execution failures. |
| Failed · red | The operation has a confirmed failure. |
| Unknown · orange | The available evidence cannot establish the remote outcome. |

A skipped call remains visible when a subsequent call completes its work. Run-level reporting reflects outstanding required operations, failures and uncertainty separately from the per-call history.

## Verification

Run these commands from `d16/`:

```sh
pnpm test
node --test server/*-integration.mjs server/*.node-test.mjs
pnpm typecheck
pnpm build
```

The regression suites use disposable databases and controlled providers and MCP servers. Coverage includes paginated discovery, identical tool definitions on different servers, session isolation, argument authorization, cross-server dependencies, unsupported responses, uncertain writes and journal recovery.

Final release verification passed 1,263 Vitest tests across 156 files and all 203 backend tests. TypeScript and the production build passed. Five Vitest cases timed out when the suites and build ran together. The complete Vitest suite passed in isolation with three workers and the original timeouts. Vite reported large production chunks. The owner completed live acceptance separately.
