import { useState, type ReactNode } from "react";
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  InputAdornment,
  Paper,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import Add from "@mui/icons-material/Add";
import Close from "@mui/icons-material/Close";
import Visibility from "@mui/icons-material/Visibility";
import VisibilityOff from "@mui/icons-material/VisibilityOff";
import { ParameterEditor } from "./parameter-editor";
import { validateParameters, type ApiParameter } from "./api-parameters";
import type { VerificationStatus } from "./connection";

type ProviderModel = { id: string; parameters: ApiParameter[] };
type CustomProvider = {
  id: string;
  name: string;
  endpoint: string;
  key: string;
  models: ProviderModel[];
};
const STORAGE = "expert-lab:d5:custom-providers";
function readProviders(): CustomProvider[] {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(STORAGE) || "[]");
    return Array.isArray(value)
      ? value.filter(
          (p): p is CustomProvider =>
            !!p &&
            typeof p.id === "string" &&
            typeof p.name === "string" &&
            typeof p.endpoint === "string" &&
            typeof p.key === "string" &&
            Array.isArray(p.models),
        )
      : [];
  } catch {
    return [];
  }
}
export function Providers({
  model,
  verification,
  openAISettings,
}: {
  model: string;
  verification: VerificationStatus;
  openAISettings: ReactNode;
}) {
  const [providers, setProviders] = useState(readProviders);
  const [openAI, setOpenAI] = useState(false);
  const [draft, setDraft] = useState<CustomProvider | null>(null);
  const [selected, setSelected] = useState(0);
  const [newModel, setNewModel] = useState("");
  const [visible, setVisible] = useState(false);
  const [warning, setWarning] = useState(false);
  const openDraft = (p: CustomProvider) => {
    setDraft(structuredClone(p));
    setSelected(0);
    setNewModel("");
    setVisible(false);
  };
  const add = () =>
    openDraft({
      id: crypto.randomUUID(),
      name: "",
      endpoint: "",
      key: "",
      models: [],
    });
  const setModels = (models: ProviderModel[]) =>
    draft && setDraft({ ...draft, models });
  const addModel = () => {
    const id = newModel.trim();
    if (!draft || !id || draft.models.some((m) => m.id === id)) return;
    setModels([...draft.models, { id, parameters: [] }]);
    setSelected(draft.models.length);
    setNewModel("");
  };
  let validEndpoint = false;
  try {
    const url = new URL(draft?.endpoint || "");
    validEndpoint =
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash;
  } catch {
    /* Invalid endpoint. */
  }
  const error = draft?.models
    .map((m) => validateParameters(m.parameters))
    .find(Boolean);
  const save = () => {
    if (!draft || !draft.name.trim() || !validEndpoint || error) return;
    const next = [...providers.filter((p) => p.id !== draft.id), draft];
    setProviders(next);
    try {
      sessionStorage.setItem(STORAGE, JSON.stringify(next));
      setWarning(false);
    } catch {
      setWarning(true);
    }
    setDraft(null);
    setVisible(false);
  };
  return (
    <Stack spacing={2}>
      <Stack
        direction={{ xs: "column", sm: "row" }}
        spacing={1}
        justifyContent="space-between"
        alignItems={{ xs: "flex-start", sm: "center" }}
      >
        <Box>
          <Typography variant="h5" component="h2">
            Providers
          </Typography>
          <Typography color="text.secondary">
            Manage providers, endpoints, models and default parameters.
          </Typography>
        </Box>
        <Button variant="contained" startIcon={<Add />} onClick={add}>
          Add Provider
        </Button>
      </Stack>
      {warning && (
        <Alert severity="warning">
          Provider settings could not be retained across reloads and are
          available in memory only.
        </Alert>
      )}
      <Paper variant="outlined" sx={{ p: 2, borderColor: "primary.main" }}>
        <Stack
          direction={{ xs: "column", sm: "row" }}
          justifyContent="space-between"
          spacing={1}
        >
          <Box sx={{ overflowWrap: "anywhere" }}>
            <Stack direction="row" spacing={1} alignItems="center">
              <Typography variant="h6">OpenAI</Typography>
              <Chip size="small" label="Default" />
            </Stack>
            <Typography>
              {verification === "verified"
                ? "Verified"
                : verification === "failed"
                  ? "Verification failed"
                  : verification === "verifying"
                    ? "Verifying"
                    : "Not verified"}
            </Typography>
            <Typography>https://api.openai.com/v1</Typography>
            <Typography variant="body2">Model: {model}</Typography>
          </Box>
          <Button variant="outlined" onClick={() => setOpenAI(true)}>
            Configure
          </Button>
        </Stack>
      </Paper>
      {providers.map((p) => (
        <Paper variant="outlined" sx={{ p: 2 }} key={p.id}>
          <Stack
            direction={{ xs: "column", sm: "row" }}
            justifyContent="space-between"
            spacing={1}
          >
            <Box sx={{ overflowWrap: "anywhere" }}>
              <Typography variant="h6">{p.name}</Typography>
              <Typography>Not verified</Typography>
              <Typography>{p.endpoint}</Typography>
              <Typography variant="body2">
                Models: {p.models.map((m) => m.id).join(", ") || "None"}
              </Typography>
            </Box>
            <Button variant="outlined" onClick={() => openDraft(p)}>
              Configure
            </Button>
          </Stack>
        </Paper>
      ))}
      <Dialog
        open={openAI}
        onClose={() => setOpenAI(false)}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>
          OpenAI{" "}
          <IconButton
            aria-label="Close OpenAI settings"
            onClick={() => setOpenAI(false)}
            sx={{ float: "right" }}
          >
            <Close />
          </IconButton>
        </DialogTitle>
        <DialogContent>{openAISettings}</DialogContent>
        <DialogActions>
          <Button onClick={() => setOpenAI(false)}>Close</Button>
        </DialogActions>
      </Dialog>
      <Dialog
        open={!!draft}
        onClose={() => {
          setDraft(null);
          setVisible(false);
        }}
        fullWidth
        maxWidth="md"
        scroll="paper"
      >
        <DialogTitle>
          Custom Provider{" "}
          <IconButton
            aria-label="Close custom provider"
            onClick={() => setDraft(null)}
            sx={{ float: "right" }}
          >
            <Close />
          </IconButton>
        </DialogTitle>
        {draft && (
          <DialogContent>
            <Stack spacing={2} sx={{ pt: 1 }}>
              <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
                <TextField
                  fullWidth
                  required
                  label="Provider Name"
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
                <TextField
                  fullWidth
                  required
                  label="Endpoint URL"
                  value={draft.endpoint}
                  onChange={(e) =>
                    setDraft({ ...draft, endpoint: e.target.value })
                  }
                  helperText="HTTPS URL without credentials, query, or fragment."
                />
              </Stack>
              <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
                <TextField
                  fullWidth
                  label="API Key"
                  type={visible ? "text" : "password"}
                  value={draft.key}
                  onChange={(e) => setDraft({ ...draft, key: e.target.value })}
                  autoComplete="off"
                  helperText="Stored in this tab's session storage, which is not a secure vault."
                  slotProps={{
                    input: {
                      endAdornment: (
                        <InputAdornment position="end">
                          <IconButton
                            aria-label={
                              visible ? "Hide API key" : "Show API key"
                            }
                            onClick={() => setVisible(!visible)}
                          >
                            {visible ? <VisibilityOff /> : <Visibility />}
                          </IconButton>
                        </InputAdornment>
                      ),
                    },
                  }}
                />
                <Button variant="outlined" disabled>
                  Verify Connection
                </Button>
              </Stack>
              <Alert severity="info">
                Custom provider verification and execution are not available
                yet. No credentials are sent to custom endpoints.
              </Alert>
              <Stack direction={{ xs: "column", md: "row" }} spacing={3}>
                <Box sx={{ minWidth: { md: 210 } }}>
                  <Typography variant="h6">Models</Typography>
                  <Stack spacing={0.5}>
                    {draft.models.map((m, i) => (
                      <Button
                        key={m.id}
                        variant={selected === i ? "contained" : "text"}
                        onClick={() => setSelected(i)}
                        sx={{
                          justifyContent: "start",
                          overflowWrap: "anywhere",
                        }}
                      >
                        {m.id}
                      </Button>
                    ))}
                  </Stack>
                  <TextField
                    size="small"
                    label="Model ID"
                    value={newModel}
                    onChange={(e) => setNewModel(e.target.value)}
                    sx={{ mt: 1 }}
                  />
                  <Button
                    startIcon={<Add />}
                    onClick={addModel}
                    disabled={
                      !newModel.trim() ||
                      draft.models.some((m) => m.id === newModel.trim())
                    }
                  >
                    Add Model
                  </Button>
                </Box>
                <Box sx={{ minWidth: 0, flex: 1 }}>
                  <Typography variant="h6">
                    Default Parameters
                    {draft.models[selected]
                      ? ` (${draft.models[selected].id})`
                      : ""}
                  </Typography>
                  {draft.models[selected] ? (
                    <ParameterEditor
                      parameters={draft.models[selected].parameters}
                      onChange={(parameters) =>
                        setModels(
                          draft.models.map((m, i) =>
                            i === selected ? { ...m, parameters } : m,
                          ),
                        )
                      }
                    />
                  ) : (
                    <Typography variant="body2">
                      Add a model to configure parameters.
                    </Typography>
                  )}
                </Box>
              </Stack>
            </Stack>
          </DialogContent>
        )}
        <DialogActions>
          <Button onClick={() => setDraft(null)}>Cancel</Button>
          <Button
            variant="contained"
            onClick={save}
            disabled={!draft?.name.trim() || !validEndpoint || !!error}
          >
            Save Provider
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
