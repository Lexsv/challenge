import { mcpResultEvidence } from "../src/mcp-result-evidence.ts";

// Read the current run's acknowledged outcomes. Never dispatch or replay here.
export function mcpRunSummary(operations) {
  const tools = operations.filter((op) => op.kind === "tool");
  if (
    !tools.some((op) => JSON.parse(op.display ?? "{}")?.type === "MCP") ||
    operations.some(
      (op) =>
        !["Success", "Failed", "Skipped", "Unknown", "Cancelled"].includes(
          op.state,
        ),
    )
  )
    return;
  const counts = new Map();
  const links = new Set();
  let created = false;
  for (const op of tools) {
    const display = JSON.parse(op.display ?? "{}") ?? {};
    const label =
      [display.server, display.name].filter(Boolean).join(" / ") || "Tool";
    const diagnostic = JSON.parse(op.error ?? "null")?.diagnostic;
    const result = JSON.parse(op.result ?? "null");
    const warning = result?.compatibilityWarning?.code === "unsupported_content" ? " · Unsupported content omitted." : "";
    const key = label + " — " + op.state + warning + (diagnostic ? " · " + diagnostic : "");
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (display.type === "MCP" && op.state === "Success") {
      const evidence = mcpResultEvidence(result);
      created ||= evidence.created;
      for (const url of evidence.links) links.add(url);
    }
  }
  return [
    "Recorded tool outcomes:",
    ...Array.from(counts, ([label, n]) => label + (n > 1 ? " × " + n : "")),
    ...(created ? ["The service confirmed artifact creation."] : []),
    ...links,
    ...(!links.size && tools.some((op) => op.state === "Success")
      ? [
          "No artifact URL was returned. Inspect the connected document or service to see the result.",
        ]
      : []),
    ...(tools.some(op => op.state === "Unknown" || JSON.parse(op.error ?? "null")?.certainty === "unknown")
      ? [
          "Check the service before repeating an operation with an unknown outcome.",
        ]
      : []),
  ].join("\n");
}
