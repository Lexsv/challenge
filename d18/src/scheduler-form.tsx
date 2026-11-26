import { useEffect, useRef, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { SchedulerServerSelector } from "./scheduler-server-selector";
import type { ProviderRegistry } from "./provider-registry";
import { ModelField, ProviderField, useProviderOptions } from "./model-field";
import {
  intervalUnits,
  intervalParts,
  localStart,
  possibleStarts,
  type IntervalUnit,
} from "./schedule-time";
import { schedulerApi, stamp, type Task, type ToolChoice, type Permission } from "./scheduler-api";

const pair = {
  display: "grid",
  gridTemplateColumns: { xs: "minmax(0,1fr)", sm: "repeat(2,minmax(0,1fr))" },
  gap: 2,
  "& > *": { minWidth: 0 },
};
export function SchedulerForm({
  task,
  registry,
  onClose,
  onSaved,
}: {
  task?: Task;
  registry: ProviderRegistry;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const [name, setName] = useState(task?.name ?? ""),
    [instructions, setInstructions] = useState(task?.instructions ?? "");
  const availableProviders = useProviderOptions(registry);
  const first = availableProviders[0]?.id ?? "";
  const [provider, setProvider] = useState(task?.provider ?? first),
    [model, setModel] = useState(task?.model ?? registry.modelOptionsFor(first)[0] ?? "");
  const [kind, setKind] = useState(task?.schedule.kind ?? "once");
  const original = task?.schedule;
  const [zone, setZone] = useState(task?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
  const initial = original
    ? original.kind === "once"
      ? original.at
      : original.startAt
    : Math.ceil(Date.now() / 60000) * 60000;
  const [start, setStart] = useState(() => localStart(initial, zone)),
    [fold, setFold] = useState<number | null>(initial);
  const initialInterval = intervalParts(original?.kind === "interval" ? original.everyMs : 3600000);
  const [quantity, setQuantity] = useState(String(initialInterval.value)),
    [unit, setUnit] = useState<IntervalUnit>(initialInterval.unit);
  const [choices, setChoices] = useState<ToolChoice[]>([]),
    [loaded, setLoaded] = useState(""),
    [permissions, setPermissions] = useState<Permission[]>(task?.permissions ?? []);
  const [consent, setConsent] = useState(false),
    [saving, setSaving] = useState(false),
    lock = useRef(false);
  const [error, setError] = useState(""),
    [loadError, setLoadError] = useState(""),
    [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setLoadError("");
    setLoaded("");
    schedulerApi<ToolChoice[]>("catalog")
      .then((r) => {
        if (active) {
          setChoices(r);
          setLoaded("ready");
        }
      })
      .catch(() => {
        if (active) setLoadError("Could not load the MCP catalog.");
      });
    return () => {
      active = false;
    };
  }, [retry]);
  const candidates = possibleStarts(start, zone);
  const ms = candidates.length === 1 ? candidates[0] : candidates.find((c) => c === fold);
  const every = Number(quantity) * intervalUnits[unit] * 1000;
  const stale = permissions.filter((p) => !choices.some((c) => c.toolId === p.toolId && c.eligible));
  const valid =
    name.trim() &&
    instructions.trim() &&
    registry.modelOptionsFor(provider).includes(model) &&
    availableProviders.some((p) => p.id === provider) &&
    loaded === "ready" &&
    ms !== undefined &&
    (kind === "once" || (Number.isSafeInteger(every) && every > 0)) &&
    (!permissions.length || consent) &&
    !stale.length;
  async function save() {
    if (!valid || lock.current) return;
    lock.current = true;
    setSaving(true);
    setError("");
    try {
      const saved = await schedulerApi<Task>(
        task ? "tasks/" + task.id : "tasks",
        task ? "PUT" : "POST",
        {
          name: name.trim(),
          instructions: instructions.trim(),
          provider,
          model: model.trim(),
          timezone: zone,
          schedule: kind === "once" ? { kind, at: ms } : { kind, startAt: ms, everyMs: every },
          enabled: false,
          permissions: permissions.map((p) => {
            const c = choices.find((c) => c.toolId === p.toolId)!;
            return { ...p, definition: c.definition, revision: c.revision };
          }),
          authorized: consent,
          revision: task?.revision,
        },
      );
      onSaved(saved.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      lock.current = false;
      setSaving(false);
    }
  }
  return (
    <Dialog
      open
      fullWidth
      maxWidth="md"
      onClose={() => {
        if (!saving) onClose();
      }}
      aria-labelledby="scheduler-form-title"
    >
      <DialogTitle id="scheduler-form-title">
        {task ? "Edit configuration" : "Create Scheduler"}
      </DialogTitle>
      <DialogContent dividers sx={{ overflowX: "hidden" }}>
        <Stack spacing={2}>
          <Box>
            <TextField
              fullWidth
              label="Task name"
              required
              value={name}
              inputProps={{ maxLength: 120 }}
              onChange={(e) => setName(e.target.value)}
            />
          </Box>
          <TextField
            label="Agent instructions"
            required
            multiline
            minRows={5}
            maxRows={12}
            inputProps={{ maxLength: 32000 }}
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
          />
          <Box sx={pair}>
            <ProviderField
              registry={registry}
              value={provider}
              onChange={(next) => {
                setProvider(next);
                setModel(registry.modelOptionsFor(next)[0] ?? "");
              }}
            />
            <ModelField
              key={provider}
              allowCustom={false}
              registry={registry}
              providerId={provider}
              label="Model"
              value={model}
              onChange={setModel}
            />
          </Box>
          <Box sx={pair}>
            <TextField
              select
              label="Schedule type"
              value={kind}
              onChange={(e) => setKind(e.target.value === "once" ? "once" : "interval")}
            >
              <MenuItem value="once">One time</MenuItem>
              <MenuItem value="interval">Recurring interval</MenuItem>
            </TextField>
            {kind === "interval" && (
              <Box sx={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 1 }}>
                <TextField
                  label="Every"
                  type="number"
                  inputProps={{ min: 0, step: "any" }}
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                />
                <TextField
                  select
                  label="Interval unit"
                  value={unit}
                  onChange={(e) => setUnit(e.target.value as IntervalUnit)}
                >
                  {Object.keys(intervalUnits).map((u) => (
                    <MenuItem key={u} value={u}>
                      {u}
                    </MenuItem>
                  ))}
                </TextField>
              </Box>
            )}
          </Box>
          <Box sx={pair}>
            <TextField
              label="Local start date and time"
              type="datetime-local"
              value={start}
              InputLabelProps={{ shrink: true }}
              inputProps={{ step: "0.001" }}
              onChange={(e) => {
                setStart(e.target.value);
                setFold(null);
              }}
            />
            <TextField
              label="Timezone"
              value={zone}
              onChange={(e) => {
                setZone(e.target.value);
                setFold(null);
              }}
              error={!candidates.length}
              helperText={
                ms !== undefined
                  ? stamp(ms, "UTC")
                  : candidates.length
                    ? "Choose the intended offset."
                    : "Enter a valid timezone and an existing local time."
              }
            />
            {candidates.length > 1 && (
              <TextField
                select
                label="Repeated local time"
                value={ms ?? ""}
                onChange={(e) => setFold(Number(e.target.value))}
              >
                {candidates.map((c) => (
                  <MenuItem key={c} value={c}>
                    {stamp(c, zone)} · {stamp(c, "UTC")}
                  </MenuItem>
                ))}
              </TextField>
            )}
          </Box>
          <Box>
            <SchedulerServerSelector catalog={choices} permissions={permissions} disabled={!loaded || saving}
              onChange={next => { setPermissions(next); setConsent(false); }} />
            {loadError ? (
              <Alert
                severity="error"
                action={<Button onClick={() => setRetry((v) => v + 1)}>Retry</Button>}
              >
                {loadError}
              </Alert>
            ) : !loaded ? (
              <Typography>Loading tools…</Typography>
            ) : !choices.length ? (
              <Typography>No registered MCP servers.</Typography>
            ) : null}
            {loaded && stale.length > 0 && (
              <Alert severity="warning">A saved tool is unavailable. Remove its server, then reselect it to review the available tools.</Alert>
            )}
            {!!permissions.length && (
              <Box>
                <FormControlLabel
                  control={<Checkbox checked={consent} onChange={(e) => setConsent(e.target.checked)} />}
                  label={`I authorize unattended execution with the ${permissions.length} selected ${permissions.length === 1 ? "tool" : "tools"}.`}
                />
              </Box>
            )}
          </Box>
          {error && <Alert severity="error">{error}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button variant="contained" disabled={!valid || saving} onClick={save}>
          {saving ? "Saving…" : task ? "Save changes" : "Create task"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
