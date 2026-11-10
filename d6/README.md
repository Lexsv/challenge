# Expert Lab — D6 (Week 2 / Day 6)

This project implements the D6 AI Lab: a React + Material UI application for experimenting with agents, tools, and provider/model configurations.

## Design Preview

![D6 AI Lab interface](designs/Experiment%20Studio%20Dashboard.png)

## Design Gallery

- **D6 UI kit and design system board** — [D6 UI Kit Design System Board](designs/D6%20UI%20Kit%20Design%20System%20Board.png)
- **Experiment Studio dashboard** — [Experiment Studio Dashboard](designs/Experiment%20Studio%20Dashboard.png)
- **Agent analyst settings** — [Expert Lab Analyst Settings](designs/Expert%20Lab%20Analyst%20Settings.png)
- **Agent parameters dashboard** — [Expert Lab Agent Parameters Dashboard](designs/Expert%20Lab%20Agent%20Parameters%20Dashboard.png)
- **Provider dashboard** — [Expert Lab Provider Dashboard](designs/Expert%20Lab%20Provider%20Dashboard.png)
- **AI Agent tool setup modal** — [AI Agent Tool Setup Modal-1](designs/AI%20Agent%20Tool%20Setup%20Modal-1.png)
- **API Tool configuration modal** — [API Tool Configuration Modal-2](designs/API%20Tool%20Configuration%20Modal-2.png)

## D6 overview and learning objectives

D6 focuses on building and validating a browser-based manager-agent workflow where:

- a **Manager Agent** decides when to call tools,
- tools are executed through a shared **Tool Registry**,
- results are shown in a **technical timeline**,
- and calculations remain deterministic in local tools.

Learning goals:

- model + provider configuration hygiene,
- tool contract design and validation,
- browser-safe HTTP tool integration,
- clear timeline observability for tool runs.

## Application architecture

Main areas:

- **Labs**
  - Week 1 experiment studio
  - Week 2 Agent Tool Lab (manager + timeline)
- **Agents**
  - create/edit agent prompts and model parameters
- **Tools**
  - built-in catalog + custom tool cards (non-executable custom tools)
- **Providers**
  - provider credentials, model lists, verification, parameter settings

Core runtime pieces:

- `main.tsx` initializes provider registry and shared tool registry.
- `manager-agent.ts` runs the manager loop, records tool executions with timestamps/status.
- `tool-runtime.ts` defines executable built-in tools and validation/dispatch.
- `week2-agent-tool-lab.tsx` renders timeline and tool execution details.

## Manager Agent and tool execution workflow

1. User message enters Week 2 lab.
2. Manager LLM response may include tool calls.
3. Manager executes each tool via `ToolRegistry.executeById(...)`.
4. Tool execution (args, output/error, status, duration) is recorded.
5. Timeline shows the event stream: USER / tool events / manager/system / AGENT response.

## Tool execution types

Execution type is metadata separate from built-in/custom origin:

- **Function**
- **HTTP API**
- **Agent**

Built-in tools currently use:

- `builtin.tax_calculator` → Function
- `builtin.currency_converter` → Function
- `builtin.exchange_rate` → HTTP API

## Built-in tools

- **Tax Calculator** (`builtin.tax_calculator`)
  - input: `amount`, `taxRate`
  - output: `taxAmount`, `total`
- **Currency Converter** (`builtin.currency_converter`)
  - input: `amount`, `fromCurrency`, `toCurrency`, `exchangeRate`
  - output: deterministic local conversion
- **Exchange Rate** (`builtin.exchange_rate`)
  - input: `fromCurrency`, `toCurrency`
  - output: `exchangeRate`, `rateSource`

## Frankfurter HTTP API integration

The exchange-rate tool uses Frankfurter over HTTP via `HttpExchangeRateSource`.

- Endpoint base: `https://api.frankfurter.dev/v1`
- Browser-safe direct request path (no redirect dependency)
- timeout, argument validation, HTTP error, malformed payload, and missing-rate handling

Current limitations of provider integration:

- rate availability depends on Frankfurter-supported currencies/pairs,
- live rates are external and time-varying,
- automated tests mock HTTP and do not depend on live provider uptime.

## Providers and model configuration

- OpenAI and OpenCode connections can be configured in-app.
- Credentials are entered in **Providers** (no required `.env` file).
- Verification and live runs may consume paid tokens.
- App state (including credentials/history) is reset on reload unless explicitly persisted by existing UI behavior.

## Install and run

Requirements:

- Node.js 22.13+
- pnpm 11+

```sh
cd d6
pnpm install --frozen-lockfile --ignore-scripts
pnpm dev
```

Open `http://localhost:5173/`.

## Typecheck, test, build

```sh
pnpm typecheck
pnpm test
pnpm build
```

- Tests use mocked provider/tool HTTP behavior.
- Production bundle output is written to `dist/`.

## Known limitations

- No PostgreSQL/persistence/caching/session features (reserved for later phases).
- Custom tools are cataloged in UI but not executed as dynamic runtime plugins.
- Full manager end-to-end runs require valid provider credentials.

## Future improvements

- richer tool authoring + execution for custom tools,
- retry/backoff strategy for HTTP tools,
- optional persistence for runs and settings,
- expanded built-in tool set and stronger observability.

## Design documentation

See [designs/README.md](designs/README.md) and the linked design assets.
