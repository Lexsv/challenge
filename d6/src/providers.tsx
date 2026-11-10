import { useEffect, useRef, useState, type ReactNode } from "react";
import { Alert, Box, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, List, ListItemButton, ListItemIcon, ListItemText, MenuItem, Paper, Stack, Tabs, Tab, TextField, Typography } from "@mui/material";
import StorageOutlined from "@mui/icons-material/StorageOutlined";
import Refresh from "@mui/icons-material/Refresh";
import SettingsOutlined from "@mui/icons-material/SettingsOutlined";
import { ProviderModelTable, type ModelView } from "./provider-model-table";
import { ProviderConfigurationDialog, type ProviderDraft } from "./provider-configuration-dialog";
import { createProviderRegistry, type ProviderRegistry } from "./provider-registry";
import { INFERENCE_ENDPOINTS } from "./opencode-adapter";
import { verificationError, verifyOpenCode } from "./builtin-connection-settings";
import type { Adapter } from "./provider-contract";
import { verificationSettings } from "./openai-model-compat";
import { validateParameters, type ApiParameter } from "./api-parameters";
import { ParameterEditor } from "./parameter-editor";
import type { VerificationStatus } from "./connection";
import { deleteTemplates, openTemplates, saveTemplates, switchTemplateModel } from "./provider-template-state";
import { DEFAULT_ENDPOINTS, consoleBaseEndpoint, consoleConfiguredEndpoint } from "./provider-endpoints";
import { consoleVerificationPlan, selectConsoleVerificationPlan, verifyConsoleModel } from "./opencode-console-verification";
import { consoleStatusKind } from "./console-verification-status";
import { type VerificationKind } from "./verification-chip";
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
function ProviderParameterSettings({ models, selectedModel, templates, onSave }: {
  models: readonly string[];
  selectedModel: string;
  templates: Record<string, ApiParameter[]>;
  onSave: (model: string, rows: ApiParameter[]) => void;
}) {
  const [modelOverride, setModelOverride] = useState<string>();
  const [draftRows, setDraftRows] = useState<ApiParameter[] | null>(null);
  const model = modelOverride ?? selectedModel;
  const rows = draftRows ?? templates[model] ?? [];
  const options = model && !models.includes(model) ? [model, ...models] : models;

  return (
    <Stack spacing={1.5} sx={{ minWidth: 0 }}>
      <Typography variant="h6" component="h3">API Parameters</Typography>
      <TextField
        select
        label="Template model"
        value={model}
        disabled={!options.length || draftRows !== null}
        sx={{ maxWidth: 420 }}
        onChange={(event) => {
          setModelOverride(event.target.value);
        }}
      >
        <MenuItem value="" disabled>Select a model</MenuItem>
        {options.map((id) => <MenuItem key={id} value={id}>{id}</MenuItem>)}
      </TextField>
      {model ? (
        <>
          <ParameterEditor parameters={rows} onChange={setDraftRows} />
          <Stack direction="row" spacing={1} justifyContent="flex-end">
            <Button disabled={!draftRows} onClick={() => setDraftRows(null)}>Cancel</Button>
            <Button variant="contained" disabled={!draftRows || !!validateParameters(rows)} onClick={() => {
              onSave(model, rows);
              setDraftRows(null);
            }}>Save parameters</Button>
          </Stack>
        </>
      ) : <Typography color="text.secondary">Select a model to edit its parameter template.</Typography>}
    </Stack>
  );
}

export function Providers({ model, verification, openAISettings: _oldOpenAISettings, openCodeSettings: _oldOpenCodeSettings, registry: suppliedRegistry, keys, onSaveBuiltin, adapter, referencedProviders = [], onDiscovery, onConsoleStatusChange }: {
  model: string; verification: VerificationStatus; openAISettings?: ReactNode; openCodeSettings?: ReactNode; openAIKeyPresent?: boolean;
  registry?: ProviderRegistry; keys?: Record<BuiltinId, string>; onSaveBuiltin?: (id: BuiltinId, key: string, model: string, verified: boolean) => void;
  adapter?: Adapter; referencedProviders?: string[]; onDiscovery?: () => void; onConsoleStatusChange?: (value: { kind: VerificationKind; unsaved: boolean }) => void;
}) {
  const [registry] = useState(() => suppliedRegistry ?? createProviderRegistry());
  const [providers, setProviders] = useState(readProviders);
  const [selectedId, setSelectedId] = useState("openai");
  const [view, setView] = useState<ModelView | "settings">("models");
  const [refreshing, setRefreshing] = useState(false);
  const refreshFlight = useRef(false);
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
  const saveCustomProvider = (provider: CustomProvider) =>
    persist([...providers.filter((entry) => entry.id !== provider.id), provider]);
  const close = () => { version.current++; setDraft(null); setConfirmDelete(false); setConfirmEndpoint(false); };
  const configuredEndpoint = (id: string, endpoint: string) => {
    try { return id === "opencode-console" ? consoleConfiguredEndpoint(endpoint) : endpoint; } catch { return ""; }
  };
  const openBuiltin = (id: BuiltinId, requestedModel?: string) => {
    const provider = builtins.find((p) => p.id === id)!;
    const savedModel = id === "openai" ? model : (savedModels[id] ?? "");
    const chosen = requestedModel ?? savedModel;
    const params = openTemplates(savedParameters, id);
    setParameterMap(params);
    setDraft({ ...provider, endpoint: id === "opencode-console" ? consoleBaseEndpoint(registry.endpointFor(id) ?? provider.endpoint) : registry.endpointFor(id) ?? provider.endpoint, builtin: true, key: keys?.[id] ?? "", model: chosen, models: [...registry.modelOptionsFor(id)], parameters: params[chosen] ?? [] });
    const unverifiedStatus = id === "opencode-console" ? "Authentication: not checked. Model: not checked." : "Not verified";
    const savedStatus = statuses[id] ?? (id === "openai" && verification === "verified" ? "Verified" : unverifiedStatus);
    setStatus(id === "opencode-console" || chosen === savedModel ? savedStatus : unverifiedStatus);
  };
  const openCustom = (provider?: CustomProvider, requestedModel?: string) => {
    const p = provider ?? { id: crypto.randomUUID(), name: "", endpoint: "", key: "", models: [] };
    const chosen = requestedModel ?? p.models[0]?.id ?? "";
    const params = Object.fromEntries(p.models.map((m) => [m.id, structuredClone(m.parameters)]));
    setParameterMap(params);
    setDraft({ id: p.id, name: p.name, endpoint: p.endpoint, key: p.key, model: chosen, models: p.models.map((m) => m.id), parameters: params[chosen] ?? [], builtin: false });
    setStatus("Custom provider verification and execution are unavailable.");
  };
  const changeDraft = (next: ProviderDraft) => {
    if (!draft) return;
    const connectionChanged = next.key !== draft.key || next.endpoint !== draft.endpoint;
    const verifiedModelChanged = next.id !== "opencode-console" && next.model !== draft.model;
    if (connectionChanged || verifiedModelChanged) {
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
      setSelectedId(draft.id);
      saveCustomProvider({ id: draft.id, name: draft.name, endpoint: draft.endpoint, key: draft.key, models: draft.models.map((id) => ({ id, parameters: params[id] ?? [] })) });
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
      const applyResult = (result: string) => {
        if (version.current !== current) return;
        setStatus(result);
        if (
          selected.id === "opencode-console" &&
          selected.key === keys?.["opencode-console"] &&
          endpoint === registry.endpointFor(selected.id) &&
          consoleStatusKind(result) !== "verified"
        ) {
          // A failed recheck of the saved connection also applies after closing the draft.
          setStatuses((saved) => ({ ...saved, [selected.id]: result }));
        }
      };
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
        applyResult(result);
      } catch {
        applyResult("Verification could not be completed. Check catalog availability and connection settings, then try again.");
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
    } else {
      persist(providers.filter((p) => p.id !== draft.id));
      setSelectedId("openai");
    }
    close();
  };
  const savedConsoleStatus = statuses["opencode-console"] ?? "Authentication: not checked. Model: not checked.";
  const consoleDraft = draft?.id === "opencode-console" ? draft : null;
  const consoleUnsaved = !!consoleDraft && (status !== savedConsoleStatus || consoleDraft.key !== (keys?.["opencode-console"] ?? "") || consoleDraft.model !== (savedModels["opencode-console"] ?? "") || configuredEndpoint(consoleDraft.id, consoleDraft.endpoint) !== registry.endpointFor("opencode-console"));
  const consoleKind = consoleStatusKind(consoleDraft ? status : savedConsoleStatus);
  useEffect(() => { onConsoleStatusChange?.({ kind: consoleKind, unsaved: consoleUnsaved }); }, [consoleKind, consoleUnsaved, onConsoleStatusChange]);
  const selectedBuiltin = builtins.find((provider) => provider.id === selectedId);
  const selectedCustom = providers.find((provider) => provider.id === selectedId);
  const selectedModel = selectedCustom
    ? selectedCustom.models[0]?.id ?? ""
    : selectedId === "openai" ? model : savedModels[selectedId] ?? "";
  const modelIds = selectedBuiltin ? registry.modelOptionsFor(selectedId) : selectedCustom?.models.map((entry) => entry.id) ?? [];
  const openSelected = (requestedModel?: string) => {
    if (selectedBuiltin) openBuiltin(selectedBuiltin.id, requestedModel);
    else if (selectedCustom) openCustom(selectedCustom, requestedModel);
  };
  const refreshModels = async () => {
    const discoverModels = registry.get("opencode-console")?.discover;
    if (!discoverModels || refreshFlight.current) return;
    refreshFlight.current = true;
    setRefreshing(true);
    const endpoint = registry.endpointFor("opencode-console");
    try {
      const models = await discoverModels();
      if (endpoint !== registry.endpointFor("opencode-console")) return;
      onDiscovery?.();
      setConsoleCatalogStatus(`Catalog available: ${models.length} discovered models. Authentication was not checked.`);
    } catch {
      if (endpoint === registry.endpointFor("opencode-console")) setConsoleCatalogStatus("Catalog discovery failed. Authentication was not checked.");
    } finally {
      refreshFlight.current = false;
      setRefreshing(false);
    }
  };
  const connection = selectedBuiltin ?? selectedCustom;
  const isConsole = selectedId === "opencode-console";
  const verified = isConsole
    ? consoleStatusKind(savedConsoleStatus) === "verified"
    : selectedId === "openai" && verification === "verified";
  const badgeLabel = verified ? "Verified" : "Not verified";
  const configuredUrl = registry.endpointFor(selectedId) ?? connection?.endpoint ?? "";
  const endpoint = isConsole
    ? consoleVerificationPlan(selectedModel, configuredUrl)?.endpoint ?? configuredUrl
    : configuredUrl;
  const templates = selectedCustom
    ? Object.fromEntries(selectedCustom.models.map(({ id, parameters }) => [id, parameters]))
    : savedParameters[selectedId] ?? {};
  const saveParameterTemplate = (modelId: string, rows: ApiParameter[]) => {
    if (selectedCustom) {
      saveCustomProvider({
        ...selectedCustom,
        models: selectedCustom.models.map((entry) =>
          entry.id === modelId ? { ...entry, parameters: structuredClone(rows) } : entry,
        ),
      });
    } else if (selectedBuiltin) {
      setSavedParameters((current) =>
        saveTemplates(current, selectedId, current[selectedId] ?? {}, modelId, rows),
      );
    }
  };

  return <Stack spacing={2}>
    {storageWarning && <Alert severity="warning">Custom provider settings could not be retained across reloads.</Alert>}
    <Box sx={{ display: "grid", gridTemplateColumns: { xs: "minmax(0, 1fr)", md: "minmax(210px, 1fr) minmax(0, 3.4fr)" }, gap: 2, alignItems: "start" }}>
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Typography variant="h6" component="h2">Providers ({builtins.length + providers.length})</Typography>
        <List aria-label="Providers" sx={{ my: 0.5 }}>
          {[...builtins, ...providers].map((provider) => (
            <ListItemButton key={provider.id} selected={selectedId === provider.id} onClick={() => { setSelectedId(provider.id); setView("models"); }} sx={{ borderRadius: 1.5, mb: 0.5 }}>
              <ListItemIcon sx={{ minWidth: 34 }}><StorageOutlined color="primary" fontSize="small" /></ListItemIcon>
              <ListItemText primary={provider.name} secondary={provider.id === "opencode-console" && selectedId !== provider.id ? (consoleKind === "unchecked" ? "Not verified" : undefined) : undefined} sx={{ overflowWrap: "anywhere" }} />
            </ListItemButton>
          ))}
        </List>
      </Paper>
      <Stack spacing={2} sx={{ minWidth: 0 }}>
        <Typography variant="h4" component="h2">Providers</Typography>
        {connection && <Paper variant="outlined" sx={{ p: 2.5 }}>
          <Stack spacing={1}>
            <Stack direction="row" justifyContent="space-between" alignItems="center" gap={1}>
              <Typography variant="h5" component="h3" sx={{ overflowWrap: "anywhere" }}>{connection.name}</Typography>
              <IconButton size="small" aria-label={`Open ${connection.name} settings`} onClick={() => openSelected()}>
                <SettingsOutlined fontSize="small" />
              </IconButton>
            </Stack>
            <Box>
              <Chip size="small" role="status" aria-label={`${connection.name}: ${badgeLabel}`}
                label={badgeLabel} color={verified ? "success" : "default"} variant={verified ? "filled" : "outlined"} />
            </Box>
            <Typography variant="body2" sx={{ overflowWrap: "anywhere" }}>Model: {selectedModel || "No model selected"}</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: "anywhere" }}>{endpoint}</Typography>
          </Stack>
        </Paper>}
        <Paper variant="outlined" sx={{ minWidth: 0 }}>
          <Stack direction={{ xs: "column", sm: "row" }} alignItems={{ sm: "center" }}
            gap={{ xs: 0.5, sm: 1 }} sx={{ borderBottom: 1, borderColor: "divider" }}>
            <Tabs value={view} onChange={(_, next: ModelView | "settings") => setView(next)} aria-label="Provider details" variant="scrollable" scrollButtons={false} sx={{ minWidth: 0, flex: { sm: 1 } }}>
              <Tab id="provider-models-tab" aria-controls="provider-detail" value="models" label={`Models (${modelIds.length})`} />
              <Tab id="provider-pricing-tab" aria-controls="provider-detail" value="pricing" label="Pricing" />
              <Tab id="provider-limits-tab" aria-controls="provider-detail" value="limits" label="Limits" />
              <Tab id="provider-settings-tab" aria-controls="provider-detail" value="settings" label="Settings" />
            </Tabs>
            {isConsole && view === "models" && (
              <Button size="small" startIcon={<Refresh />} variant="outlined" disabled={refreshing}
                onClick={() => void refreshModels()} sx={{ alignSelf: "flex-end", m: 1, flexShrink: 0 }}>
                {refreshing ? "Refreshing…" : "Refresh Models"}
              </Button>
            )}
          </Stack>
          <Box role="tabpanel" id="provider-detail" aria-labelledby={`provider-${view}-tab`} sx={{ p: { xs: 1, sm: 2 }, minWidth: 0 }}>
            {isConsole && view === "models" && consoleCatalogStatus.startsWith("Catalog discovery failed") && (
              <Alert severity="warning" sx={{ mb: 1 }}>Could not refresh models.</Alert>
            )}
            {view === "settings" ? (
              <ProviderParameterSettings
                key={selectedId}
                models={modelIds}
                selectedModel={selectedModel}
                templates={templates}
                onSave={saveParameterTemplate}
              />
            ) : <ProviderModelTable ids={modelIds} provider={selectedId} selectedModel={selectedModel} view={view} registry={registry} onConfigure={openSelected} />}
          </Box>
        </Paper>
      </Stack>
    </Box>
    {draft && <ProviderConfigurationDialog key={draft.id} draft={draft} onChange={changeDraft} onClose={close} onSave={() => save()} status={draft.builtin && configuredEndpoint(draft.id, draft.endpoint) !== registry.endpointFor(draft.id) ? "Save the endpoint before verification or discovery." : status} onDelete={draft.builtin || providers.some((p) => p.id === draft.id) ? () => setConfirmDelete(true) : undefined} isVerifying={isVerifying} onVerify={draft.builtin && draft.id !== "gemini" && configuredEndpoint(draft.id, draft.endpoint) === registry.endpointFor(draft.id) ? requestVerify : undefined} onDiscover={(draft.id === "opencode-console" || draft.id === "opencode-go") && configuredEndpoint(draft.id, draft.endpoint) === registry.endpointFor(draft.id) ? () => void discover() : undefined} />}
    <Dialog open={confirmEndpoint} onClose={() => setConfirmEndpoint(false)}><DialogTitle>Confirm custom endpoint</DialogTitle><DialogContent><Typography>Requests for {draft?.name} will send its API credential to {draft?.endpoint}. Confirm only if you trust this destination.</Typography></DialogContent><DialogActions><Button onClick={() => setConfirmEndpoint(false)}>Cancel</Button><Button onClick={() => save(true)}>Confirm endpoint</Button></DialogActions></Dialog>
    <Dialog open={confirmDelete} onClose={() => setConfirmDelete(false)}><DialogTitle>Delete provider configuration?</DialogTitle><DialogContent><Typography>{draft?.builtin ? "This clears its user configuration; the built-in provider remains available." : "This removes the saved custom provider."} {draft && referencedProviders.includes(draft.id) ? "Existing experts reference this provider and will not be reassigned." : "Existing experts will not be reassigned."}</Typography></DialogContent><DialogActions><Button onClick={() => setConfirmDelete(false)}>Cancel</Button><Button color="error" onClick={remove}>Delete</Button></DialogActions></Dialog>
  </Stack>;
}
