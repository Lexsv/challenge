import { useEffect, useRef, useState, type ReactNode } from "react";
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
import { DEFAULT_ENDPOINTS, consoleBaseEndpoint, consoleConfiguredEndpoint } from "./provider-endpoints";
import { selectConsoleVerificationPlan, verifyConsoleModel } from "./opencode-console-verification";
import { consoleStatusKind, ConsoleVerificationStatus } from "./console-verification-status";
import { type VerificationKind } from "./verification-chip";
import { ProviderStatus } from "./provider-status";
import { createVerificationSingleFlight } from "./verification-single-flight";

type BuiltinId = "openai" | "opencode-console" | "opencode-go" | "gemini";
type CustomProvider = { id: string; name: string; endpoint: string; key: string; models: { id: string; parameters: ApiParameter[] }[] };
const LEGACY_STORAGE = "expert-lab:d5:custom-providers";
const STORAGE = "expert-lab:d5:custom-providers-v2";
const builtins: { id: BuiltinId; name: string; endpoint: string; subtitle: string }[] = [
  { id: "openai", name: "OpenAI", endpoint: "https://api.openai.com/v1/responses", subtitle: "" },
  { id: "opencode-console", name: "OpenCode Console", endpoint: INFERENCE_ENDPOINTS.console, subtitle: "Pay as you go" },
];
function readProviders(): CustomProvider[] {
  try {
    const data: unknown = JSON.parse(sessionStorage.getItem(STORAGE) || sessionStorage.getItem(LEGACY_STORAGE) || "[]");
    if (!Array.isArray(data)) return [];
    return data.filter((p) => p && typeof p.id === "string" && typeof p.name === "string" && typeof p.endpoint === "string" && Array.isArray(p.models)).map((p) => ({ ...p, key: "" }));
  } catch { return []; }
}
export function Providers({ model, verification, openAISettings: _oldOpenAISettings, openCodeSettings: _oldOpenCodeSettings, openAIKeyPresent = false, registry: suppliedRegistry, keys, onSaveBuiltin, adapter, referencedProviders = [], onDiscovery, onConsoleStatusChange }: {
  model: string; verification: VerificationStatus; openAISettings?: ReactNode; openCodeSettings?: ReactNode; openAIKeyPresent?: boolean;
  registry?: ProviderRegistry; keys?: Record<BuiltinId, string>; onSaveBuiltin?: (id: BuiltinId, key: string, model: string, verified: boolean) => void;
  adapter?: Adapter; referencedProviders?: string[]; onDiscovery?: () => void; onConsoleStatusChange?: (value: { kind: VerificationKind; unsaved: boolean }) => void;
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
  const [isVerifying, setIsVerifying] = useState(false);
  const [consoleCatalogStatus, setConsoleCatalogStatus] = useState("Catalog: bundled list available; authentication not checked by the catalog.");
  const [storageWarning, setStorageWarning] = useState(false);
  const version = useRef(0);
  const verificationFlight = useRef(createVerificationSingleFlight());
  const persist = (next: CustomProvider[]) => {
    setProviders(next);
    try { sessionStorage.setItem(STORAGE, JSON.stringify(next.map(({ key: _key, ...rest }) => ({ ...rest, key: "" })))); setStorageWarning(false); }
    catch { setStorageWarning(true); }
  };
  const close = () => { version.current++; setDraft(null); setConfirmDelete(false); setConfirmEndpoint(false); };
  const configuredEndpoint = (id: string, endpoint: string) => {
    try { return id === "opencode-console" ? consoleConfiguredEndpoint(endpoint) : endpoint; } catch { return ""; }
  };
  const openBuiltin = (id: BuiltinId) => {
    const provider = builtins.find((p) => p.id === id)!;
    const chosen = id === "openai" ? model : (savedModels[id] ?? "");
    const params = openTemplates(savedParameters, id);
    setParameterMap(params);
    setDraft({ ...provider, endpoint: id === "opencode-console" ? consoleBaseEndpoint(registry.endpointFor(id) ?? provider.endpoint) : registry.endpointFor(id) ?? provider.endpoint, builtin: true, key: keys?.[id] ?? "", model: chosen, models: [...registry.modelOptionsFor(id)], parameters: params[chosen] ?? [] });
    setStatus(id === "gemini" ? "Verification not supported yet. Gemini execution is also unavailable." : statuses[id] ?? (id === "openai" && verification === "verified" ? "Verified" : id === "opencode-console" ? "Authentication: not checked. Model: not checked." : "Not verified"));
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
      setStatus(next.id === "gemini" ? "Verification not supported yet. Gemini execution is also unavailable." : !next.builtin ? "Custom provider verification and execution are unavailable." : next.id === "opencode-console" ? "Authentication: not checked. Model: not checked." : "Not verified");
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
    if (draft.builtin && configuredEndpoint(draft.id, draft.endpoint) !== registry.endpointFor(draft.id)) {
      if (configuredEndpoint(draft.id, draft.endpoint) !== DEFAULT_ENDPOINTS[draft.id as BuiltinId] && !confirmed) { setConfirmEndpoint(true); return; }
      try { registry.setEndpoint(draft.id as BuiltinId, configuredEndpoint(draft.id, draft.endpoint), confirmed); }
      catch { setStatus("Invalid endpoint. Check the URL and required path."); return; }
      onDiscovery?.();
      if (draft.id === "opencode-console") setConsoleCatalogStatus("Catalog: bundled list available; authentication not checked by the catalog.");
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
  const requestVerify = () => {
    if (!draft || !draft.builtin || draft.id === "gemini" || !draft.key.trim() || (draft.id !== "opencode-console" && !draft.model)) return;
    const selected = structuredClone(draft);
    const endpoint = configuredEndpoint(selected.id, selected.endpoint);
    if (endpoint !== registry.endpointFor(selected.id)) {
      setStatus("Verification not sent. Save the endpoint and try again.");
      return;
    }
    void verificationFlight.current(async () => {
      const current = ++version.current;
      setIsVerifying(true);
      setStatus("Verifying connection…");
      try {
        let result = "Verification failed. Check credentials and model access.";
        if (selected.id === "opencode-console") {
          const discover = registry.get("opencode-console")?.discover;
          if (!discover) throw new Error("Discovery unavailable");
          const models = await discover();
          if (version.current !== current || endpoint !== registry.endpointFor(selected.id)) return;
          setConsoleCatalogStatus(`Catalog available: ${models.length} discovered models. The catalog does not verify authentication.`);
          const plan = selectConsoleVerificationPlan(models, endpoint);
          if (!plan) result = "Verification not sent. No eligible Console model is available in the catalog.";
          else {
            result = await verifyConsoleModel(selected.key, plan);
            if (!result.includes(plan.model)) result += ` Model: ${plan.model}.`;
          }
        } else if (selected.id === "openai" && adapter) {
          const attempt = await registry.get("openai")!.execute(selected.key, { settings: verificationSettings(selected.model), instructions: "Reply with OK.", input: "Connection verification." });
          result = attempt.status === "succeeded" ? "Verified" : verificationError(attempt.error, selected.key);
        } else if (selected.id === "opencode-go") result = await verifyOpenCode(registry, selected.id, selected.key, selected.model);
        if (version.current === current) setStatus(result);
      } catch {
        if (version.current === current) setStatus("Verification could not be completed. Check catalog availability and connection settings, then try again.");
      } finally { setIsVerifying(false); }
    });
  };
  const discover = async () => {
    if (!draft) return;
    const id = draft.id, current = ++version.current;
    if (id === "opencode-console") setStatus((value) => value === "Verifying connection…" ? "Authentication: not checked. Model: not checked." : value);
    try {
      const models = await registry.get(id)?.discover?.();
      onDiscovery?.();
      if (version.current === current) { setDraft((p) => p && p.id === id ? { ...p, models: [...registry.modelOptionsFor(id)] } : p); if (id === "opencode-console") setConsoleCatalogStatus(`Catalog available: ${models?.length ?? 0} discovered models. The catalog does not verify authentication.`); else setStatus("Model capabilities refreshed. Verification is still required."); }
    } catch { if (version.current === current) { if (id === "opencode-console") setConsoleCatalogStatus("Catalog discovery failed. Authentication was not checked."); else setStatus("Model discovery failed."); } }
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
  const savedConsoleStatus = statuses["opencode-console"] ?? "Authentication: not checked. Model: not checked.";
  const consoleDraft = draft?.id === "opencode-console" ? draft : null;
  const consoleUnsaved = !!consoleDraft && (status !== savedConsoleStatus || consoleDraft.key !== (keys?.["opencode-console"] ?? "") || consoleDraft.model !== (savedModels["opencode-console"] ?? "") || configuredEndpoint(consoleDraft.id, consoleDraft.endpoint) !== registry.endpointFor("opencode-console"));
  const consoleKind = consoleStatusKind(consoleDraft ? status : savedConsoleStatus);
  useEffect(() => { onConsoleStatusChange?.({ kind: consoleKind, unsaved: consoleUnsaved }); }, [consoleKind, consoleUnsaved, onConsoleStatusChange]);
  return <Stack spacing={2}>
    <Stack direction={{ xs: "column", sm: "row" }} justifyContent="space-between" spacing={1}><Box><Typography variant="h5" component="h2">Providers</Typography><Typography color="text.secondary">Manage providers, endpoints, models and parameters.</Typography></Box><Button variant="contained" startIcon={<Add />} onClick={() => openCustom()}>Add Provider</Button></Stack>
    {storageWarning && <Alert severity="warning">Custom provider settings could not be retained across reloads.</Alert>}
    {builtins.map((p) => <Paper key={p.id} variant="outlined" sx={{ p: 2 }}><Stack direction={{ xs: "column", sm: "row" }} justifyContent="space-between" spacing={1}><Stack spacing={0.5} alignItems="flex-start" sx={{ minWidth: 0, overflowWrap: "anywhere" }}><Typography variant="h6">{p.name}</Typography>{p.id === "opencode-console" ? <><ConsoleVerificationStatus status={consoleDraft ? status : savedConsoleStatus} unsaved={consoleUnsaved} /><Typography variant="body2">{p.subtitle} · Catalog available</Typography></> : <><ProviderStatus verification={verification} /><Typography variant="body2">Model: {model} · Credential: {openAIKeyPresent ? "Present" : "Not configured"}</Typography></>}</Stack><Button variant="outlined" onClick={() => openBuiltin(p.id)}>Configure</Button></Stack></Paper>)}
    {providers.map((p) => <Paper key={p.id} variant="outlined" sx={{ p: 2 }}><Stack direction={{ xs: "column", sm: "row" }} justifyContent="space-between"><Box><Typography variant="h6">{p.name}</Typography><Typography>{p.endpoint}</Typography><Typography variant="body2">Models: {p.models.map((m) => m.id).join(", ") || "None"}</Typography></Box><Button onClick={() => openCustom(p)}>Configure</Button></Stack></Paper>)}
    {draft && <ProviderConfigurationDialog key={draft.id} draft={draft} onChange={changeDraft} onClose={close} onSave={() => save()} status={draft.builtin && configuredEndpoint(draft.id, draft.endpoint) !== registry.endpointFor(draft.id) ? "Save the endpoint before verification or discovery." : status} catalogStatus={draft.id === "opencode-console" ? (configuredEndpoint(draft.id, draft.endpoint) === registry.endpointFor(draft.id) ? consoleCatalogStatus : "Catalog: save the endpoint before discovery.") : undefined} verificationHint={draft.id === "opencode-console" ? "Verification chooses the first eligible model from the current catalog." : undefined} originalEndpoint={draft.builtin ? draft.id === "opencode-console" ? consoleBaseEndpoint(DEFAULT_ENDPOINTS["opencode-console"]) : DEFAULT_ENDPOINTS[draft.id as BuiltinId] : undefined} onDelete={draft.builtin || providers.some((p) => p.id === draft.id) ? () => setConfirmDelete(true) : undefined} isVerifying={isVerifying} onVerify={draft.builtin && draft.id !== "gemini" && configuredEndpoint(draft.id, draft.endpoint) === registry.endpointFor(draft.id) ? requestVerify : undefined} onDiscover={(draft.id === "opencode-console" || draft.id === "opencode-go") && configuredEndpoint(draft.id, draft.endpoint) === registry.endpointFor(draft.id) ? () => void discover() : undefined} />}
    <Dialog open={confirmEndpoint} onClose={() => setConfirmEndpoint(false)}><DialogTitle>Confirm custom endpoint</DialogTitle><DialogContent><Typography>Requests for {draft?.name} will send its API credential to {draft?.endpoint}. Confirm only if you trust this destination.</Typography></DialogContent><DialogActions><Button onClick={() => setConfirmEndpoint(false)}>Cancel</Button><Button onClick={() => save(true)}>Confirm endpoint</Button></DialogActions></Dialog>
    <Dialog open={confirmDelete} onClose={() => setConfirmDelete(false)}><DialogTitle>Delete provider configuration?</DialogTitle><DialogContent><Typography>{draft?.builtin ? "This clears its user configuration; the built-in provider remains available." : "This removes the saved custom provider."} {draft && referencedProviders.includes(draft.id) ? "Existing experts reference this provider and will not be reassigned." : "Existing experts will not be reassigned."}</Typography></DialogContent><DialogActions><Button onClick={() => setConfirmDelete(false)}>Cancel</Button><Button color="error" onClick={remove}>Delete</Button></DialogActions></Dialog>
  </Stack>;
}
