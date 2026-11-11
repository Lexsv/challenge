import { CredentialIndicator, credentialStatusFromText } from "./credential-indicator";
import type { SavedCredentialStatus } from "./saved-credentials";
import { useState } from "react";
import { Accordion, AccordionDetails, AccordionSummary, Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, InputAdornment, MenuItem, Stack, TextField, Typography } from "@mui/material";
import Close from "@mui/icons-material/Close";
import ExpandMore from "@mui/icons-material/ExpandMore";
import SettingsOutlined from "@mui/icons-material/SettingsOutlined";
import Visibility from "@mui/icons-material/Visibility";
import VisibilityOff from "@mui/icons-material/VisibilityOff";
import { ParameterEditor } from "./parameter-editor";
import { validateParameters, type ApiParameter } from "./api-parameters";
import { validateEndpoint, consoleConfiguredEndpoint, type BuiltinEndpointId } from "./provider-endpoints";

export type ProviderDraft = { id: string; name: string; endpoint: string; key: string; model: string; models: string[]; parameters: ApiParameter[]; builtin: boolean };

export function ProviderConfigurationDialog({ draft, onChange, onClose, onSave, onDelete, onVerify, status, onDiscover, isVerifying = false, hasSavedKey = false, credentialStatus }: {
  draft: ProviderDraft; onChange: (draft: ProviderDraft) => void; onClose: () => void; onSave: () => void;
  onDelete?: () => void; onVerify?: () => void; status: string; onDiscover?: () => void; isVerifying?: boolean; hasSavedKey?: boolean; credentialStatus?: SavedCredentialStatus;
}) {
  const [visible, setVisible] = useState(false);
  const [modelInput, setModelInput] = useState("");
  let validEndpoint = false;
  try { const url = new URL(draft.endpoint); validEndpoint = url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash; } catch { /* Invalid URL. */ }
  let endpointError: string | undefined;
  try { endpointError = draft.builtin ? validateEndpoint(draft.id as BuiltinEndpointId, draft.id === "opencode-console" ? consoleConfiguredEndpoint(draft.endpoint) : draft.endpoint) : undefined; }
  catch { endpointError = "Use a valid HTTPS base URL with the path /inference."; }
  if (endpointError) validEndpoint = false;
  const error = validateParameters(draft.parameters);

  return <Dialog open onClose={onClose} fullWidth maxWidth="md" scroll="paper" slotProps={{ paper: { sx: { borderRadius: "16px" } } }}>
    <DialogTitle sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontWeight: 700, gap: 2 }}>
      <Box component="span" sx={{ overflowWrap: "anywhere" }}>{draft.name || "Custom Provider"}</Box><IconButton aria-label="Close provider settings" onClick={onClose}><Close /></IconButton>
    </DialogTitle>
    <DialogContent><Stack spacing={2.5} sx={{ pt: 1 }}>
      <TextField select fullWidth required={draft.id !== "opencode-console"} size="small" label="Model" value={draft.model} onChange={(e) => onChange({ ...draft, model: e.target.value })}>
        <MenuItem value="">Select a model</MenuItem>{draft.model && !draft.models.includes(draft.model) && <MenuItem value={draft.model} disabled>{draft.model} (previously selected; unavailable)</MenuItem>}{draft.models.map((id) => <MenuItem key={id} value={id}>{id}</MenuItem>)}
      </TextField>
      <Stack direction={{ xs: "column", sm: "row" }} spacing={2} alignItems="flex-start">
        <TextField fullWidth label="API Key" type={visible ? "text" : "password"} autoComplete="off" value={draft.key} onChange={(e) => onChange({ ...draft, key: e.target.value })} helperText={draft.builtin && ["openai", "opencode-console"].includes(draft.id) ? "Verify saves an accepted key in this Mac’s Keychain. Saved keys are never displayed. Console checks may use tokens." : "Stored in memory only."} slotProps={{ input: { endAdornment: <InputAdornment position="end"><IconButton aria-label={visible ? "Hide API key" : "Show API key"} onClick={() => setVisible(!visible)}>{visible ? <VisibilityOff /> : <Visibility />}</IconButton></InputAdornment> } }} />
        <Button variant="contained" size="small" onClick={onVerify} disabled={!onVerify || (!draft.key.trim() && !hasSavedKey) || (draft.id !== "opencode-console" && !draft.model) || isVerifying} sx={{ flexShrink: 0 }}>Verify</Button>
      </Stack>
      <Stack direction={{ xs: "column", sm: "row" }} gap={1} justifyContent="space-between" alignItems={{ sm: "center" }}>
        <Box sx={{ minWidth: 0 }}><CredentialIndicator provider={draft.name} showProvider={false} status={isVerifying ? { saved: hasSavedKey, verification: 'checking' } : credentialStatus ?? credentialStatusFromText(status, hasSavedKey)} /></Box>
      </Stack>
      {error && <Alert severity="error">Check the parameter templates in Advanced settings.</Alert>}
      <Accordion disableGutters elevation={0} sx={{ borderTop: 1, borderColor: "divider", "&:before": { display: "none" } }}>
        <AccordionSummary expandIcon={<ExpandMore />} aria-controls="provider-advanced-content" id="provider-advanced-heading" sx={{ px: 0 }}><SettingsOutlined sx={{ mr: 1.5 }} /><Typography fontWeight={700}>Advanced settings</Typography></AccordionSummary>
        <AccordionDetails sx={{ p: { xs: 1, sm: 2 }, border: 1, borderColor: "divider", borderRadius: 2 }}><Stack spacing={2}>
          <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
            <TextField fullWidth required label="Provider Name" value={draft.name} onChange={(e) => onChange({ ...draft, name: e.target.value })} slotProps={{ input: { readOnly: draft.builtin } }} />
            <TextField fullWidth required label={draft.id === "opencode-console" ? "Base URL" : "Endpoint URL"} value={draft.endpoint} onChange={(e) => onChange({ ...draft, endpoint: e.target.value })} error={!!endpointError} helperText={endpointError ?? (draft.id === "gemini" ? "For future use; execution is unavailable." : "HTTPS URL without credentials, query, or fragment.")} />
          </Stack>
          {!draft.builtin && <Stack direction={{ xs: "column", sm: "row" }} spacing={1}><TextField size="small" fullWidth label="Model ID" value={modelInput} onChange={(e) => setModelInput(e.target.value)} /><Button disabled={!modelInput.trim() || draft.models.includes(modelInput.trim())} onClick={() => { const id = modelInput.trim(); onChange({ ...draft, model: id, models: [...draft.models, id] }); setModelInput(""); }}>Add Model</Button></Stack>}
          {draft.id !== "opencode-console" && onDiscover && <Box><Button onClick={onDiscover}>Discover capabilities</Button></Box>}
          <Box sx={{ minWidth: 0 }}><Typography variant="h6">Parameter templates</Typography><Typography variant="body2">Optional templates for the selected model. Templates are not sent or copied to experts. Configure experimental parameters on each expert.</Typography><ParameterEditor parameters={draft.parameters} onChange={(parameters) => onChange({ ...draft, parameters })} />{!draft.model && draft.parameters.length > 0 && <Alert severity="info">Select a model before saving a template.</Alert>}</Box>
        </Stack></AccordionDetails>
      </Accordion>
    </Stack></DialogContent>
    <DialogActions sx={{ p: 2, justifyContent: "space-between", flexWrap: "wrap", gap: 1 }}><Button color="error" onClick={onDelete} disabled={!onDelete}>Forget key</Button><Box><Button onClick={onClose}>Cancel</Button><Button variant="contained" onClick={onSave} disabled={!draft.name.trim() || !validEndpoint || !!error || (!draft.model && draft.parameters.length > 0) || isVerifying}>Save</Button></Box></DialogActions>
  </Dialog>;
}
