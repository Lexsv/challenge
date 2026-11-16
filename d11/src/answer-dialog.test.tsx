import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { classifyAnswer, FormattedAnswer } from "./answer-dialog";
import { tableFixtureRuns } from "./result-table-fixture";
import { RunView } from "./results";
describe("answer preview formats", () => {
  it("formats JSON objects and arrays before considering Markdown", () => {
    for (const text of [
      '{"value":0,"nested":{"items":[true,"**literal**"]}}',
      '[1,2,{"x":false}]',
    ]) {
      const result = classifyAnswer(text);
      expect(result.kind).toBe("json");
      expect(JSON.parse(result.formatted)).toEqual(JSON.parse(text));
      const html = renderToStaticMarkup(<FormattedAnswer text={text} />);
      expect(html).toContain("Formatted JSON answer");
      expect(html).toContain("<span");
    }
  });
  it("renders formatted Markdown securely and preserves plain-text whitespace", () => {
    const md =
      "# Title\n\n**bold**\n\n- Item\n\n<script>alert(1)</script>\n\n[bad](javascript:alert(1))";
    expect(classifyAnswer(md).kind).toBe("markdown");
    const html = renderToStaticMarkup(<FormattedAnswer text={md} />);
    expect(html).toContain("<strong>bold</strong>");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain('href="javascript:');
    const plain = "One line\n  Second line";
    expect(classifyAnswer(plain).kind).toBe("plain");
    expect(renderToStaticMarkup(<FormattedAnswer text={plain} />)).toContain(
      plain,
    );
  });
  it("keeps the full report cell keyboard accessible and response separate", () => {
    const run = tableFixtureRuns()[0];
    const html = renderToStaticMarkup(
      <RunView
        run={run}
        disabled={false}
        refresh={() => {}}
        retry={() => {}}
        retryEvaluation={() => {}}
      />,
    );
    expect(html).toMatch(
      /role="button"[^>]*tabindex="0"[^>]*aria-label="View result for/,
    );
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain("UnbrokenAnswer".repeat(60));
  });
});
