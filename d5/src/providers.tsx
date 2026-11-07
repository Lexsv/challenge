import { useRef, useState, type ReactNode } from "react";
import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Paper, Stack, Typography } from "@mui/material";
import Add from "@mui/icons-material/Add";
import { ProviderConfigurationDialog, type ProviderDraft } from "./provider-configuration-dialog";
import { createProviderRegistry, type ProviderRegistry } from "./provider-registry";
import { INFERENCE_ENDPOINTS } from "./opencode-adapter";
import { verificationError, verifyOpenCode } from "./builtin-connection-settings";
import type { Adapter } from "./provider-contract";
import { verificationSettings } from "./openai-model-compat";
import type { ApiParameter } from "./api-parameters";
import type { VerificationStatus } from "./connection";
import { deleteTemplates, openTemplates, saveTemplates, switchTemplateModel } from "./provider-template-state";
import { DEFAULT_ENDPOINTS } from "./provider-endpoints";

type BuiltinId = "openai" | "opencode-console" | "opencode-go" | "gemini";
type CustomProvider = { id: string; name: string; endpoint: string; key: string; models: { id: string; parameters: ApiParameter[] }[] };
const LEGACY_STORAGE = "expert-lab:d5:custom-providers";
const STORAGE = "expert-lab:d5:custom-providers-v2";
const builtins: { id: BuiltinId; name: string; endpoint: string; subtitle: string }[] = [
  { id: "openai", name: "OpenAI", endpoint: "https://api.openai.com/v1/responses", subtitle: "Default" },
  { id: "opencode-console", name: "OpenCode Console", endpoint: INFERENCE_ENDPOINTS.console, subtitle: "Pay as you go" },
  { id: "opencode-go", name: "OpenCode Go", endpoint: INFERENCE_ENDPOINTS.go, subtitle: "Subscription" },
  { id: "gemini", name: "Google Gemini", endpoint: "https://generativelanguage.googleapis.com/v1beta/models", subtitle: "Execution unavailable" },
];
function readProviders(): CustomProvider[] {
  try {
    const data: unknown = JSON.parse(sessionStorage.getItem(STORAGE) || sessionStorage.getItem(LEGACY_STORAGE) || "[]");
    if (!Array.isArray(data)) return [];
    return data.filter((p) => p && typeof p.id === "string" && typeof p.name === "string" && typeof p.endpoint === "string" && Array.isArray(p.models)).map((p) => ({ ...p, key: "" }));
  } catch { return []; }
}
export function Providers({ model, verification, openAISettings: _oldOpenAISettings, openCodeSettings: _oldOpenCodeSettings, openAIKeyPresent = false, registry: suppliedRegistry, keys, onSaveBuiltin, adapter, referencedProviders = [], onDiscovery }: {
  model: string; verification: VerificationStatus; openAISettings?: ReactNode; openCodeSettings?: ReactNode; openAIKeyPresent?: boolean;
  registry?: ProviderRegistry; keys?: Record<BuiltinId, string>; onSaveBuiltin?: (id: BuiltinId, key: string, model: string, verified: boolean) => void;
  adapter?: Adapter; referencedProviders?: string[]; onDiscovery?: () => void;
}) {
  const [registry] = useState(() => suppliedRegistry ?? createProviderRegistry());
  const [providers, setProviders] = useState(readProviders);
  const [draft, setDraft] = useState<ProviderDraft | null>(null);
  const [parameterMap, setParameterMap] = useState<Record<string, ApiParameter[]>>({});
  const [savedParameters, setSavedParameters] = useState<Record<string, Record<string, ApiParameter[]>>>({});
  const [savedModels, setSavedModels] = useState<Record<string, string>>({});
  const [statuses, setStatuses] = useState<Record<string, string>>({});
  const [status, setStatus] = useState("Not verified");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmEndpoint, setConfirmEndpoint] = useState(false);
  const [storageWarning, setStorageWarning] = useState(false);
  const version = useRef(0);
  const persist = (next: CustomProvider[]) => {
    setProviders(next);
    try { sessionStorage.setItem(STORAGE, JSON.stringify(next.map(({ key: _key, ...rest }) => ({ ...rest, key: "" })))); setStorageWarning(false); }
    catch { setStorageWarning(true); }
  };
  const close = () => { version.current++; setDraft(null); setConfirmDelete(false); setConfirmEndpoint(false); };
  const openBuiltin = (id: BuiltinId) => {
    const provider = builtins.find((p) => p.id === id)!;
    const chosen = id === "openai" ? model : (savedModels[id] ?? "");
    const params = openTemplates(savedParameters, id);
    setParameterMap(params);
    setDraft({ ...provider, endpoint: registry.endpointFor(id) ?? provider.endpoint, builtin: true, key: keys?.[id] ?? "", model: chosen, models: [...registry.modelOptionsFor(id)], parameters: params[chosen] ?? [] });
    setStatus(id === "gemini" ? "Gemini verification and execution are unavailable." : statuses[id] ?? (id === "openai" && verification === "verified" ? "Verified" : "Not verified"));
  };
  const openCustom = (provider?: CustomProvider) => {
    const p = provider ?? { id: crypto.randomUUID(), name: "", endpoint: "", key: "", models: [] };
    const chosen = p.models[0]?.id ?? "";
    const params = Object.fromEntries(p.models.map((m) => [m.id, structuredClone(m.parameters)]));
    setParameterMap(params);
    setDraft({ id: p.id, name: p.name, endpoint: p.endpoint, key: p.key, model: chosen, models: p.models.map((m) => m.id), parameters: params[chosen] ?? [], builtin: false });
    setStatus("Custom provider verification and execution are unavailable.");
  };
  const changeDraft = (next: ProviderDraft) => {
    if (!draft) return;
    if (next.key !== draft.key || next.endpoint !== draft.endpoint || next.model !== draft.model) {
      version.current++;
      setStatus(next.id === "gemini" ? "Gemini verification and execution are unavailable." : !next.builtin ? "Custom provider verification and execution are unavailable." : "Not verified");
    }
    if (next.model !== draft.model) {
      const switched = switchTemplateModel(parameterMap, draft.model, draft.parameters, next.model);
      setParameterMap(switched.templates);
      next = { ...next, parameters: switched.rows };
    }
    setDraft(next);
  };
  const save = (confirmed = false) => {
    if (!draft) return;
    if (draft.builtin && draft.endpoint !== registry.endpointFor(draft.id)) {
      if (draft.endpoint !== DEFAULT_ENDPOINTS[draft.id as BuiltinId] && !confirmed) { setConfirmEndpoint(true); return; }
      try { registry.setEndpoint(draft.id as BuiltinId, draft.endpoint, confirmed); }
      catch { setStatus("Invalid endpoint. Check the URL and required path."); return; }
      onDiscovery?.();
    }
    const params = { ...parameterMap, [draft.model]: structuredClone(draft.parameters) };
    if (draft.builtin) {
      setSavedParameters((current) => saveTemplates(current, draft.id, parameterMap, draft.model, draft.parameters));
      setSavedModels((current) => ({ ...current, [draft.id]: draft.model }));
      setStatuses((current) => ({ ...current, [draft.id]: status }));
      onSaveBuiltin?.(draft.id as BuiltinId, draft.key, draft.model, status === "Verified");
    } else {
      persist([...providers.filter((p) => p.id !== draft.id), { id: draft.id, name: draft.name, endpoint: draft.endpoint, key: draft.key, models: draft.models.map((id) => ({ id, parameters: params[id] ?? [] })) }]);
    }
    close();
  };
  const verify = async () => {
    if (!draft || !draft.builtin || draft.id === "gemini" || !draft.key.trim() || !draft.model) return;
    const current = ++version.current;
    const selected = structuredClone(draft);
    setStatus("Verifying…");
    let result = "Verification failed. Check credentials and model access.";
    try {
      if (selected.id === "openai" && adapter) {
        const attempt = await registry.get("openai")!.execute(selected.key, { settings: verificationSettings(selected.model), instructions: "Reply with OK.", input: "Connection verification." });
        result = attempt.status === "succeeded" ? "Verified" : verificationError(attempt.error, selected.key);
      } else if (selected.id === "opencode-console" || selected.id === "opencode-go") result = await verifyOpenCode(registry, selected.id, selected.key, selected.model);
    } catch { /* Keep the sanitized fallback. */ }
    if (version.current === current) setStatus(result);
  };
  const discover = async () => {
    if (!draft) return;
    const id = draft.id, current = ++version.current;
    try {
      await registry.get(id)?.discover?.();
      onDiscovery?.();
      if (version.current === current) { setDraft((p) => p && p.id === id ? { ...p, models: [...registry.modelOptionsFor(id)] } : p); setStatus("Model capabilities refreshed. Verification is still required."); }
    } catch { if (version.current === current) setStatus("Model discovery failed."); }
  };
  const remove = () => {
    if (!draft) return;
    if (draft.builtin) {
      registry.setEndpoint(draft.id as BuiltinId, DEFAULT_ENDPOINTS[draft.id as BuiltinId]);
      setSavedParameters((current) => deleteTemplates(current, draft.id));
      setSavedModels((current) => { const next = { ...current }; delete next[draft.id]; return next; });
      setStatuses((current) => ({ ...current, [draft.id]: "Not verified" }));
      onSaveBuiltin?.(draft.id as BuiltinId, "", draft.id === "openai" ? model : "", false);
    } else persist(providers.filter((p) => p.id !== draft.id));
    close();
  };
  return <Stack spacing={2}>
    <Stack direction={{ xs: "column", sm: "row" }} justifyContent="space-between" spacing={1}><Box><Typography variant="h5" component="h2">Providers</Typography><Typography color="text.secondary">Manage providers, endpoints, models and parameters.</Typography></Box><Button variant="contained" startIcon={<Add />} onClick={() => openCustom()}>Add Provider</Button></Stack>
    {storageWarning && <Alert severity="warning">Custom provider settings could not be retained across reloads.</Alert>}
    {builtins.map((p) => <Paper key={p.id} variant="outlined" sx={{ p: 2 }}><Stack direction={{ xs: "column", sm: "row" }} justifyContent="space-between" spacing={1}><Box sx={{ overflowWrap: "anywhere" }}><Typography variant="h6">{p.name}</Typography><Typography>{p.subtitle}</Typography><Typography variant="body2">{p.id === "openai" ? `${verification === "verified" ? "Verified" : "Not verified"} · Model: ${model} · Credential: ${openAIKeyPresent ? "Present" : "Not configured"}` : p.id === "gemini" ? "Catalog available · Verification unavailable" : `${statuses[p.id] ?? "Not verified"} · Catalog available`}</Typography></Box><Button variant="outlined" onClick={() => openBuiltin(p.id)}>Configure</Button></Stack></Paper>)}
    {providers.map((p) => <Paper key={p.id} variant="outlined" sx={{ p: 2 }}><Stack direction={{ xs: "column", sm: "row" }} justifyContent="space-between"><Box><Typography variant="h6">{p.name}</Typography><Typography>{p.endpoint}</Typography><Typography variant="body2">Models: {p.models.map((m) => m.id).join(", ") || "None"}</Typography></Box><Button onClick={() => openCustom(p)}>Configure</Button></Stack></Paper>)}
    {draft && <ProviderConfigurationDialog key={draft.id} draft={draft} onChange={changeDraft} onClose={close} onSave={() => save()} status={draft.builtin && draft.endpoint !== registry.endpointFor(draft.id) ? "Save the endpoint before verification or discovery." : status} originalEndpoint={draft.builtin ? DEFAULT_ENDPOINTS[draft.id as BuiltinId] : undefined} onDelete={draft.builtin || providers.some((p) => p.id === draft.id) ? () => setConfirmDelete(true) : undefined} onVerify={draft.builtin && draft.id !== "gemini" && draft.endpoint === registry.endpointFor(draft.id) ? () => void verify() : undefined} onDiscover={(draft.id === "opencode-console" || draft.id === "opencode-go") && draft.endpoint === registry.endpointFor(draft.id) ? () => void discover() : undefined} />}
    <Dialog open={confirmEndpoint} onClose={() => setConfirmEndpoint(false)}><DialogTitle>Confirm custom endpoint</DialogTitle><DialogContent><Typography>Requests for {draft?.name} will send its API credential to {draft?.endpoint}. Confirm only if you trust this destination.</Typography></DialogContent><DialogActions><Button onClick={() => setConfirmEndpoint(false)}>Cancel</Button><Button onClick={() => save(true)}>Confirm endpoint</Button></DialogActions></Dialog>
    <Dialog open={confirmDelete} onClose={() => setConfirmDelete(false)}><DialogTitle>Delete provider configuration?</DialogTitle><DialogContent><Typography>{draft?.builtin ? "This clears its user configuration; the built-in provider remains available." : "This removes the saved custom provider."} {draft && referencedProviders.includes(draft.id) ? "Existing experts reference this provider and will not be reassigned." : "Existing experts will not be reassigned."}</Typography></DialogContent><DialogActions><Button onClick={() => setConfirmDelete(false)}>Cancel</Button><Button color="error" onClick={remove}>Delete</Button></DialogActions></Dialog>
  </Stack>;
}
