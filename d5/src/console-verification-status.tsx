import { Stack, Typography } from "@mui/material";
import { VerificationChip, type VerificationKind } from "./verification-chip";

export function consoleStatusKind(status: string): VerificationKind {
  if (status.startsWith("Authentication verified for this operation.") && status.includes("Model verified:")) return "verified";
  if (status.startsWith("Authentication failed") || status.includes("denied (403)") || status.includes("rejected (")) return "failed";
  if (status.startsWith("Verifying")) return "verifying";
  if (status.includes("inconclusive")) return "inconclusive";
  return "unchecked";
}

export function ConsoleVerificationStatus({ status, unsaved = false }: { status: string; unsaved?: boolean }) {
  const kind = consoleStatusKind(status);
  return <Stack spacing={0.5} alignItems="flex-start" role="status">
    <VerificationChip kind={kind} unsaved={unsaved} />
    <Typography variant="body2" sx={{ overflowWrap: "anywhere" }}>{status}</Typography>
  </Stack>;
}
