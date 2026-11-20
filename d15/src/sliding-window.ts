import type { FactHistoryMessage } from './key-facts-context';
import type { ManagerLlmMessage } from './manager-agent';

/** Each history group is one dialogue message plus any associated tool observations. */
export function slidingWindow(history: readonly FactHistoryMessage[], current: readonly ManagerLlmMessage[], capacity: number): ManagerLlmMessage[] {
  if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error('Recent messages must be a positive whole number.');
  if (!current.length || current[0].role !== 'user') throw new Error('The current user message is required.');
  const prior = capacity === 1 ? [] : history.slice(-(capacity - 1));
  return [...prior.flatMap(item => item.messages), ...current];
}
