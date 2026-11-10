import type { VerificationStatus } from "./connection";
import { VerificationChip, type VerificationKind } from "./verification-chip";

export function ProviderStatus({ verification, provider = "OpenAI", unsaved = false }: { verification: VerificationStatus | VerificationKind; provider?: string; unsaved?: boolean }) {
  const kind: VerificationKind = verification === "unverified" ? "unchecked" : verification;
  return <VerificationChip kind={kind} provider={provider} unsaved={unsaved} />;
}
