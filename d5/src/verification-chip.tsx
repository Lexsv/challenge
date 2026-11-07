import { Chip } from "@mui/material";

export type VerificationKind = "verified" | "failed" | "inconclusive" | "unchecked" | "verifying";
export const verificationLabel = (kind: VerificationKind) => kind === "verified" ? "Verified" : kind === "failed" ? "Verification failed" : kind === "verifying" ? "Verifying" : kind === "inconclusive" ? "Verification inconclusive" : "Not verified";
export function VerificationChip({ kind, provider, unsaved = false }: { kind: VerificationKind; provider?: string; unsaved?: boolean }) {
  const label = verificationLabel(kind);
  return <Chip size="small" role="status" aria-label={provider ? `${provider}: ${label}${unsaved ? " (unsaved)" : ""}` : undefined}
    label={`${provider ? `${provider} · ` : ""}${label}${unsaved ? " (unsaved)" : ""}`}
    color={kind === "verified" ? "success" : kind === "failed" ? "error" : "default"}
    variant={kind === "verified" || kind === "failed" ? "filled" : "outlined"}
    sx={{ maxWidth: "100%", "& .MuiChip-label": { overflowWrap: "anywhere" } }} />;
}
