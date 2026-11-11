import { useRef, useState } from "react";
import { Alert, Button, MenuItem, Stack, TextField, Typography } from "@mui/material";
import type { ProviderRegistry } from "./provider-registry";

export type OpenCodeConnection = "opencode-console" | "opencode-go";
export type OpenCodeKeys = Record<OpenCodeConnection, string>;

export function verificationError(error: string | undefined, key: string): string {
  if (!error) return "Verification failed. Check credentials and model access.";
  const safe = error.split(key).join("[redacted]")
    .replace(/bearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/(?:sk-|ghp_|opencode-)[a-zA-Z0-9_-]{8,}/gi, "[redacted]")
    .replace(/(authorization|api[_-]?key|token|password|secret|credential)["']?\s*[=:]\s*["']?[^\s,;"']+/gi, "$1=[redacted]")
    .replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 300);
  return `Verification failed: ${safe}`;
}

export async function verifyOpenCode(registry: ProviderRegistry, id: OpenCodeConnection, key: string, model: string): Promise<string> {
  const provider = registry.get(id);
  const capability = provider?.capabilities(model);
  if (!provider || !capability || !key.trim()) return "Verification unavailable: check the model configuration.";
  const config = { provider: id, model, maxTokens: Math.min(128, capability.maxOutputTokens), parameters: [] };
  if (provider.validate(config)) return "Verification unavailable: check the model configuration.";
  try {
    const result = await provider.execute(key, { settings: config, instructions: "Reply with OK.", input: "Connection verification." });
    return result.status === "succeeded" ? "Verified" : verificationError(result.error, key);
  } catch {
    return "Verification failed. Check credentials and model access.";
  }
}

export function BuiltinConnectionSettings({ registry, keys, setKey, onDiscovery }: {
  registry: ProviderRegistry;
  keys: OpenCodeKeys;
  setKey: (id: OpenCodeConnection, key: string) => void;
  onDiscovery?: () => void;
}) {
  const [connection, setConnection] = useState<OpenCodeConnection>("opencode-console");
  const [models, setModels] = useState<Record<OpenCodeConnection, string>>({ "opencode-console": "", "opencode-go": "" });
  const [statuses, setStatuses] = useState<Record<OpenCodeConnection, string>>({ "opencode-console": "Not verified", "opencode-go": "Not verified" });
  const [discovery, setDiscovery] = useState<Record<OpenCodeConnection, string>>({ "opencode-console": "Capabilities not discovered", "opencode-go": "Capabilities not discovered" });
  const version = useRef<Record<OpenCodeConnection, number>>({ "opencode-console": 0, "opencode-go": 0 });
  const invalidate = (id: OpenCodeConnection) => {
    version.current[id]++;
    setStatuses((current) => ({ ...current, [id]: "Not verified" }));
  };
  const discover = async () => {
    const id = connection;
    setDiscovery((current) => ({ ...current, [id]: "Loading catalog…" }));
    try {
      const result = await registry.get(id)?.discover?.();
      onDiscovery?.();
      setDiscovery((current) => ({ ...current, [id]: result ? `Discovered ${result.length} models` : "Discovery unavailable" }));
    } catch {
      setDiscovery((current) => ({ ...current, [id]: "Model discovery failed" }));
    }
  };
  const verify = async () => {
    const id = connection;
    const model = models[id];
    const key = keys[id];
    const revision = ++version.current[id];
    setStatuses((current) => ({ ...current, [id]: "Verifying…" }));
    const result = await verifyOpenCode(registry, id, key, model);
    if (version.current[id] === revision) setStatuses((current) => ({ ...current, [id]: result }));
  };
  const selected = registry.get(connection);
  const options = registry.modelOptionsFor(connection);
  return <Stack spacing={2}>
    <TextField select label="OpenCode connection" value={connection} onChange={(event) => setConnection(event.target.value as OpenCodeConnection)}>
      <MenuItem value="opencode-console">Console — Pay as you go</MenuItem>
      <MenuItem value="opencode-go">Go — Subscription</MenuItem>
    </TextField>
    <TextField label="API key" type="password" autoComplete="off" value={keys[connection]} onChange={(event) => { invalidate(connection); setKey(connection, event.target.value); }} helperText="Stored in memory only for this page session." />
    <TextField select label="Verification model" value={models[connection]} onChange={(event) => { invalidate(connection); setModels((current) => ({ ...current, [connection]: event.target.value })); }}>
      <MenuItem value="">Select a model</MenuItem>
      {options.map((id) => <MenuItem key={id} value={id}>{id}</MenuItem>)}
    </TextField>
    <Typography variant="body2">Credential: {keys[connection].trim() ? "Present" : "Not configured"} · {statuses[connection]}</Typography>
    <Typography variant="body2">Catalog: {options.length ? `${options.length} bundled or discovered models` : "Unavailable"} · {discovery[connection]}</Typography>
    <Typography variant="body2">Execution: {keys[connection].trim() && selected?.capabilities(models[connection]) && statuses[connection] === "Verified" ? "Ready for selected model" : "Not ready for selected model"}</Typography>
    <Stack direction="row" spacing={1} flexWrap="wrap">
      <Button onClick={() => void discover()}>Discover capabilities</Button>
      <Button onClick={() => void verify()} disabled={!keys[connection].trim() || !selected?.capabilities(models[connection]) || statuses[connection] === "Verifying…"}>Verify connection</Button>
    </Stack>
    <Alert severity="info">Discovery is manual. Verification checks the selected model.</Alert>
  </Stack>;
}
