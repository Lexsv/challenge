// Synthetic presentation fixtures only; no API requests or credentials.
import { Container, CssBaseline, Stack, ThemeProvider } from "@mui/material";
import { createRun } from "./legacy-engine";
import { type Run, type Verdict } from "./models";
import { settings } from "./openai-model-compat";
import { RunView } from "./results";
import { theme } from "./theme";

export function tableFixtureRuns(): Run[] {
  const makeRun = (count: number) =>
    createRun(
      "Captured question",
      "Captured reference",
      Array.from({ length: count }, (_, i) => ({
        ...settings(""),
        id: `expert-${i}`,
        name: i === 0 ? "LongExpertName".repeat(8) : `Expert ${i + 1}`,
        roleLabel: i === 0 ? "Interdisciplinary thinker" : "Reviewer",
        description: "Synthetic",
        rolePrompt: "Synthetic role",
      })),
      "gpt-5.6-terra",
    );
  const run = makeRun(8);
  const statuses = [
    "succeeded",
    "succeeded",
    "succeeded",
    "failed",
    "incomplete",
    "timed-out",
    "running",
    "pending",
  ] as const;
  run.results.forEach((result, i) => {
    if (statuses[i] === "pending") return;
    result.attempts.push({
      id: `attempt-${i}`,
      status: statuses[i],
      ...(i === 4 ? { incompleteReason: "max_output_tokens" as const } : {}),
      ...(i === 3
        ? {
            error: "Synthetic sanitized failure. Check model access and retry.",
          }
        : {}),
      text:
        i === 0
          ? "Long answer line.\n".repeat(40) + "UnbrokenAnswer".repeat(60)
          : i === 2
            ? "Responsive answer ".repeat(11)
            : i < 3
              ? "Short answer."
              : "",
      actualModel: i === 0 ? "long-model-id-".repeat(12) : "gpt-5.6-terra",
      ms: 1234,
      usage:
        i < 3
          ? { input: i === 0 ? 123456789 : 0, output: i === 0 ? 987654321 : 12 }
          : undefined,
      ...(i === 1 ? { manual: "correct" as const } : {}),
    });
  });
  run.evaluationStatus = "completed";
  run.evaluations.push({
    id: "evaluation",
    status: "succeeded",
    text: "",
    ms: 10,
    judgments: run.results.slice(0, 3).map((r, i) => ({
      resultId: r.id,
      verdict: (["correct", "incorrect", "unable_to_assess"] as Verdict[])[i],
      explanation:
        i === 1
          ? "La respuesta contradice la referencia. " +
            "Detailed synthetic explanation. ".repeat(20)
          : "Synthetic AI assessment",
    })),
  });
  const stale = structuredClone(run);
  stale.id += "-stale";
  stale.evaluationStatus = "stale";
  stale.busy = true;
  const single = makeRun(1);
  single.results[0].attempts.push({
    id: "single-attempt",
    status: "succeeded",
    text: "Short answer.",
    ms: 0,
    usage: { input: 0, output: 0 },
  });
  single.evaluationStatus = "pending";
  return [run, stale, single];
}
export function ResultTableFixture() {
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Container maxWidth="xl" sx={{ py: 3 }}>
        <Stack spacing={3}>
          {tableFixtureRuns().map((run) => (
            <RunView
              key={run.id}
              run={run}
              disabled
              refresh={() => {}}
              retry={() => {}}
              retryEvaluation={() => {}}
            />
          ))}
        </Stack>
      </Container>
    </ThemeProvider>
  );
}
