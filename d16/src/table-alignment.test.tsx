import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { centeredTable } from "./table-alignment";
import { RunView } from "./results";
import { tableFixtureRuns } from "./result-table-fixture";

describe("shared data table alignment", () => {
  it("centers headers, cells and editable cell content", () => {
    expect(centeredTable["&& th, && td"]).toEqual({ textAlign: "center", verticalAlign: "middle" });
    expect(centeredTable["&& .MuiInputBase-input"].textAlign).toBe("center");
    const html = renderToStaticMarkup(<RunView run={tableFixtureRuns()[0]} disabled refresh={() => {}} retry={() => {}} retryEvaluation={() => {}} />);
    expect(html).toContain("text-align:center");
    expect(html).toContain("vertical-align:middle");
    expect(html).toContain("Technical status");
  });
});
