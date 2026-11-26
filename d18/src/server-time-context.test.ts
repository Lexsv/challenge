import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestClock, serverClock, serverTimePath, withServerTime } from './server-time-context';

afterEach(() => vi.unstubAllGlobals());

describe('server time in inference requests', () => {
  it.each([
    ['2026-03-08T06:59:59Z', 'America/Toronto', '2026-03-08T01:59:59-05:00'],
    ['2026-03-08T07:00:00Z', 'America/Toronto', '2026-03-08T03:00:00-04:00'],
    ['2026-11-01T05:30:00Z', 'America/Toronto', '2026-11-01T01:30:00-04:00'],
    ['2026-11-01T06:30:00Z', 'America/Toronto', '2026-11-01T01:30:00-05:00'],
    ['2026-12-31T18:15:00Z', 'Asia/Kathmandu', '2027-01-01T00:00:00+05:45'],
    ['2028-02-29T00:00:00Z', 'UTC', '2028-02-29T00:00:00+00:00'],
  ])('formats %s in %s', (utc, zone, expected) => {
    expect(serverClock(new Date(utc), zone)).toEqual({ timeZone: zone, localDateTime: expected });
    expect(Date.parse(expected)).toBe(Date.parse(utc));
  });

  it('takes the host IANA zone and system clock by default', () => {
    const start = Date.now();
    const { localDateTime, timeZone } = serverClock();
    expect(timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(Date.parse(localDateTime)).toBeGreaterThanOrEqual(start - 999);
    expect(Date.parse(localDateTime)).toBeLessThanOrEqual(Date.now());
  });

  it('does not modify messages retained for future turns or memory consolidation', () => {
    const messages = Object.freeze([Object.freeze({ role: 'system', content: 'Original instructions' }),
      Object.freeze({ role: 'user', content: 'Tomorrow at nine' })]);
    const body = Object.freeze({ messages });
    const clock = serverClock();
    const outbound = withServerTime(body, clock);
    expect(outbound).toMatchObject({ messages: [{ role: 'system', content: expect.stringContaining('Original instructions\n\nCurrent server time: ') }, messages[1]] });
    expect(messages[0].content).toBe('Original instructions');
    expect(JSON.stringify(messages)).not.toContain(clock.localDateTime);
  });

  it('requests a fresh backend clock in the browser, and fails closed on an invalid response', async () => {
    vi.stubGlobal('window', {});
    const clock = serverClock(new Date('2026-11-01T05:30:00Z'), 'America/Toronto');
    const get = vi.fn().mockResolvedValueOnce(Response.json(clock)).mockResolvedValueOnce(Response.json({}));
    vi.stubGlobal('fetch', get);
    await expect(requestClock()).resolves.toEqual(clock);
    await expect(requestClock()).rejects.toThrow('Invalid server time');
    expect(get.mock.calls.map(([path, options]) => [path, options.cache])).toEqual([[serverTimePath, 'no-store'], [serverTimePath, 'no-store']]);
  });
});
