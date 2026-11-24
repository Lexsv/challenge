import { describe, it, expect, vi } from "vitest";
import {
  API_KEY_STORAGE_KEY,
  ConnectionController,
  connectionGuidance,
  STORAGE_WARNING,
  type KeyStorage,
} from "./connection";
import { Engine, createRun } from "./legacy-engine";
import { last, type Attempt, type Expert } from "./models";
import { settings } from "./openai-model-compat";
import type { Adapter } from "./openai";
const success = { status: "succeeded" as const, text: "OK", ms: 1 };
function memoryStorage() {
  const entries = new Map<string, string>();
  const storage: KeyStorage = {
    getItem: (name) => entries.get(name) ?? null,
    setItem: (name, value) => {
      entries.set(name, value);
    },
    removeItem: (name) => {
      entries.delete(name);
    },
  };
  return { storage, entries };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
describe("session credential lifecycle", () => {
  it("restores only a key, unverified, without dispatching a request", async () => {
    const { storage, entries } = memoryStorage();
    const adapter = vi.fn<Adapter>(async () => success);
    const first = new ConnectionController(() => storage);
    first.updateKey("dummy-one");
    await first.verify("gpt-5.6-terra", adapter);
    expect(first.getSnapshot().verification).toBe("verified");
    const reloaded = new ConnectionController(() => storage);
    expect(reloaded.getKey()).toBe("dummy-one");
    expect(reloaded.getSnapshot().verification).toBe("unverified");
    expect(reloaded.getSnapshot().attempts).toEqual([]);
    expect(adapter).toHaveBeenCalledTimes(1);
    expect([...entries.keys()]).toEqual([API_KEY_STORAGE_KEY]);
  });
  it("updates, clears, and forgets only the namespaced entry and invalidates verification", async () => {
    const { storage, entries } = memoryStorage();
    entries.set("unrelated", "preserved");
    const c = new ConnectionController(() => storage);
    c.updateKey("dummy-one");
    expect(entries.get(API_KEY_STORAGE_KEY)).toBe("dummy-one");
    await c.verify("gpt-5.6-terra", async () => success);
    c.updateKey("dummy-two");
    expect(c.getKey()).toBe("dummy-two");
    expect(entries.get(API_KEY_STORAGE_KEY)).toBe("dummy-two");
    expect(c.getSnapshot().verification).toBe("unverified");
    c.updateKey("");
    expect(entries.has(API_KEY_STORAGE_KEY)).toBe(false);
    c.updateKey("dummy-three");
    c.forget();
    expect(c.getKey()).toBe("");
    expect(entries.has(API_KEY_STORAGE_KEY)).toBe(false);
    expect(entries.get("unrelated")).toBe("preserved");
  });
  it("keeps memory-only operations functional if storage access or reading fails", async () => {
    for (const access of [
      () => {
        throw new Error("blocked");
      },
      () => ({
        getItem: () => {
          throw new Error("blocked");
        },
        setItem: () => {},
        removeItem: () => {},
      }),
    ]) {
      const c = new ConnectionController(access);
      expect(c.getSnapshot().storageWarning).toBe(STORAGE_WARNING);
      c.updateKey("dummy-memory");
      expect(c.getKey()).toBe("dummy-memory");
      await c.verify("gpt-5.6-terra", async () => success);
      expect(c.getSnapshot().verification).toBe("verified");
      c.forget();
      expect(c.getKey()).toBe("");
    }
  });
  it("falls back on write failure and removes a previously stored stale key", () => {
    const { storage, entries } = memoryStorage();
    storage.setItem(API_KEY_STORAGE_KEY, "dummy-old");
    storage.setItem = () => {
      throw new Error("quota");
    };
    const c = new ConnectionController(() => storage);
    c.updateKey("dummy-new");
    expect(c.getKey()).toBe("dummy-new");
    expect(entries.has(API_KEY_STORAGE_KEY)).toBe(false);
    expect(c.getSnapshot().storageWarning).toBe(STORAGE_WARNING);
  });
  it("clears memory and reports removal failures without exposing exception details", () => {
    const { storage } = memoryStorage();
    const c = new ConnectionController(() => storage);
    c.updateKey("dummy-one");
    storage.removeItem = () => {
      throw new Error("private diagnostic must not appear");
    };
    c.forget();
    expect(c.getKey()).toBe("");
    expect(c.getSnapshot().storageWarning).toContain("Could not remove");
    expect(c.getSnapshot().storageWarning).not.toContain("private diagnostic");
  });
});
describe("derived setup guidance and verification races", () => {
  it("covers missing, unverified, verifying, failed, and verified states", async () => {
    const { storage } = memoryStorage();
    const c = new ConnectionController(() => storage);
    expect(connectionGuidance(c.getSnapshot())).toBe(
      "To get started, open Settings, enter an API key, and click Verify",
    );
    c.updateKey("dummy-one");
    expect(connectionGuidance(c.getSnapshot())).toBe(
      "API key not verified. Open Settings and click Verify",
    );
    const response = deferred<Omit<Attempt, "id">>();
    const p = c.verify("gpt-5.6-terra", () => response.promise);
    expect(connectionGuidance(c.getSnapshot())).toBe("Verifying connection...");
    response.resolve({
      ...success,
      status: "failed",
      error: "Test error",
    });
    await p;
    expect(connectionGuidance(c.getSnapshot())).toContain("try again");
    expect(c.getSnapshot().error).toBe("Test error");
    await c.verify("gpt-5.6-terra", async () => success);
    expect(connectionGuidance(c.getSnapshot())).toBeUndefined();
    c.invalidate();
    expect(connectionGuidance(c.getSnapshot())).toContain("not verified");
    await c.verify("gpt-5.6-terra", async () => success);
    c.forget();
    expect(connectionGuidance(c.getSnapshot())).toContain("To get started");
  });
  it.each(["edit", "settings", "forget"] as const)(
    "ignores an old successful response after %s",
    async (action) => {
      const { storage } = memoryStorage();
      const c = new ConnectionController(() => storage);
      c.updateKey("dummy-one");
      const response = deferred<Omit<Attempt, "id">>();
      const p = c.verify("gpt-5.6-terra", () => response.promise);
      if (action === "edit") c.updateKey("dummy-two");
      else if (action === "settings") c.invalidate();
      else c.forget();
      response.resolve(success);
      await p;
      expect(c.getSnapshot().verification).toBe("unverified");
      expect(c.getSnapshot().attempts).toHaveLength(1);
    },
  );
  it("prevents duplicate verification and lets a newer request win over an older response", async () => {
    const { storage } = memoryStorage();
    const c = new ConnectionController(() => storage);
    c.updateKey("dummy-one");
    const response = deferred<Omit<Attempt, "id">>();
    const adapter = vi.fn<Adapter>(() => response.promise);
    const old = c.verify("gpt-5.6-terra", adapter);
    await c.verify("gpt-5.6-terra", adapter);
    expect(adapter).toHaveBeenCalledTimes(1);
    c.updateKey("dummy-two");
    await c.verify("gpt-5.6-terra", async () => success);
    response.resolve({ ...success, status: "failed", error: "Old failure" });
    await old;
    expect(c.getSnapshot().verification).toBe("verified");
    expect(c.getSnapshot().error).toBeUndefined();
    expect(c.getSnapshot().attempts).toHaveLength(2);
  });
  it("sanitizes unexpected verification exceptions and remains retryable", async () => {
    const { storage } = memoryStorage();
    const c = new ConnectionController(() => storage);
    c.updateKey("dummy-one");
    await c.verify("gpt-5.6-terra", async () => {
      throw new Error("private diagnostic");
    });
    expect(c.getSnapshot().verification).toBe("failed");
    expect(c.getSnapshot().error).not.toContain("private diagnostic");
    await c.verify("gpt-5.6-terra", async () => success);
    expect(c.getSnapshot().verification).toBe("verified");
  });
});
describe("forgotten credentials and queued operations", () => {
  it("keeps already-sent results but does not send queued participants or evaluation with a cached key", async () => {
    const { storage } = memoryStorage();
    const c = new ConnectionController(() => storage);
    c.updateKey("dummy-one");
    const experts: Expert[] = Array.from({ length: 4 }, (_, i) => ({
      ...settings(""),
      id: `e${i}`,
      name: `Expert ${i}`,
      description: "Test",
      rolePrompt: "Test role",
    }));
    const run = createRun("Question", "Reference", experts, "gpt-5.6-terra");
    const response = deferred<Omit<Attempt, "id">>();
    const adapter = vi.fn<Adapter>(() => response.promise);
    const engine = new Engine(() => {}, adapter);
    const p = engine.execute(run, c.getKey);
    expect(adapter).toHaveBeenCalledTimes(3);
    c.forget();
    response.resolve(success);
    await p;
    expect(adapter).toHaveBeenCalledTimes(3);
    expect(
      run.results.filter((r) => last(r.attempts)?.status === "succeeded"),
    ).toHaveLength(3);
    expect(last(run.results[3].attempts)?.status).toBe("failed");
    expect(run.evaluationStatus).toBe("failed");
    expect(run.snapshot.experts).toHaveLength(4);
    expect(JSON.stringify(run)).not.toContain("dummy-one");
  });
});
