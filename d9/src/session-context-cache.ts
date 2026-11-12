import type { NextSessionContext } from "./session-stats";

/** Only a current calculation may publish; last valid values are scoped by session/pair. */
export class SessionContextCache {
  private generation = 0;
  private key = "";
  private values = new Map<string, NextSessionContext>();
  get(key: string) {
    return this.values.get(key);
  }
  begin(key: string) {
    this.key = key;
    return ++this.generation;
  }
  complete(ticket: number, key: string, value?: NextSessionContext) {
    if (ticket !== this.generation || key !== this.key) return false;
    if (value?.estimatedInputTokens !== undefined) this.values.set(key, value);
    return true;
  }
  cancel(ticket: number) {
    if (ticket === this.generation) ++this.generation;
  }
}
