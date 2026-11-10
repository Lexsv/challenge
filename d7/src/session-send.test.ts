import { expect, it } from 'vitest';
import { submitSession } from './session-send';
import { ManagerAgent, createManagerConversation } from './manager-agent';
import { createBuiltInToolRegistry } from './tool-runtime';

it('shows the accepted message and clears only its composer before a delayed run finishes; blocks duplicates', async () => {
  const state = createManagerConversation();
  const otherDraft = 'Other session draft';
  let draft = 'Calculate tax';
  let running = false;
  let complete!: (value: { text: string }) => void;
  const response = new Promise<{ text: string }>((resolve) => { complete = resolve; });
  const manager = new ManagerAgent({ complete: () => response }, createBuiltInToolRegistry());
  const lock = { current: false };
  const options = {
    lock, draft, ready: true, model: 'test-model', hasCredential: true,
    onBlocked: () => { throw new Error('Unexpected validation error'); },
    onAccepted: () => { draft = ''; running = true; },
    onSettled: () => { running = false; },
    run: async (question: string) => { await manager.run({ state, userText: question }); },
  };
  const pending = submitSession(options);
  expect(draft).toBe('');
  expect(state.messages[0].text).toBe('Calculate tax');
  expect(running).toBe(true);
  expect(otherDraft).toBe('Other session draft');
  expect(await submitSession(options)).toBe(false);
  expect(state.messages).toHaveLength(1);
  complete({ text: 'Done' });
  expect(await pending).toBe(true);
  expect(running).toBe(false);
  expect(lock.current).toBe(false);
});

it('preserves the draft and existing error when credential validation blocks sending', async () => {
  let draft = 'Keep this draft';
  let error = '';
  const accepted = await submitSession({
    lock: { current: false }, draft, ready: true, model: 'test-model', hasCredential: false,
    onBlocked: (message) => { error = message; }, onAccepted: () => { draft = ''; },
    onSettled: () => { throw new Error('Should not settle an unaccepted send'); },
    run: async () => { throw new Error('Should not send'); },
  });
  expect(accepted).toBe(false);
  expect(draft).toBe('Keep this draft');
  expect(error).toBe('No credentials found for this provider. Configure it in Providers.');
});

it('restores send feedback and unlocks after a failure', async () => {
  const lock = { current: false };
  let running = false;
  await expect(submitSession({ lock, draft: 'Hello', ready: true, model: 'test-model', hasCredential: true,
    onBlocked: () => {}, onAccepted: () => { running = true; }, onSettled: () => { running = false; },
    run: async () => { throw new Error('offline'); },
  })).rejects.toThrow('offline');
  expect(running).toBe(false);
  expect(lock.current).toBe(false);
});
