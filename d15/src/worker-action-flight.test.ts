import { describe, expect, it, vi } from 'vitest';
import { beginWorkerAction, endWorkerAction, subscribeWorkerAction, workerActionInFlight } from './worker-action-flight';

describe('Worker action in-flight ownership', () => {
  it('keeps a pending action across unsubscribe and remount, and blocks duplicates', () => {
    const first = vi.fn(), returning = vi.fn();
    const unsubscribe = subscribeWorkerAction('worker-a', first);
    expect(beginWorkerAction('worker-a')).toBe(true);
    expect(first).toHaveBeenCalledTimes(1);
    unsubscribe();
    expect(workerActionInFlight('worker-a')).toBe(true);
    const unmount = subscribeWorkerAction('worker-a', returning);
    expect(beginWorkerAction('worker-a')).toBe(false);
    expect(workerActionInFlight('worker-b')).toBe(false);
    endWorkerAction('worker-a');
    expect(returning).toHaveBeenCalledTimes(1);
    expect(workerActionInFlight('worker-a')).toBe(false);
    unmount();
  });
  it('isolates sessions and permits a new attempt after settlement', () => {
    const a = vi.fn(), b = vi.fn();
    const offA = subscribeWorkerAction('a', a), offB = subscribeWorkerAction('b', b);
    expect(beginWorkerAction('a')).toBe(true);
    expect(beginWorkerAction('b')).toBe(true);
    endWorkerAction('a');
    expect(workerActionInFlight('b')).toBe(true);
    expect(beginWorkerAction('a')).toBe(true);
    endWorkerAction('a'); endWorkerAction('b');
    expect(a).toHaveBeenCalledTimes(4);
    expect(b).toHaveBeenCalledTimes(2);
    offA(); offB();
  });
});
