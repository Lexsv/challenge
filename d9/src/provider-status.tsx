import { CredentialIndicator } from './credential-indicator';
import type { SavedCredentialStatus } from './saved-credentials';
import type { VerificationStatus } from './connection';
import { VerificationChip, type VerificationKind } from './verification-chip';

export function ProviderStatus({ verification, provider = 'OpenAI', unsaved = false, savedStatus }: { verification: VerificationStatus | VerificationKind; provider?: string; unsaved?: boolean; savedStatus?: SavedCredentialStatus }) {
  if (savedStatus) return <CredentialIndicator status={savedStatus} provider={provider} unsaved={unsaved} />;
  const kind: VerificationKind = verification === 'unverified' ? 'unchecked' : verification;
  return <VerificationChip kind={kind} provider={provider} unsaved={unsaved} />;
}
