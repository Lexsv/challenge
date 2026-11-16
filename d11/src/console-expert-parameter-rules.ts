import type { ApiParameter } from "./api-parameters";
export function defaultConsoleRows(rows: readonly ApiParameter[]): ApiParameter[] {
  const copy = structuredClone([...rows]);
  for (const [key, value] of [["reasoning_effort", "medium"], ["temperature", "1.0"]]) {
    if (!copy.some(row => row.key === key)) copy.push({ id: crypto.randomUUID(), enabled: false, key, value });
  }
  return copy;
}
