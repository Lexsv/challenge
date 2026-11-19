import { useEffect, useRef, useState } from "react";
import {
  Alert,
  Button,
  Divider,
  Stack,
  Switch,
  TextField,
  Typography,
} from "@mui/material";

type Rule = { id: string; text: string; enabled: boolean };
export class InvariantRequestError extends Error {
  readonly uncertain: boolean;
  constructor(message: string, uncertain = false, readonly blocked = false) {
    super(message);
    this.uncertain = uncertain;
  }
}
export async function invariantRequest(
  path: string,
  method = "GET",
  value?: unknown,
) {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers:
        value === undefined
          ? undefined
          : { "Content-Type": "application/json" },
      body: value === undefined ? undefined : JSON.stringify(value),
    });
  } catch {
    throw new InvariantRequestError(
      "Session policy is unavailable. Reconnect and retry.",
      true,
    );
  }
  const result = await response.json().catch(() => {
    throw new InvariantRequestError(
      "Could not confirm the operation. Reconnect and retry.",
      true,
    );
  });
  if (!response.ok)
    throw new InvariantRequestError(
      result.invariantId && result.rule?.includes("████████")
        ? "Request blocked. A session rule prohibits the requested name. See Logs · Security."
        : result.rule
        ? `Request blocked. This request conflicts with “${result.rule}”`
        : result.error || "Could not verify the session policy.",
      false, response.status === 422 && result.error === "Request blocked",
    );
  return result;
}
export function ChatInvariants({
  base,
  disabled,
  revision,
  onChange,
}: {
  base: string;
  disabled: boolean;
  revision?: number;
  onChange: () => void;
}) {
  const [rules, setRules] = useState<Rule[]>([]);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<string>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const lock = useRef(false);
  const writes = useRef(0);
  useEffect(() => {
    let live = true;
    const generation = writes.current;
    invariantRequest(base + "/invariants")
      .then((items) => {
        if (live && !lock.current && writes.current === generation) {
          setRules(items);
          setReady(true);
        }
      })
      .catch(() => {
        if (live)
          setError("Could not load invariants. Reopen settings to retry.");
      });
    return () => {
      live = false;
    };
  }, [base, revision]);
  async function save(method: string, id?: string, value?: Partial<Rule>) {
    if (lock.current) return;
    lock.current = true;
    writes.current++;
    setBusy(true);
    const previous = rules;
    if (typeof value?.enabled === "boolean") {
      const enabled = value.enabled;
      setRules(rules.map(rule => rule.id === id ? { ...rule, enabled } : rule));
    }
    setError("");
    try {
      const items = await invariantRequest(
        base + "/invariants" + (id ? "/" + id : ""),
        method,
        value,
      );
      setRules(items);
      setEditing(undefined);
      setDraft("");
      onChange();
    } catch (e) {
      if (e instanceof InvariantRequestError && e.uncertain) {
        // A lost PATCH response may follow a committed edit. Read settings only.
        const confirmed = await invariantRequest(base + "/invariants").catch(() => previous);
        setRules(confirmed);
      } else {
        setRules(previous);
      }
      setError(
        e instanceof InvariantRequestError
          ? e.message
          : "Could not save invariants.",
      );
    } finally {
      // Ignore a settings GET that started during this write and finishes later.
      writes.current++;
      lock.current = false;
      setBusy(false);
    }
  }
  const locked = disabled || busy || !ready;
  return (
    <Stack spacing={1} sx={{ maxWidth: 380 }}>
      <Divider />
      <Typography component="h3" variant="subtitle1">
        Invariants
      </Typography>
      {error && <Alert severity="error">{error}</Alert>}
      {rules.map((rule) => (
        <Stack key={rule.id} spacing={0.5}>
          <Typography variant="body2" sx={{ overflowWrap: "anywhere" }}>
            <span id={"rule-" + rule.id}>{rule.text}</span>
          </Typography>
          <Stack direction="row" alignItems="center">
            <Switch
              size="small"
              checked={rule.enabled}
              disabled={locked}
              slotProps={{ input: {
                "aria-label": "Enable rule",
                "aria-describedby": "rule-" + rule.id,
              } }}
              onChange={(_, enabled) =>
                void save("PATCH", rule.id, { enabled })
              }
            />
            <Button
              size="small"
              disabled={locked}
              onClick={() => {
                setEditing(rule.id);
                setDraft(rule.text);
              }}
            >
              Edit
            </Button>
            <Button
              size="small"
              disabled={locked}
              onClick={() => void save("DELETE", rule.id)}
            >
              Remove
            </Button>
          </Stack>
        </Stack>
      ))}
      <TextField
        size="small"
        multiline
        label={editing ? "Edit invariant" : "New invariant"}
        inputProps={{ maxLength: 1000 }}
        disabled={locked}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
      />
      <Stack direction="row">
        <Button
          disabled={locked || !draft.trim()}
          onClick={() =>
            void save(editing ? "PATCH" : "POST", editing, {
              text: draft.trim(),
            })
          }
        >
          {editing ? "Save rule" : "Add rule"}
        </Button>
        {editing && (
          <Button
            disabled={busy}
            onClick={() => {
              setDraft("");
              setEditing(undefined);
            }}
          >
            Cancel
          </Button>
        )}
      </Stack>
    </Stack>
  );
}

export type SecurityAction = "blocked" | "redacted" | "withheld";
export type SecurityEvent = {
  recordedQuestion?: boolean;
  type: "SECURITY";
  stage: "input" | "output";
  action: SecurityAction;
  sessionId: string;
  turnId: string;
  invariantId: string;
  timestamp: number;
};
type PolicyStatus = {
  revision: number;
  events: SecurityEvent[];
  counts: Record<SecurityAction, number>;
  budget: { maintenanceOnly: boolean; message: string } | null;
};

// BroadcastChannel covers UI edits. Polling also sees API edits, with a fresh
// read on focus or visibility changes. Discard overlapping or obsolete reads.
export function usePolicyStatus(
  base: string,
  provider: string,
  model: string,
  active: boolean,
) {
  const [status, setStatus] = useState<PolicyStatus>();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    let live = true,
      seq = 0;
    async function load() {
      if (document.hidden) return;
      const id = ++seq;
      try {
        const next: PolicyStatus = await invariantRequest(
          base +
            "/invariants/status?" +
            new URLSearchParams({ provider, model }),
        );
        if (!live || id !== seq || !Number.isSafeInteger(next.revision)) return;
        setStatus(next);
      } catch {
        /* The server still checks every turn; retry on the next poll. */
      }
    }
    void load();
    const timer = window.setInterval(load, 2500);
    window.addEventListener("focus", load);
    document.addEventListener("visibilitychange", load);
    return () => {
      live = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", load);
      document.removeEventListener("visibilitychange", load);
    };
  }, [base, provider, model, active, tick]);
  return { status, refresh: () => setTick((n) => n + 1) };
}
