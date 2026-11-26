// In-flight actions belong to the Worker session, not a particular mounted view.
const flights = new Set<string>();
const listeners = new Map<string, Set<() => void>>();
const notify = (id: string) => listeners.get(id)?.forEach(listener => listener());

export function workerActionInFlight(id: string): boolean {
  return flights.has(id);
}
export function subscribeWorkerAction(id: string, listener: () => void): () => void {
  let subscribers = listeners.get(id);
  if (!subscribers) { subscribers = new Set(); listeners.set(id, subscribers); }
  subscribers.add(listener);
  return () => { subscribers.delete(listener); if (!subscribers.size) listeners.delete(id); };
}
export function beginWorkerAction(id: string): boolean {
  if (flights.has(id)) return false;
  flights.add(id); notify(id); return true;
}
export function endWorkerAction(id: string): void {
  if (flights.delete(id)) notify(id);
}
