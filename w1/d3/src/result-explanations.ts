import type { Attempt, IncompleteReason, Judgment, Run } from "./models";

export function incompleteExplanation(reason?: IncompleteReason): string {
  switch (reason) {
    case "max_output_tokens":
      return "The response was incomplete because it reached the output-token limit. This limit includes reasoning tokens when applicable.";
    case "content_filter":
      return "The response was incomplete because a content restriction stopped generation.";
    case "max_messages":
      return "The response was incomplete because it reached the API message limit.";
    case "steered":
      return "The response was incomplete because API steering stopped it at a safe output boundary.";
    default:
      return "The response was incomplete; the exact reason was not provided.";
  }
}
export function technicalExplanation(attempt?: Attempt): string {
  switch (attempt?.status) {
    case "incomplete":
      return incompleteExplanation(attempt.incompleteReason);
    case "failed":
      return (
        attempt.error ||
        "The request failed. No further error details were recorded."
      );
    case "timed-out":
      return "The request exceeded the configured timeout. A request already sent may still be billable.";
    case "running":
      return "The participant request is in progress; answer correctness has not been determined.";
    case "succeeded":
      return "The answer was received successfully. This does not establish that it is correct.";
    default:
      return "The participant request has not started.";
  }
}
export function verdictExplanation(
  status: Run["evaluationStatus"],
  judgment?: Judgment,
): string {
  if (status === "completed")
    return judgment?.explanation?.trim()
      ? judgment.explanation
      : "No automated explanation is available for this answer.";
  if (status === "stale")
    return "Previous AI evaluations are stale while a participant retry is pending; no current AI verdict is shown.";
  if (status === "running")
    return "AI evaluation is in progress. Previous verdicts are not current.";
  if (status === "pending")
    return "AI evaluation has not completed; no current AI verdict is available.";
  if (status === "failed")
    return "AI evaluation failed. No current AI verdict is available; answers are preserved.";
  return "AI evaluation was skipped because no participant produced a complete answer.";
}
