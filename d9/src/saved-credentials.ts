export type SavedProvider = 'openai' | 'opencode-console' | 'opencode-go';
export type SavedCredentialStatus = {
  saved: boolean;
  presencePending?: boolean;
  verification: 'unchecked' | 'checking' | 'verified' | 'not-authorized' | 'retryable';
  reason?: string;
  removalFailed?: boolean;
};
export const savedProviders: SavedProvider[] = ['openai', 'opencode-console', 'opencode-go'];
export const credentialLabel = (status?: SavedCredentialStatus) =>
  status?.verification === 'checking' ? 'Checking…' : status?.verification === 'verified' ? 'Verified'
    : status?.verification === 'not-authorized' ? 'Not authorized'
    : status?.verification === 'retryable' ? status.reason === 'rate-limit' ? 'Rate limited — Retry'
      : status.reason === 'timeout' ? 'Check timed out — Retry' : status.reason === 'removal-failed' ? 'Could not forget key — Retry' : 'Check unavailable — Retry'
    : 'Not verified';
export async function credentialRequest(provider: SavedProvider, action = '', init?: RequestInit): Promise<SavedCredentialStatus> {
  const response = await fetch(`/api/credentials/${provider}${action}`, init);
  if (!response.ok) throw new Error(`Local credential operation failed (${response.status}).`);
  return response.json();
}
export function credentialPost(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

// Stores only public status. Generation checks also protect the UI from stale responses after Forget.
export class CredentialController {
  private state: Partial<Record<SavedProvider, SavedCredentialStatus>> = {};
  private listeners = new Set<() => void>();
  private revisions: Partial<Record<SavedProvider, number>> = {};
  private started = false;
  private clock = 0;
  private readonly clientId = crypto.randomUUID();
  constructor(private request = credentialRequest, private forgetAllRequest = async (init: RequestInit) => {
    const response = await fetch('/api/credentials', { ...init, method: 'DELETE' });
    if (!response.ok) throw new Error('Could not forget keys.');
    return response.json() as Promise<{ results: Record<SavedProvider, SavedCredentialStatus>; failed: string[] }>;
  }) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private set(provider: SavedProvider, status: SavedCredentialStatus) { this.state = { ...this.state, [provider]: status }; this.listeners.forEach((listener) => listener()); }
  private next(provider: SavedProvider) { return this.revisions[provider] = ++this.clock; }
  start() {
    if (this.started) return;
    this.started = true;
    for (const provider of savedProviders) void this.checkSaved(provider);
  }
  private async checkSaved(provider: SavedProvider) {
    const revision = this.next(provider);
    this.set(provider, { saved: false, verification: 'unchecked', presencePending: true });
    try {
      const presence = await this.request(provider);
      if (this.revisions[provider] !== revision) return;
      if (!presence.saved) {
        this.set(provider, { saved: false, verification: 'unchecked' });
        return;
      }
      this.set(provider, { saved: true, verification: 'unchecked' });
      await this.verify(provider);
    } catch {
      if (this.revisions[provider] === revision) this.set(provider, { saved: false, verification: 'retryable', reason: 'network-or-store' });
    }
  }
  async verify(provider: SavedProvider, key?: string) {
    const revision = this.next(provider);
    this.set(provider, { saved: this.state[provider]?.saved ?? false, verification: 'checking' });
    let result: SavedCredentialStatus;
    try { result = await this.request(provider, '/verify', credentialPost({ ...(key === undefined ? {} : { key }), clientId: this.clientId, revision })); }
    catch { result = { saved: this.state[provider]?.saved ?? false, verification: 'retryable', reason: 'network-or-store' }; }
    if (this.revisions[provider] === revision) this.set(provider, result);
    return this.revisions[provider] === revision ? result : undefined;
  }
  async forget(provider: SavedProvider) {
    const revision = this.next(provider);
    this.set(provider, { saved: this.state[provider]?.saved ?? false, verification: 'unchecked' });
    let result: SavedCredentialStatus;
    try { result = await this.request(provider, '', { method: 'DELETE', headers: { 'X-Credential-Client': this.clientId, 'X-Credential-Revision': String(revision) } }); }
    catch { result = { saved: this.state[provider]?.saved ?? true, verification: 'retryable', reason: 'removal-failed', removalFailed: true }; }
    if (this.revisions[provider] === revision) this.set(provider, result);
    return result;
  }
  async forgetAll() {
    const revisions = Object.fromEntries(savedProviders.map((provider) => [provider, this.next(provider)]));
    for (const provider of savedProviders) this.set(provider, { saved: this.state[provider]?.saved ?? false, verification: 'unchecked' });
    let results: Record<SavedProvider, SavedCredentialStatus>;
    try { results = (await this.forgetAllRequest({ headers: { 'X-Credential-Client': this.clientId, 'X-Credential-Revision': String(this.clock) } })).results; }
    catch { results = Object.fromEntries(savedProviders.map((provider) => [provider, { saved: this.state[provider]?.saved ?? true, verification: 'retryable', reason: 'removal-failed', removalFailed: true }])) as Record<SavedProvider, SavedCredentialStatus>; }
    for (const provider of savedProviders) if (this.revisions[provider] === revisions[provider]) this.set(provider, results[provider]);
    return savedProviders.filter((provider) => results[provider].removalFailed);
  }
}
export const credentials = new CredentialController();
