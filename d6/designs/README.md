# D6 Design Documentation

This folder contains the visual references used by the D6 implementation.

## UI structure and navigation

- [D6 UI Kit Design System Board](D6%20UI%20Kit%20Design%20System%20Board.png)
- [Experiment Studio Dashboard](Experiment%20Studio%20Dashboard.png)

The app navigation includes Labs, Agents, Tools, and Providers. Labs includes Week 1 and Week 2 views.

## Tools page and execution-type classification

- [AI Agent Tool Setup Modal-1](AI%20Agent%20Tool%20Setup%20Modal-1.png)
- [API Tool Configuration Modal-2](API%20Tool%20Configuration%20Modal-2.png)

Tools UI separates built-in and custom tools. Built-in tools display execution type metadata:

- Function
- HTTP API
- Agent

## Agent configuration

- [Expert Lab Analyst Settings](Expert%20Lab%20Analyst%20Settings.png)
- [Expert Lab Agent Parameters Dashboard](Expert%20Lab%20Agent%20Parameters%20Dashboard.png)

These references cover agent profile editing, model selection, and parameter controls.

## Provider configuration

- [Expert Lab Provider Dashboard](Expert%20Lab%20Provider%20Dashboard.png)

Provider settings include credentials, verification, model options, and provider-specific controls.

## Lab Timeline and tool execution visualization

Week 2 Agent Tool Lab timeline shows:

- user/assistant/system events,
- manager run lifecycle events,
- tool execution events with status, duration, arguments, and result.

Tool events use execution-type visual classification while preserving status indicators.

## Gallery

- [D6 UI Kit Design System Board](D6%20UI%20Kit%20Design%20System%20Board.png)
- [Experiment Studio Dashboard](Experiment%20Studio%20Dashboard.png)
- [Expert Lab Analyst Settings](Expert%20Lab%20Analyst%20Settings.png)
- [Expert Lab Agent Parameters Dashboard](Expert%20Lab%20Agent%20Parameters%20Dashboard.png)
- [Expert Lab Provider Dashboard](Expert%20Lab%20Provider%20Dashboard.png)
- [AI Agent Tool Setup Modal-1](AI%20Agent%20Tool%20Setup%20Modal-1.png)
- [API Tool Configuration Modal-2](API%20Tool%20Configuration%20Modal-2.png)

## Main architectural decisions represented

- Shared Tool Registry used by the Manager Agent and Timeline.
- Manager Agent orchestrates tool calls; tools perform deterministic execution.
- Exchange-rate retrieval is an HTTP built-in tool using Frankfurter.
- Execution type metadata is separate from built-in/custom origin.
