import type { SessionMetadata } from './session-api';

export async function createAndSelectSession(options: {
  lock: { current: boolean };
  ready: boolean;
  create: () => Promise<SessionMetadata>;
  onCreated: (session: SessionMetadata) => void;
  onPending: (pending: boolean) => void;
  onError: (message: string) => void;
}): Promise<void> {
  if (!options.ready || options.lock.current) return;
  options.lock.current = true;
  options.onPending(true);
  options.onError('');
  try { options.onCreated(await options.create()); }
  catch { options.onError('Could not create session. No local session was added. Please retry.'); }
  finally { options.lock.current = false; options.onPending(false); }
}
