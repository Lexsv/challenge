import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { duplicateExpert } from "./duplicate-expert";
import { createRun, Engine } from "./legacy-engine";
import { type Attempt, type Expert } from "./models";
import { settings } from "./openai-model-compat";
import { respond } from "./openai";
import {
  incompleteExplanation,
  technicalExplanation,
  verdictExplanation,
} from "./result-explanations";
import { ResultBadge } from "./result-badge";
const source: Expert = {
  ...settings(""),
  id: "source",
  name: "Elias Ward",
  roleLabel: "Philosopher",
  description: "Description",
  rolePrompt: "Exact role for Elias Ward.\n**Keep unchanged**",
  reasoning: "high",
  maxTokens: 1024,
};
afterEach(() => vi.unstubAllGlobals());
describe("expert duplication", () => {
  it("copies only definitions independently, inserts after source, and distinguishes repeated names without requests", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const original = structuredClone(source);
    const last = { ...source, id: "last", name: "Last" };
    const first = duplicateExpert([original, last], "source");
    const second = duplicateExpert(first, "source");
    expect(second.map((e) => e.name)).toEqual([
      "Elias Ward",
      "Elias Ward (copy 2)",
      "Elias Ward (copy)",
      "Last",
    ]);
    expect(new Set(second.map((e) => e.id)).size).toBe(4);
    const copy = second[1];
    expect({ ...copy, id: source.id, name: source.name }).toEqual(source);
    expect(copy).not.toBe(original);
    copy.rolePrompt = "Changed";
    copy.reasoning = "low";
    expect(original.rolePrompt).toBe(source.rolePrompt);
    expect(original.reasoning).toBe("high");
    expect(second.filter((e) => e.id !== original.id)).toContain(copy);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("preserves overrides, ignores runtime-only fields, and does not mutate active or historical snapshots", () => {
    const original = {
      ...source,
      model: "gpt-6.1-sol",
      attempts: [{ text: "Do not copy" }],
      usage: { output: 10 },
      status: "running",
    };
    const run = createRun("Q", "R", [original], "gpt-5.6-terra");
    run.busy = true;
    const before = JSON.stringify(run);
    const copies = duplicateExpert([original], source.id);
    expect(copies[1].model).toBe("gpt-6.1-sol");
    expect(copies[1]).not.toHaveProperty("attempts");
    expect(copies[1]).not.toHaveProperty("usage");
    expect(copies[1]).not.toHaveProperty("status");
    copies[1].roleLabel = "New role";
    expect(JSON.stringify(run)).toBe(before);
    expect(createRun("Q", "R", copies, "gpt-5.6-terra").results).toHaveLength(
      2,
    );
  });
});
describe("historical result explanations", () => {
  it.each([
    "max_output_tokens",
    "content_filter",
    "max_messages",
    "steered",
    undefined,
    "unexpected raw payload",
  ])(
    "retains only safe incomplete reason %s through mocked adapter and engine",
    async (reason) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                status: "incomplete",
                incomplete_details: { reason },
                output: [
                  { content: [{ type: "output_text", text: "Partial" }] },
                ],
                usage: {
                  input_tokens: 0,
                  output_tokens: 1024,
                  output_tokens_details: { reasoning_tokens: 100 },
                },
              }),
            ),
        ),
      );
      const run = createRun("Q", "R", [source], "gpt-5.6-terra");
      await new Engine(() => {}, respond).execute(run, "dummy-placeholder");
      const attempt = run.results[0].attempts[0];
      expect(attempt.status).toBe("incomplete");
      expect(attempt.incompleteReason).toBe(
        reason === "unexpected raw payload" ? undefined : reason,
      );
      expect(attempt.text).toBe("Partial");
      expect(attempt.usage?.output).toBe(1024);
      expect(attempt.error).toBe(technicalExplanation(attempt));
      expect(JSON.stringify(attempt)).not.toContain("unexpected raw payload");
      if (!reason || reason === "unexpected raw payload") {
        expect(technicalExplanation(attempt)).toContain(
          "exact reason was not provided",
        );
        expect(technicalExplanation(attempt)).not.toContain("limit");
      }
    },
  );
  it("distinguishes confirmed output limits, restrictions and unknown reasons without usage inference", () => {
    expect(incompleteExplanation("max_output_tokens")).toContain(
      "includes reasoning tokens",
    );
    expect(incompleteExplanation("content_filter")).toContain(
      "content restriction",
    );
    expect(incompleteExplanation("content_filter")).not.toContain(
      "output-token limit",
    );
    expect(
      technicalExplanation({
        id: "old",
        status: "incomplete",
        text: "",
        ms: 1,
        usage: { output: 1024 },
      }),
    ).toContain("exact reason was not provided");
    expect(
      technicalExplanation({
        id: "failed",
        status: "failed",
        error: "Sanitized 401 explanation",
        text: "",
        ms: 1,
      }),
    ).toBe("Sanitized 401 explanation");
    expect(
      technicalExplanation({
        id: "timeout",
        status: "timed-out",
        text: "",
        ms: 1,
      }),
    ).toContain("configured timeout");
  });
  it("uses only the current automated explanation, retaining its language", () => {
    const judgment = {
      resultId: "result",
      verdict: "incorrect" as const,
      explanation: "La respuesta es incorrecta.",
    };
    expect(verdictExplanation("completed", judgment)).toBe(
      judgment.explanation,
    );
    for (const status of [
      "stale",
      "pending",
      "running",
      "failed",
      "skipped",
    ] as const) {
      expect(verdictExplanation(status, judgment)).not.toContain(
        judgment.explanation,
      );
    }
    expect(verdictExplanation("stale", judgment)).toContain("stale");
    expect(verdictExplanation("completed")).toContain(
      "No automated explanation",
    );
  });
  it("makes badges keyboard-focusable and descriptions plain text, with manual attribution", () => {
    const html = renderToStaticMarkup(
      <ResultBadge
        value="incorrect"
        automated
        explanation="<script>unsafe</script>"
      />,
    );
    expect(html).toContain('tabindex="0"');
    expect(html).toContain(
      'title="AI evaluation: Incorrect. &lt;script&gt;unsafe&lt;/script&gt;"',
    );
    expect(html).not.toContain("<script>");
    const manual = renderToStaticMarkup(
      <ResultBadge
        value="correct"
        manual
        explanation="Set manually; separate from AI evaluation."
      />,
    );
    expect(manual).toContain("Manual: Correct");
    expect(manual).toContain("Manual verdict: Correct");
    expect(manual).not.toContain("La respuesta");
  });
});
