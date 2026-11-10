import { CredentialIndicator } from './credential-indicator';

export type VerificationKind = 'verified' | 'failed' | 'inconclusive' | 'unchecked' | 'verifying';
export const verificationLabel = (kind: VerificationKind) => kind === 'verified' ? 'Verified' : kind === 'verifying' ? 'Checking…' : 'Not verified';
export function VerificationChip({ kind, provider, unsaved = false }: { kind: VerificationKind; provider?: string; unsaved?: boolean }) {
  return <CredentialIndicator provider={provider} unsaved={unsaved} status={{
    saved: kind !== 'unchecked',
    verification: kind === 'verified' ? 'verified' : kind === 'verifying' ? 'checking' : kind === 'failed' || kind === 'inconclusive' ? 'retryable' : 'unchecked',
  }} />;
}
