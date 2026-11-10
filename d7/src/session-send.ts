import { isWeek2Provider, unsupportedWeek2ProviderMessage } from './week2-provider';
export type SendLock = { current: boolean };

// One acceptance boundary per mounted session. Validation leaves its draft untouched.
export async function submitSession(options: {
  lock: SendLock;
  draft: string;
  ready: boolean;
  model: string;
  provider?: string;
  hasCredential: boolean;
  onBlocked: (message: string) => void;
  onAccepted: () => void;
  run: (question: string) => Promise<void>;
  onSettled: () => void;
}): Promise<boolean> {
  const question = options.draft.trim();
  if (options.lock.current || !options.ready || !question) return false;
  const problem = options.provider !== undefined && !isWeek2Provider(options.provider) ? unsupportedWeek2ProviderMessage
    : !options.model ? 'Select a model for the Manager Agent.'
    : !options.hasCredential ? 'No credentials found for this provider. Configure it in Providers.' : '';
  if (problem) { options.onBlocked(problem); return false; }
  options.lock.current = true;
  try {
    options.onAccepted();
    await options.run(question);
    return true;
  } finally {
    options.lock.current = false;
    options.onSettled();
  }
}
