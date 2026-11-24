import { useEffect, useState } from "react";
import {
  Alert,
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

type Selection = {
  toolId: string;
  action: string;
  fields: string[];
  fixed: Record<string, string>;
};
type Operation = Omit<Selection, "fixed"> & {
  name: string;
  required: string[];
  pinnable: string[];
  safety: string;
};
type Settings = {
  autoApprove: boolean;
  inherit: boolean;
  revision: string;
  options: Operation[];
  selected: Selection[];
};
const key = (op: Pick<Selection, "toolId" | "action">) =>
  op.toolId + "/" + op.action;
const headers = {
  "x-day16-ui": "permissions",
  "content-type": "application/json",
};

export function SessionMcpPermissions({
  base,
  connections,
  onClose,
}: {
  base: string;
  connections: { id: string; name: string }[];
  onClose: () => void;
}) {
  const [connection, setConnection] = useState(connections[0].id);
  const [settings, setSettings] = useState<Settings>();
  const [selected, setSelected] = useState<Selection[]>([]);
  const [inherit, setInherit] = useState(false);
  const [active, setActive] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const endpoint = base + "/" + encodeURIComponent(connection) + "/permissions";
  useEffect(() => {
    const controller = new AbortController();
    setSettings(undefined);
    setError("");
    setSelected([]);
    setActive("");
    async function load() {
      try {
        const response = await fetch(endpoint, {
          headers,
          signal: controller.signal,
          cache: "no-store",
        });
        if (!response.ok)
          throw Error(
            response.status === 403
              ? "Session permissions are unavailable. A deployment policy may manage access."
              : "Could not load session permissions.",
          );
        const data: Settings = await response.json();
        if (!controller.signal.aborted) {
          setSettings(data);
          setInherit(data.inherit);
          setSelected(data.selected);
          setActive(data.options.length ? key(data.options[0]) : "");
        }
      } catch (e) {
        if (!controller.signal.aborted) setError((e as Error).message);
      }
    }
    void load();
    return () => controller.abort();
  }, [endpoint]);
  const dirty =
    !!settings &&
    (settings.inherit !== inherit ||
      JSON.stringify(settings.selected) !== JSON.stringify(selected));
  const option = settings?.options.find((o) => key(o) === active);
  const grant = selected.find((o) => key(o) === active);
  function update(value?: Selection) {
    setSelected((items) => [
      ...items.filter((o) => key(o) !== active),
      ...(value ? [value] : []),
    ]);
  }
  async function save() {
    if (!settings || busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(endpoint, {
        method: "PUT",
        headers,
        body: JSON.stringify({
          revision: settings.revision,
          selected: inherit ? [] : selected,
          inherit,
        }),
      });
      if (!response.ok)
        throw Error(
          response.status === 409
            ? "The catalog or permissions changed. Close and reopen permissions to review the current settings."
            : "Could not confirm the change. Reopen permissions to check the saved settings.",
        );
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      fullWidth
      maxWidth="sm"
      onClose={() => {
        if (!busy) onClose();
      }}
      aria-labelledby="session-permissions-title"
    >
      <DialogTitle id="session-permissions-title">
        Session tool permissions
      </DialogTitle>
      <DialogContent>
        <Stack spacing={1.5} sx={{ pt: 1 }}>
          <TextField
            select
            label="MCP connection"
            value={connection}
            disabled={busy || dirty}
            onChange={(e) => setConnection(e.target.value)}
          >
            {connections.map((c) => (
              <MenuItem key={c.id} value={c.id}>
                {c.name}
              </MenuItem>
            ))}
          </TextField>
          {error && <Alert severity="error">{error}</Alert>}
          {settings?.autoApprove && (
            <FormControlLabel
              control={
                <Checkbox
                  checked={inherit}
                  disabled={busy}
                  onChange={(_, checked) => setInherit(checked)}
                />
              }
              label="Use the tool scope authorized in connection settings"
            />
          )}
          {settings && !inherit && !settings.options.length && (
            <Typography>
              No eligible operations in the current catalog.
            </Typography>
          )}
          {option && !inherit && (
            <>
              <TextField
                select
                label="Operation"
                value={active}
                disabled={busy}
                onChange={(e) => setActive(e.target.value)}
              >
                {settings!.options.map((o) => (
                  <MenuItem key={key(o)} value={key(o)}>
                    {o.name} · {o.action}
                    {selected.some((s) => key(s) === key(o))
                      ? " (allowed)"
                      : ""}
                  </MenuItem>
                ))}
              </TextField>
              <FormControlLabel
                control={
                  <Checkbox
                    checked={!!grant}
                    disabled={busy}
                    onChange={(_, checked) =>
                      update(
                        checked
                          ? {
                              toolId: option.toolId,
                              action: option.action,
                              fields: option.required,
                              fixed: {},
                            }
                          : undefined,
                      )
                    }
                  />
                }
                label="Allow automatically in this session"
              />
              <Typography variant="body2">
                {option.safety === "read-only"
                  ? "Enable only if you have verified this operation only reads data."
                  : "Enable only if you have verified this operation creates ordinary records and needs no further approval."}
              </Typography>
              {grant && option.fields.length > 0 && (
                <Typography variant="body2">
                  Choose arguments the Manager may supply. A fixed resource ID
                  limits the scope. With a dynamic resource ID, the connection
                  can use any accessible target.
                </Typography>
              )}
              {grant &&
                option.fields.map((field) => (
                  <Stack
                    key={field}
                    direction="row"
                    alignItems="center"
                    spacing={1}
                  >
                    <FormControlLabel
                      control={
                        <Checkbox
                          checked={grant.fields.includes(field)}
                          disabled={busy || option.required.includes(field)}
                          onChange={(_, checked) => {
                            const fixed = { ...grant.fixed };
                            delete fixed[field];
                            update({
                              ...grant,
                              fields: checked
                                ? [...grant.fields, field]
                                : grant.fields.filter((f) => f !== field),
                              fixed,
                            });
                          }}
                        />
                      }
                      label={field}
                    />
                    {option.pinnable.includes(field) &&
                      grant.fields.includes(field) && (
                        <TextField
                          size="small"
                          disabled={busy}
                          label={"Fixed " + field + " (optional)"}
                          value={grant.fixed[field] ?? ""}
                          onChange={(e) => {
                            const fixed = { ...grant.fixed };
                            if (e.target.value) fixed[field] = e.target.value;
                            else delete fixed[field];
                            update({ ...grant, fixed });
                          }}
                        />
                      )}
                  </Stack>
                ))}
            </>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button disabled={busy} onClick={onClose}>
          Cancel
        </Button>
        <Button disabled={busy || !dirty} onClick={() => void save()}>
          Save permissions
        </Button>
      </DialogActions>
    </Dialog>
  );
}
