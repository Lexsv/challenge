import { describe, expect, it } from "vitest";
import { selectServerGrants } from "./scheduler-server-selector";
import type { ToolChoice } from "./scheduler-api";

function tool(
  connectionId: string,
  toolId: string,
  eligible = true,
): ToolChoice {
  return {
    connectionId,
    toolId,
    eligible,
    name: "lookup",
    server: connectionId,
    revision: 1,
    definition: toolId,
  };
}
const catalog = [
  tool("a", "one"),
  tool("a", "two"),
  tool("b", "three"),
  tool("b", "four", false),
];
const saved = [{ connectionId: "a", toolId: "one" }];
describe("Scheduler MCP server selection", () => {
  it("takes a fixed snapshot of eligible tools on selection and revokes only removed servers", () => {
    const both = selectServerGrants([], ["a", "b"], catalog);
    expect(both.map((p) => p.toolId)).toEqual(["one", "two", "three"]);
    expect(selectServerGrants(both, ["b"], catalog)).toEqual([
      { connectionId: "b", toolId: "three" },
    ]);
    expect(selectServerGrants(both, [], catalog)).toEqual([]);
  });
  it("keeps partial legacy grants on edit and select all, even after discovery", () => {
    const refreshed = [...catalog, tool("a", "five")];
    expect(selectServerGrants(saved, ["a"], refreshed)).toEqual(saved);
    expect(selectServerGrants(saved, ["b", "a"], refreshed)).toEqual([
      ...saved,
      { connectionId: "b", toolId: "three" },
    ]);
    expect(
      selectServerGrants([], ["a"], refreshed).map((p) => p.toolId),
    ).toEqual(["one", "two", "five"]);
  });
});
