import { useEffect, useId, useRef, useState } from "react";
import {
  Alert,
  Button,
  Checkbox,
  Chip,
  Menu,
  MenuItem,
  Stack,
} from "@mui/material";
import Add from "@mui/icons-material/Add";
import { mcpPluginStyle } from "./tool-execution-type";

type ConnectionOption = {
  id: string;
  name: string;
  selected: boolean;
  pendingDeletion: boolean;
};

export function SessionMcpTools({
  sessionId,
  visible,
}: {
  sessionId: string;
  visible: boolean;
}) {
  const base =
    "/api/week4/sessions/" + encodeURIComponent(sessionId) + "/mcp-connections";
  const menuId = useId();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [options, setOptions] = useState<ConnectionOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState(false);
  const [writeError, setWriteError] = useState("");
  const [saving, setSaving] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const writeLock = useRef(false);

  // Reload on entry, menu opening, and after every write, including a lost reply.
  // A late read from a previous view must never replace the current selection.
  useEffect(() => {
    if (!visible) {
      setAnchor(null);
      return;
    }
    if (saving) return;
    const controller = new AbortController();
    setLoading(true);
    setReadError(false);
    async function load() {
      try {
        const response = await fetch(base, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw Error();
        const rows: ConnectionOption[] = await response.json();
        if (!controller.signal.aborted) setOptions(rows);
      } catch {
        if (!controller.signal.aborted) {
          setOptions([]);
          setReadError(true);
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [base, visible, refresh, saving]);

  async function toggle(option: ConnectionOption) {
    if (writeLock.current || loading || readError) return;
    writeLock.current = true;
    setSaving(true);
    setLoading(true);
    setWriteError("");
    try {
      const response = await fetch(base + "/" + encodeURIComponent(option.id), {
        method: option.selected ? "DELETE" : "PUT",
      });
      if (!response.ok) throw Error();
    } catch {
      setAnchor(null);
      setWriteError(
        "Could not confirm the change. Check the saved selection before trying again.",
      );
    } finally {
      writeLock.current = false;
      setSaving(false);
      setRefresh((value) => value + 1);
    }
  }

  if (!visible) return null;
  const busy = loading || saving;
  return (
    <Stack
      spacing={0.5}
      role="group"
      aria-label="Session MCP connections"
      aria-busy={busy}
    >
      <Stack
        direction="row"
        alignItems="center"
        spacing={1}
        useFlexGap
        flexWrap="wrap"
      >
        <Button
          size="small"
          variant="outlined"
          startIcon={<Add />}
          aria-haspopup="menu"
          aria-expanded={!!anchor}
          aria-controls={anchor ? menuId : undefined}
          onClick={(event) => {
            setAnchor(event.currentTarget);
            setRefresh((value) => value + 1);
          }}
        >
          Add Tools
        </Button>
        {options
          .filter((option) => option.selected)
          .map((option) => (
            <Chip
              key={option.id}
              label={option.name}
              size="small"
              disabled={busy}
              onDelete={() => void toggle(option)}
              sx={{
                bgcolor: mcpPluginStyle.background,
                color: mcpPluginStyle.color,
                "& .MuiChip-deleteIcon": { color: mcpPluginStyle.color },
              }}
            />
          ))}
      </Stack>
      <Menu
        anchorEl={anchor}
        open={!!anchor}
        onClose={() => setAnchor(null)}
        slotProps={{
          list: { id: menuId, "aria-label": "Registered MCP connections" },
        }}
      >
        {options.map((option) => (
          <MenuItem
            key={option.id}
            role="menuitemcheckbox"
            aria-checked={option.selected}
            disabled={busy || (option.pendingDeletion && !option.selected)}
            onClick={() => void toggle(option)}
          >
            <Checkbox
              size="small"
              checked={option.selected}
              tabIndex={-1}
              disableRipple
              sx={{ pointerEvents: "none" }}
              slotProps={{ input: { "aria-hidden": true } }}
            />
            {option.name}
          </MenuItem>
        ))}
        {!options.length && (
          <MenuItem disabled>
            {busy
              ? "Loading connections…"
              : readError
                ? "Connections unavailable"
                : "No registered MCP connections"}
          </MenuItem>
        )}
      </Menu>
      {writeError && (
        <Alert severity="error" onClose={() => setWriteError("")}>
          {writeError}
        </Alert>
      )}
      {readError && (
        <Alert
          severity="error"
          action={
            <Button onClick={() => setRefresh((value) => value + 1)}>
              Retry
            </Button>
          }
        >
          Could not load the saved MCP selection.
        </Alert>
      )}
    </Stack>
  );
}
