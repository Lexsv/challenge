import { AsyncLocalStorage } from "node:async_hooks";

type Fields = Record<string, string | number | boolean | undefined>;
type Status = "started" | "success" | "failure" | "interrupted";
export function elapsed(start: number) { return Math.round((performance.now() - start) * 10) / 10; }

export class Logger {
  private readonly context = new AsyncLocalStorage<Fields>();
  constructor(private readonly output: (line: string) => void = console.info) {}
  scope<T>(fields: Fields, action: () => T): T {
    return this.context.run({...this.context.getStore(), ...fields}, action);
  }
  write(event: string, status: Status, message: string, fields: Fields = {}) {
    const level = status === "failure" ? "error" : status === "interrupted" ? "warn" : "info";
    this.output(JSON.stringify({time: new Date().toISOString(), level, event, status, message,
      ...this.context.getStore(), ...fields}));
  }
}

export const silent = new Logger(() => {});
