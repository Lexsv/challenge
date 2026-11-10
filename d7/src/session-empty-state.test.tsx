import { expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { EmptySessionChat, SessionCreateButton } from './session-empty-state';
import { createAndSelectSession } from './session-creation';
import type { SessionMetadata } from './session-api';

it('shows the action only for a successfully loaded, empty session list', () => {
  const props = { onCreate: () => {}, pending: false, disabled: false };
  const empty = renderToStaticMarkup(<EmptySessionChat {...props} showEmptyState />);
  expect(empty).toContain('No sessions yet.');
  expect(empty).toContain('Start a new session');
  // The parent passes false while loading, after load failure, or once any session exists.
  const hidden = renderToStaticMarkup(<EmptySessionChat {...props} showEmptyState={false} />);
  expect(hidden).not.toContain('Start a new session');
  expect(hidden).not.toContain('No sessions yet.');
});

it.each([true, false])('creates and selects through either entry point (compact=%s) only after persistence succeeds', async (compact) => {
  const saved: SessionMetadata = { id: 'created-session', title: 'New session', createdAt: 123 };
  let finish!: (session: SessionMetadata) => void;
  const response = new Promise<SessionMetadata>((resolve) => { finish = resolve; });
  const create = vi.fn(() => response);
  const lock = { current: false };
  let pending = false;
  let selected: string | null = null;
  let rows: SessionMetadata[] = [];
  const action = () => createAndSelectSession({ lock, ready: true, create,
    onCreated: (session) => { rows = [...rows, session]; selected = session.id; },
    onPending: (value) => { pending = value; }, onError: () => {},
  });
  const element = SessionCreateButton({ compact, onCreate: action, pending: false, disabled: false });
  const request = element.props.onClick();
  expect(create).toHaveBeenCalledTimes(1);
  expect(pending).toBe(true);
  expect(rows).toEqual([]);
  expect(selected).toBe(null);
  // Both controls reflect the same pending state and share the same duplicate-send lock.
  for (const entry of [true, false]) {
    const control = SessionCreateButton({ compact: entry, onCreate: action, pending, disabled: false });
    expect(control.props.disabled).toBe(true);
    expect(control.props['aria-busy']).toBe(true);
    await control.props.onClick();
  }
  expect(create).toHaveBeenCalledTimes(1);
  finish(saved);
  await request;
  expect(selected).toBe(saved.id);
  expect(rows).toEqual([saved]);
  expect(pending).toBe(false);
  expect(lock.current).toBe(false);
});

it('keeps the empty list and allows retry after failed creation, without clearing existing selection', async () => {
  let error = '';
  const onCreated = vi.fn();
  const pending = vi.fn();
  const lock = { current: false };
  await createAndSelectSession({ lock, ready: true, create: async () => { throw new Error('offline'); }, onCreated, onPending: pending, onError: (message) => { error = message; } });
  expect(onCreated).not.toHaveBeenCalled();
  expect(error).toContain('Could not create session');
  expect(pending.mock.calls).toEqual([[true], [false]]);
  expect(lock.current).toBe(false);
});

it('does not create a session while the list is loading or failed to load', async () => {
  const create = vi.fn();
  await createAndSelectSession({ lock: { current: false }, ready: false, create, onCreated: () => {}, onPending: () => {}, onError: () => {} });
  expect(create).not.toHaveBeenCalled();
});

it('keeps the plus centered in an equal-sized circular hover and keyboard-focus target', () => {
  const html = renderToStaticMarkup(<SessionCreateButton compact onCreate={() => {}} pending={false} disabled={false} />);
  expect(html).toContain('aria-label="New session"');
  expect(html).toContain('width:32px;height:32px;min-width:32px;');
  expect(html).toContain('border-radius:50%');
  expect(html).toContain('justify-content:center');
  expect(html).toMatch(/:hover\{[^}]*border-radius:50%/);
  expect(html).toMatch(/\.Mui-focusVisible\{[^}]*border-radius:50%/);
  expect(html).toContain('data-testid="AddRoundedIcon"');
});
