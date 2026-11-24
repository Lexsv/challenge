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
  Stack,
  Typography,
} from "@mui/material";
import { mcpRequest } from "./mcp-connections";

type Settings = {
  mode: "attached" | "auto";
  revision: string;
  tools: { id: string; name: string; approved: boolean }[];
};

export function McpExecutionMode({
  id,
  name,
  close,
}: {
  id: string;
  name: string;
  close: () => void;
}) {
  const path = "/" + encodeURIComponent(id) + "/execution-mode";
  const [settings, setSettings] = useState<Settings>();
  const [auto, setAuto] = useState(false);
  const [ids, setIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    mcpRequest<Settings>(path)
      .then((data) => {
        if (!current) return;
        setSettings(data);
        setAuto(data.mode === "auto");
        setIds(data.tools.filter((t) => t.approved).map((t) => t.id));
      })
      .catch((e) => {
        if (current) setError(e.message);
      });
    return () => {
      current = false;
    };
  }, [path]);
  async function save() {
    if (!settings || busy) return;
    setBusy(true);
    setError("");
    try {
      await mcpRequest(path, "PUT", {
        revision: settings.revision,
        mode: auto ? "auto" : "attached",
        toolIds: auto ? ids : [],
      });
      close();
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
      aria-labelledby="mcp-mode-title"
      onClose={() => {
        if (!busy) close();
      }}
    >
      <DialogTitle id="mcp-mode-title">{name} · Execution mode</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={1}>
          {error && <Alert severity="error">{error}</Alert>}
          {settings ? (
            <>
              <FormControlLabel
                control={
                  <Checkbox
                    checked={auto}
                    disabled={busy}
                    onChange={(_, checked) => setAuto(checked)}
                  />
                }
                label="Limit execution to selected tools"
              />
              {!auto && <Typography variant="body2">Attached chats can use this connection’s tools automatically, including write and delete operations. Deployment and session restrictions apply.</Typography>}
              {auto && (
                <>
                  <Alert severity="warning">
                    In chats attached to this connection, the Manager may run
                    every operation of each selected tool, including deletions
                    and generated programs, without further confirmation.
                    Session and deployment restrictions still apply.
                  </Alert>
                  <Typography variant="body2">
                    Select the tools you authorize. New or changed tools require
                    a new selection.
                  </Typography>
                  {settings.tools.map((tool) => (
                    <FormControlLabel
                      key={tool.id}
                      label={tool.name}
                      control={
                        <Checkbox
                          checked={ids.includes(tool.id)}
                          disabled={busy}
                          onChange={(_, checked) =>
                            setIds((current) =>
                              checked
                                ? [...current, tool.id]
                                : current.filter((id) => id !== tool.id),
                            )
                          }
                        />
                      }
                    />
                  ))}
                  {!settings.tools.length && (
                    <Typography>
                      Discover the tool catalog to select tools.
                    </Typography>
                  )}
                </>
              )}
            </>
          ) : (
            !error && (
              <Typography role="status">Loading execution mode…</Typography>
            )
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={close} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant="contained"
          onClick={() => void save()}
          disabled={!settings || busy}
        >
          Save execution mode
        </Button>
      </DialogActions>
    </Dialog>
  );
}
