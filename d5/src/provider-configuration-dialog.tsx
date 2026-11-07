import { useState } from "react";
import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, InputAdornment, MenuItem, Stack, TextField, Typography } from "@mui/material";
import Close from "@mui/icons-material/Close";
import Visibility from "@mui/icons-material/Visibility";
import VisibilityOff from "@mui/icons-material/VisibilityOff";
import { ParameterEditor } from "./parameter-editor";
import { validateParameters, type ApiParameter } from "./api-parameters";
import { validateEndpoint, type BuiltinEndpointId } from "./provider-endpoints";

export type ProviderDraft = { id: string; name: string; endpoint: string; key: string; model: string; models: string[]; parameters: ApiParameter[]; builtin: boolean };

export function ProviderConfigurationDialog({ draft, onChange, onClose, onSave, onDelete, onVerify, status, onDiscover, originalEndpoint }: {
  draft: ProviderDraft; onChange: (draft: ProviderDraft) => void; onClose: () => void; onSave: () => void;
  onDelete?: () => void; onVerify?: () => void; status: string; onDiscover?: () => void; originalEndpoint?: string;
}) {
  const [visible, setVisible] = useState(false);
  const [modelInput, setModelInput] = useState("");
  let validEndpoint = false;
  try { const url = new URL(draft.endpoint); validEndpoint = url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash; } catch { /* Invalid URL. */ }
  const endpointError = draft.builtin ? validateEndpoint(draft.id as BuiltinEndpointId, draft.endpoint) : undefined;
  if (endpointError) validEndpoint = false;
  const error = validateParameters(draft.parameters);
  return <Dialog open onClose={onClose} fullWidth maxWidth="md" scroll="paper">
    <DialogTitle>{draft.name || "Custom Provider"}<IconButton aria-label="Close provider settings" onClick={onClose} sx={{ float: "right" }}><Close /></IconButton></DialogTitle>
    <DialogContent><Stack spacing={2} sx={{ pt: 1 }}>
      <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
        <TextField fullWidth required label="Provider Name" value={draft.name} onChange={(e) => onChange({ ...draft, name: e.target.value })} slotProps={{ input: { readOnly: draft.builtin } }} />
        <Box sx={{ width: "100%" }}><TextField fullWidth required label="Endpoint URL" value={draft.endpoint} onChange={(e) => onChange({ ...draft, endpoint: e.target.value })} error={!!endpointError} helperText={endpointError ?? (draft.id === "gemini" ? "For future use; execution is unavailable." : "HTTPS URL without credentials, query, or fragment.")} />
        {originalEndpoint && <Button size="small" disabled={draft.endpoint === originalEndpoint} onClick={() => onChange({ ...draft, endpoint: originalEndpoint })}>Restore Original Endpoint</Button>}</Box>
      </Stack>
      <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
        <TextField fullWidth label="API Key" type={visible ? "text" : "password"} autoComplete="off" value={draft.key} onChange={(e) => onChange({ ...draft, key: e.target.value })} helperText="Stored in memory only." slotProps={{ input: { endAdornment: <InputAdornment position="end"><IconButton aria-label={visible ? "Hide API key" : "Show API key"} onClick={() => setVisible(!visible)}>{visible ? <VisibilityOff /> : <Visibility />}</IconButton></InputAdornment> } }} />
        <Button variant="outlined" onClick={onVerify} disabled={!onVerify || !draft.key.trim() || !draft.model}>Verify</Button>
      </Stack>
      <Alert severity={status === "Verified" ? "success" : status.startsWith("Verification failed") ? "error" : "info"}>{status}</Alert>
      <Stack direction={{ xs: "column", md: "row" }} spacing={3}>
        <Box sx={{ minWidth: { md: 220 }, maxWidth: { md: 280 }, flex: 1 }}>
          <Typography variant="h6">Models</Typography>
          {draft.builtin ? <TextField select fullWidth size="small" label="Model" value={draft.model} onChange={(e) => onChange({ ...draft, model: e.target.value })} sx={{ mt: 1 }}>
            <MenuItem value="">Select a model</MenuItem>{draft.models.map((id) => <MenuItem key={id} value={id}>{id}</MenuItem>)}
          </TextField> : <><Stack>{draft.models.map((id) => <Button key={id} onClick={() => onChange({ ...draft, model: id })} variant={draft.model === id ? "contained" : "text"}>{id}</Button>)}</Stack>
            <TextField size="small" label="Model ID" value={modelInput} onChange={(e) => setModelInput(e.target.value)} sx={{ mt: 1 }} />
            <Button disabled={!modelInput.trim() || draft.models.includes(modelInput.trim())} onClick={() => { const id = modelInput.trim(); onChange({ ...draft, model: id, models: [...draft.models, id] }); setModelInput(""); }}>Add Model</Button></>}
          {onDiscover && <Button onClick={onDiscover}>Discover capabilities</Button>}
        </Box>
        <Box sx={{ minWidth: 0, flex: 2 }}><Typography variant="h6">Parameter templates</Typography><Typography variant="body2">Optional templates for the selected model. Templates are not sent or copied to experts. Configure experimental parameters on each expert.</Typography><ParameterEditor parameters={draft.parameters} onChange={(parameters) => onChange({ ...draft, parameters })} />{!draft.model && draft.parameters.length > 0 && <Alert severity="info">Select a model before saving a template.</Alert>}</Box>
      </Stack>
    </Stack></DialogContent>
    <DialogActions sx={{ p: 2, justifyContent: "space-between", flexWrap: "wrap" }}><Button color="error" onClick={onDelete} disabled={!onDelete}>Delete</Button><Box><Button onClick={onClose}>Cancel</Button><Button variant="contained" onClick={onSave} disabled={!draft.name.trim() || !validEndpoint || !!error || (!draft.model && draft.parameters.length > 0)}>Save</Button></Box></DialogActions>
  </Dialog>;
}
