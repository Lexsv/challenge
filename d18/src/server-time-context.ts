// Sample once so the date, time and offset always describe the same instant.
export function serverClock(now = new Date(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, calendar: 'iso8601', numberingSystem: 'latn', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
    minute: '2-digit', second: '2-digit', timeZoneName: 'longOffset',
  }).formatToParts(now);
  const part = (name: Intl.DateTimeFormatPartTypes) => parts.find(p => p.type === name)!.value;
  const offset = part('timeZoneName').slice(3) || '+00:00';
  return { timeZone, localDateTime: `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:${part('second')}${offset}` };
}

export const serverTimePath = '/api/sessions/context/server-time';

// Direct-key browser adapters need the backend clock too. A stale or missing
// response must not silently substitute the browser's time or timezone.
export async function requestClock(signal?: AbortSignal): Promise<ReturnType<typeof serverClock>> {
  if (typeof window === 'undefined') return serverClock();
  const response = await fetch(serverTimePath, { cache: 'no-store', signal: signal ?? AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error('Server time unavailable.');
  const clock = await response.json();
  if (typeof clock?.timeZone !== 'string' || !/^[A-Za-z0-9_+./-]+$/.test(clock.timeZone) ||
      typeof clock.localDateTime !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/.test(clock.localDateTime)) {
    throw new Error('Invalid server time.');
  }
  return { timeZone: clock.timeZone, localDateTime: clock.localDateTime };
}

// Decorate only the outbound provider envelope. Never mutate transcript messages.
export function withServerTime(body: Record<string, unknown>, clock: ReturnType<typeof serverClock>) {
  const instruction = `Current server time: ${clock.localDateTime} [${clock.timeZone}]. Resolve relative dates and local times in this zone unless another is specified. Use the target instant's UTC offset. Clarify ambiguous or nonexistent local times.`;
  if (Object.hasOwn(body, 'messages')) {
    if (!Array.isArray(body.messages)) throw new Error('Invalid provider messages.');
    const [first, ...rest] = body.messages;
    const messages = first?.role === 'system' && typeof first.content === 'string'
      ? [{ ...first, content: `${first.content}\n\n${instruction}` }, ...rest]
      : [{ role: 'system', content: instruction }, ...body.messages];
    return { ...body, messages };
  }
  return { ...body, instructions: body.instructions ? `${body.instructions}\n\n${instruction}` : instruction };
}
