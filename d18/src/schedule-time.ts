export const intervalUnits = { seconds: 1, minutes: 60, hours: 3600, days: 86400 };
export type IntervalUnit = keyof typeof intervalUnits;
export function intervalParts(ms: number): { unit: IntervalUnit; value: number } {
  const unit =
    (["days", "hours", "minutes"] as const).find((u) => ms % (1000 * intervalUnits[u]) === 0) ??
    "seconds";
  return { unit, value: ms / (1000 * intervalUnits[unit]) };
}
export function localStart(ms: number, zone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    fractionalSecondDigits: 3,
  }).formatToParts(ms);
  const p = Object.fromEntries(parts.map((v) => [v.type, v.value]));
  return (
    p.year +
    "-" +
    p.month +
    "-" +
    p.day +
    "T" +
    p.hour +
    ":" +
    p.minute +
    ":" +
    p.second +
    "." +
    p.fractionalSecond
  );
}
// Round-trip candidate offsets. Gaps have no valid instant; folds have two.
export function possibleStarts(wall: string, zone: string): number[] {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d{1,3})?)?$/.test(wall) || !zone || /^[+-]/.test(zone))
    return [];
  const utc = Date.parse(wall + "Z");
  if (!Number.isFinite(utc)) return [];
  const normalized = new Date(utc).toISOString().slice(0, -1);
  if (!normalized.startsWith(wall)) return [];
  try {
    const candidates = new Set<number>();
    for (const hours of [-36, -12, 0, 12, 36]) {
      const probe = utc + hours * 3600000,
        offset = Date.parse(localStart(probe, zone) + "Z") - probe;
      const candidate = utc - offset;
      if (localStart(candidate, zone) === normalized) candidates.add(candidate);
    }
    return [...candidates].sort((a, b) => a - b);
  } catch {
    return [];
  }
}
