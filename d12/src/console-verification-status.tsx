import { CredentialIndicator, credentialStatusFromText } from "./credential-indicator";
import { type VerificationKind } from "./verification-chip";

export function consoleStatusKind(status: string): VerificationKind {
  if (status === "Verified") return "verified";
  if (status === "Not authorized") return "failed";
  if (status === "Checking…") return "verifying";
  if (status.includes("Retry")) return "inconclusive";
  if (status.startsWith("Authentication verified for this operation.") && status.includes("Model verified:")) return "verified";
  if (status.startsWith("Authentication failed") || status.includes("denied (403)") || status.includes("rejected (")) return "failed";
  if (status.startsWith("Verifying")) return "verifying";
  if (status.includes("inconclusive")) return "inconclusive";
  return "unchecked";
}

export function ConsoleVerificationStatus({ status, unsaved = false }: { status: string; unsaved?: boolean }) {
  return <CredentialIndicator status={credentialStatusFromText(status)} unsaved={unsaved} />;
}
