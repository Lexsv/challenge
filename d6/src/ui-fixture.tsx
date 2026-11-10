// Separate manual UI-test entry, excluded from the production application's import graph.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ResultTableFixture } from "./result-table-fixture";
import { App } from "./main";
import type { Adapter } from "./openai";
import { ConnectionController } from "./connection";
const parameters = new URLSearchParams(window.location.search);
const controller = new ConnectionController(
  parameters.get("storage") === "blocked"
    ? () => {
        throw new Error("Synthetic storage failure");
      }
    : undefined,
);
const markdownAnswer = [
  "# Synthetic report",
  "**Bold answer** with *emphasis*, [safe link](https://example.com/docs), [unsafe link](javascript:alert(1)), and inline `const x = 1`.",
  "## Summary",
  "- First item\n- Second item",
  "1. Check the data\n2. Compare the result",
  "> A quoted synthetic observation.",
  "| Item | Value | Wide column |\n| --- | ---: | --- |\n| Alpha | 0 | " +
    "WideTableValue".repeat(20) +
    " |",
  '```javascript\nconst longExample = "' +
    "LongCodeValue".repeat(60) +
    '";\n```',
  '<script>alert("must not run")</script>',
  '<img src="https://example.invalid/pixel" onerror="alert(1)">',
  "[blocked data](data:text/html,blocked)",
].join("\n\n");
let incompleteShown = false;
let failed = false;
let evaluationFailed = false;
const adapter: Adapter = async (_key, request) => {
  await new Promise((resolve) => setTimeout(resolve, 1800));
  const base = {
    status: "succeeded" as const,
    ms: 1800,
    usage: { input: 12, output: 24 },
  };
  if (
    request.input === "Connection verification." &&
    parameters.get("verification") === "failed"
  )
    return {
      status: "failed",
      text: "",
      error: "Synthetic connection failure (401). Check settings.",
      ms: 1800,
    };
  if (request.instructions.includes("Architect"))
    return {
      ...base,
      text: JSON.stringify({
        experts: Array.from(
          { length: request.instructions.includes("exactly one") ? 1 : 4 },
          (_, i) => ({
            name: ["Mathematician", "Scientist", "Clown", "Analyst"][i],
            roleLabel: [
              "Abstract thinker",
              "Researcher",
              "Comedian",
              "Everyday Person",
            ][i],
            description: "A synthetic expert for responsive UI validation.",
            rolePrompt:
              parameters.get("answers") === "markdown" && i === 0
                ? "Test role 0\nKeep this captured prompt readable as text, including **literal syntax**.\n" +
                  "LongCapturedPrompt".repeat(100)
                : `Test role ${i}`,
          }),
        ),
      }),
    };
  if (request.schema) {
    if (parameters.get("evaluation") === "failed" && !evaluationFailed) {
      evaluationFailed = true;
      return {
        status: "failed",
        text: "",
        error: "Synthetic evaluation failure. Answers are preserved.",
        ms: 1800,
      };
    }
    const input = JSON.parse(request.input);
    return {
      ...base,
      text: JSON.stringify({
        evaluations: input.answers.map((a: { resultId: string }) => ({
          resultId: a.resultId,
          verdict: "correct",
          explanation: "Synthetic UI evaluation, not experiment data.",
        })),
      }),
    };
  }
  if (
    parameters.get("answers") === "markdown" &&
    request.instructions.startsWith("Test role 0")
  )
    return {
      ...base,
      actualModel: request.settings.model,
      text: markdownAnswer,
      usage: { input: 0, output: 0, reasoning: 0 },
      ms: 0,
    };
  if (
    parameters.get("answers") === "markdown" &&
    request.instructions === "Test role 2"
  )
    return {
      status: "succeeded",
      text: "A plain-text answer.\nA second readable line.",
      ms: 1800,
    };
  if (
    parameters.get("answers") === "markdown" &&
    request.instructions === "Test role 3" &&
    !incompleteShown
  ) {
    incompleteShown = true;
    return {
      status: "incomplete",
      text: "",
      error: "Synthetic incomplete response with no answer.",
      ms: 1800,
    };
  }
  if (request.instructions === "Test role 1" && !failed) {
    failed = true;
    return {
      status: "failed",
      text: "",
      error: "Synthetic request failure — retry this participant.",
      ms: 1800,
    };
  }
  const text =
    parameters.get("answers") === "long"
      ? request.instructions === "Test role 2"
        ? "Short synthetic answer."
        : `Synthetic answer for: ${request.input}\n` +
          Array.from(
            { length: 20 },
            (_, index) =>
              `Line ${index + 1}: synthetic answer details for UI testing.`,
          ).join("\n") +
          "\n" +
          "LongUnbrokenAnswer".repeat(150)
      : "Synthetic response for UI validation only. No live model was called.";
  return { ...base, text };
};
function Fixture() {
  const [requestCount, setRequestCount] = useState(0);
  const [requestModels, setRequestModels] = useState<string[]>([]);
  const countedAdapter: Adapter = (key, request) => {
    setRequestCount((n) => n + 1);
    const operation = request.instructions.includes("Architect")
      ? "Architect"
      : request.schema
        ? "Evaluation"
        : request.input === "Connection verification."
          ? "Verification"
          : "Participant";
    setRequestModels((models) => [
      ...models,
      `${operation}: ${request.settings.model}`,
    ]);
    return adapter(key, request);
  };
  return (
    <>
      <p>Test requests: {requestCount}</p>
      <p>Mock request models: {requestModels.join(" | ") || "None"}</p>
      <App adapter={countedAdapter} controller={controller} />
    </>
  );
}
createRoot(document.getElementById("root")!).render(
  parameters.get("tables") === "true" ? <ResultTableFixture /> : <Fixture />,
);
