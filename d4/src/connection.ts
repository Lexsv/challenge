import { verificationSettings, type Attempt } from "./models";
import type { Adapter } from "./openai";

export const API_KEY_STORAGE_KEY = "expert-lab:w1:d3:openai-api-key";
export const STORAGE_WARNING =
  "Could not retain the key across reloads. It is available in page memory only.";
const REMOVAL_WARNING =
  "Could not remove the stored entry. The key is cleared from the app; clear browser site data to remove the saved entry.";
export type KeyStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export type VerificationStatus =
  "unverified" | "verifying" | "failed" | "verified";
export type ConnectionState = {
  key: string;
  verification: VerificationStatus;
  error?: string;
  storageWarning?: string;
  attempts: Attempt[];
};

export function connectionGuidance(
  state: Pick<ConnectionState, "key" | "verification">,
): string | undefined {
  if (!state.key.trim())
    return "To get started, open Settings, enter an API key, and click Verify";
  switch (state.verification) {
    case "verified":
      return undefined;
    case "verifying":
      return "Verifying connection...";
    case "failed":
      return "Review connection settings and click Verify to try again.";
    default:
      return "API key not verified. Open Settings and click Verify";
  }
}

// Only this boundary reads/writes credentials. Never serialize or log its state.
export class ConnectionController {
  private state: ConnectionState;
  private version = 0;
  private memoryOnly = false;
  private listeners = new Set<() => void>();
  constructor(private storage: () => KeyStorage = () => window.sessionStorage) {
    let key = "";
    let storageWarning: string | undefined;
    try {
      key = this.storage().getItem(API_KEY_STORAGE_KEY) || "";
    } catch {
      this.memoryOnly = true;
      storageWarning = STORAGE_WARNING;
    }
    this.state = {
      key,
      verification: "unverified",
      storageWarning,
      attempts: [],
    };
  }
  getSnapshot = () => this.state;
  getKey = () => this.state.key;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(update: Partial<ConnectionState>) {
    this.state = { ...this.state, ...update };
    this.listeners.forEach((listener) => listener());
  }
  invalidate = () => {
    this.version++;
    this.publish({ verification: "unverified", error: undefined });
  };
  updateKey = (key: string) => {
    this.version++;
    let storageWarning = this.state.storageWarning;
    try {
      if (!key.trim()) this.storage().removeItem(API_KEY_STORAGE_KEY);
      else if (!this.memoryOnly)
        this.storage().setItem(API_KEY_STORAGE_KEY, key);
    } catch {
      this.memoryOnly = true;
      storageWarning = STORAGE_WARNING;
      // If a write fails after a previous successful write, avoid restoring that stale value.
      try {
        this.storage().removeItem(API_KEY_STORAGE_KEY);
      } catch {
        storageWarning = `${STORAGE_WARNING} ${REMOVAL_WARNING}`;
      }
    }
    this.publish({
      key,
      verification: "unverified",
      error: undefined,
      storageWarning,
    });
  };
  forget = () => this.updateKey("");
  async verify(model: string, adapter: Adapter) {
    if (
      !this.state.key.trim() ||
      !model.trim() ||
      this.state.verification === "verifying"
    )
      return;
    const version = this.version;
    this.publish({ verification: "verifying", error: undefined });
    let attempt: Attempt;
    try {
      attempt = {
        id: crypto.randomUUID(),
        ...(await adapter(this.getKey(), {
          settings: verificationSettings(model),
          instructions: "Reply with OK.",
          input: "Connection verification.",
        })),
      };
    } catch {
      // Never expose an exception that could contain credentials.
      attempt = {
        id: crypto.randomUUID(),
        status: "failed",
        text: "",
        ms: 0,
        error:
          "Could not verify the connection. Review settings and try again.",
      };
    }
    this.publish({ attempts: [...this.state.attempts, attempt] });
    if (version !== this.version) return;
    this.publish(
      attempt.status === "succeeded"
        ? { verification: "verified", error: undefined }
        : {
            verification: "failed",
            error: attempt.error || "Connection verification failed.",
          },
    );
  }
}
