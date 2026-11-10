import { Box, Chip, CircularProgress, Tooltip } from '@mui/material';
import type { SavedCredentialStatus } from './saved-credentials';

export function credentialExplanation(status: SavedCredentialStatus): string {
  if (status.presencePending) return 'Checking for a saved key in Providers.';
  if (status.verification === 'checking') return 'Checking provider credentials.';
  if (status.verification === 'verified') return 'Provider credentials verified.';
  if (status.verification === 'not-authorized') return 'The provider rejected the credentials. Check the key in Providers.';
  if (status.removalFailed) return 'Key removal could not be confirmed. Retry Forget key in Providers.';
  if (status.verification === 'retryable') {
    if (status.reason === 'rate-limit') return 'The provider rate limit was reached. Retry Verify in Providers.';
    if (status.reason === 'timeout') return 'The check timed out. Retry Verify in Providers.';
    if (status.reason === 'permission') return 'The check was inconclusive. Check permissions and retry Verify in Providers.';
    return 'The check could not be completed. Retry Verify in Providers.';
  }
  return status.saved ? 'Credentials have not been checked. Use Verify in Providers.' : 'No key is saved. Add a key in Providers and select Verify.';
}

// Legacy messages are classified into canned explanations; never expose arbitrary provider text.
export function credentialStatusFromText(text: string, saved = false): SavedCredentialStatus {
  if (text === 'Verified' || (text.startsWith('Authentication verified for this operation.') && text.includes('Model verified:'))) return { saved, verification: 'verified' };
  if (text === 'Checking…' || text.startsWith('Verifying')) return { saved, verification: 'checking' };
  if (text === 'Not authorized' || text.startsWith('Authentication failed (401)')) return { saved, verification: 'not-authorized' };
  if (text === 'Not verified' || text.startsWith('Authentication: not checked')) return { saved, verification: 'unchecked' };
  return { saved, verification: 'retryable', reason: /rate.limit|429/i.test(text) ? 'rate-limit' : /timed.out|timeout/i.test(text) ? 'timeout' : /403|permission/i.test(text) ? 'permission' : 'network-or-store' };
}

export function CredentialIndicator({ status, provider, showProvider = !!provider, unsaved = false }: {
  status: SavedCredentialStatus;
  provider?: string;
  showProvider?: boolean;
  unsaved?: boolean;
}) {
  const checking = status.verification === 'checking';
  const label = checking ? 'Checking…' : status.verification === 'verified' ? 'Verified' : status.verification === 'not-authorized' ? 'Not authorized' : 'Not verified';
  const explanation = `${credentialExplanation(status)}${unsaved ? ' Provider settings have unsaved changes.' : ''}`;
  return <Tooltip title={explanation} describeChild arrow>
    <Box component="span" tabIndex={0} role="status" aria-live="polite" aria-label={`${provider ? `${provider}: ` : ''}${label}`}
      sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75, borderRadius: 1, '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: 2 } }}>
      {checking ? <>
        {showProvider && provider && <Box component="span" sx={{ fontSize: '0.8125rem' }}>{provider}</Box>}
        <CircularProgress size={16} aria-label={`Checking ${provider ? `${provider} ` : ''}credentials`} />
      </> : <Chip size="small" label={`${showProvider && provider ? `${provider} · ` : ''}${label}`}
        color={status.verification === 'not-authorized' ? 'error' : status.verification === 'verified' ? 'success' : 'default'}
        variant={status.verification === 'verified' || status.verification === 'not-authorized' ? 'filled' : 'outlined'} />}
    </Box>
  </Tooltip>;
}
