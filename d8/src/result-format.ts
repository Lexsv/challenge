import { totals, type Attempt } from "./models";
export const formatTokens = (value?: number) =>
  value === undefined ? "Not available" : value.toLocaleString();
export const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
export const usage = (attempts: Attempt[]) => {
  const total = totals(attempts);
  return `${formatTokens(total.input)} input / ${formatTokens(total.output)} output tokens${total.partial ? " · partial usage" : ""}`;
};
