import { AsyncEvents } from "./mcp-async-events";
import { JsonView } from "./json-view";
export { JsonView } from "./json-view";
import { McpExecutionMode } from "./mcp-execution-mode";
import { ParameterEditor } from "./parameter-editor";
import { type ApiParameter } from "./api-parameters";
import { parameterRows, editableEndpoint, parameterEndpoint, sensitiveParameter } from "./mcp-parameters";
import Visibility from "@mui/icons-material/VisibilityOutlined";
import VisibilityOff from "@mui/icons-material/VisibilityOffOutlined";
import { InputAdornment, InputBase } from "@mui/material";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  Switch,
  IconButton,
  List,
  ListItemButton,
  ListItemText,
  MenuItem,
  Paper,
  Stack,
  TableCell,
  TableRow,
  TextField,
  Typography,
  Tooltip,
} from "@mui/material";
import { normalizedMcpEndpoint } from "./mcp-endpoint";
import { mcpPluginStyle, toolDescriptionStyle } from "./tool-execution-type";
import DeleteOutline from "@mui/icons-material/DeleteOutline";
import Refresh from "@mui/icons-material/Refresh";
import Settings from "@mui/icons-material/SettingsOutlined";
import {
  mcpRequest,
  observeMcpSnapshot,
  type McpAuth,
  type McpCatalog,
  type McpConfig,
  type McpTool,
  type McpConnection,
} from "./mcp-connections";

export function connectionStatus(item: McpConnection) {
  if (item.deletionPending) return "Local deletion pending";
  if (item.endpointConflict)
    return "Duplicate endpoint · change the endpoint or delete the duplicate";
  if (item.error)
    return (
      "Discovery failed · " +
      item.error +
      (item.lastSuccess === null ? "" : " · stale catalog")
    );
  if (!item.lastSuccess) return "Awaiting discovery";
  return item.stale ? "Cached catalog · stale" : "Catalog up to date";
}
export function McpRow({
  item,
  busy,
  open,
  edit,
  refresh,
  remove,
}: {
  item: McpConnection;
  busy: boolean;
  open: () => void;
  edit: () => void;
  refresh: () => void;
  remove: () => void;
}) {
  const Plug = mcpPluginStyle.icon;
  return (
    <TableRow>
      <TableCell component="th" scope="row">
        <Button
          onClick={open}
          sx={{ textAlign: "left", overflowWrap: "anywhere" }}
        >
          {item.name}
        </Button>
      </TableCell>
      <TableCell>
        <Chip
          size="small"
          label="MCP Plugin"
          icon={<Plug fontSize="small" />}
          sx={{
            color: mcpPluginStyle.color,
            bgcolor: mcpPluginStyle.background,
            "& .MuiChip-icon": { color: mcpPluginStyle.color },
          }}
        />
      </TableCell>
      <TableCell>
        <Typography
          component="span"
          variant="inherit"
          sx={toolDescriptionStyle}
        >
          {item.description}
        </Typography>
      </TableCell>
      <TableCell align="right">{item.toolCount}</TableCell>
      <TableCell><AsyncEvents connection={item}/></TableCell>
      <TableCell align="right">
        <Stack direction="row" justifyContent="flex-end">
          <Tooltip title="Refresh catalog">
            <span>
              <IconButton
                size="small"
                disabled={busy || item.deletionPending || item.endpointConflict}
                aria-label={"Refresh " + item.name}
                onClick={refresh}
              >
                {busy ? (
                  <CircularProgress size={18} />
                ) : (
                  <Refresh fontSize="small" />
                )}
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip title="Connection settings">
            <span>
              <IconButton
                size="small"
                disabled={busy || item.deletionPending}
                aria-label={"Settings for " + item.name}
                onClick={edit}
              >
                <Settings fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip title="Delete connection">
            <IconButton
              size="small"
              color="error"
              aria-label={"Delete " + item.name}
              onClick={remove}
            >
              <DeleteOutline fontSize="small" />
            </IconButton>
          </Tooltip>
        </Stack>
      </TableCell>
    </TableRow>
  );
}

export function McpParameterValue({
  label,
  outlined = false,
  secret,
  value,
  change,
  reveal,
  onError,
}: {
  label: string;
  outlined?: boolean;
  secret: boolean;
  value: string;
  change: (value: string) => void;
  reveal?: () => Promise<string>;
  onError: (message: string) => void;
}) {
  const [shown, setShown] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const input = {
    type: secret && shown === null ? "password" : "text",
    autoComplete: "off",
    placeholder: secret && reveal ? "••••••••" : undefined,
    value: shown ?? value,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (shown !== null) setShown(e.target.value);
      change(e.target.value);
    },
  };
  const toggle = secret && (
    <IconButton
      size="small"
      disabled={loading}
      aria-label={(shown === null ? "Show " : "Hide ") + label}
      onClick={async () => {
        if (shown !== null) {
          setShown(null);
          return;
        }
        setLoading(true);
        try {
          setShown(value || (reveal ? await reveal() : ""));
        } catch (e) {
          onError(e instanceof Error ? e.message : "Could not show the saved value.");
        } finally {
          setLoading(false);
        }
      }}
    >
      {shown === null ? (
        <Visibility fontSize="small" />
      ) : (
        <VisibilityOff fontSize="small" />
      )}
    </IconButton>
  );
  if (outlined) return (
    <TextField {...input} fullWidth variant="outlined" label={label}
      slotProps={{
        inputLabel: {shrink: true},
        input: {endAdornment: <InputAdornment position="end">{toggle}</InputAdornment>},
      }}
    />
  );
  return (
    <Stack direction="row" alignItems="center">
      <InputBase {...input} fullWidth sx={{px:1}} inputProps={{"aria-label":label}} />
      {toggle}
    </Stack>
  );
}
type SettingsRow = ApiParameter & { secret?: boolean };
export function McpSettings({
  connections,
  initial,
  close,
  saved,
  refresh,
}: {
  connections: readonly McpConnection[];
  initial?: McpConnection;
  close: () => void;
  saved: (value: McpConnection) => void;
  refresh: (id: string) => Promise<void>;
}) {
  const [name, setName] = useState(initial?.name ?? ""),
    [description, setDescription] = useState(initial?.description ?? "");
  const [endpoint, setEndpoint] = useState(initial ? editableEndpoint(initial.endpoint, initial.auth) : ""),
    [transport, setTransport] = useState<McpConfig["transport"]>(
      initial?.transport ?? "streamable-http",
    );
  const [type, setType] = useState<McpAuth["type"]>(
    initial?.auth.type ?? "none",
  );
  const [persisted, setPersisted] = useState(initial);
  const savedRows = parameterRows(persisted?.auth ?? { type: "none" });
  const [rows, setRows] = useState<SettingsRow[]>(() =>
    savedRows.map((row) => ({
      ...row,
      id: crypto.randomUUID(),
      value: row.value ?? "",
    })),
  );
  const [token, setToken] = useState(""),
    [phase, setPhase] = useState(""),
    [error, setError] = useState("");
  const [editingMode, setEditingMode] = useState(false);
  const isTable = type === "headers" || type === "query";
  const privateRow = (r: SettingsRow) =>
    r.secret !== false || sensitiveParameter(r.key);
  const proposed: McpAuth = isTable
    ? {
        type,
        rows: rows.map((r) => ({
          key: r.key,
          enabled: r.enabled,
          secret: privateRow(r),
          ...(!privateRow(r) && { value: r.value }),
        })),
      }
    : { type };
  const auth =
    persisted &&
    type === persisted.auth.type &&
    JSON.stringify(parameterRows(proposed)) === JSON.stringify(savedRows)
      ? persisted.auth
      : proposed;
  const baseEndpoint = normalizedMcpEndpoint(endpoint);
  const identity = baseEndpoint && normalizedMcpEndpoint(parameterEndpoint(baseEndpoint, auth) ?? "");
  const duplicate =
    !!identity &&
    connections.some(
      (c) =>
        c.connectionId !== persisted?.connectionId &&
        normalizedMcpEndpoint(c.endpoint) === identity,
    );
  const endpointError = duplicate
    ? "This endpoint already belongs to another MCP connection."
    : endpoint.trim() && !identity
      ? "Enter an HTTP or HTTPS endpoint without embedded credentials."
      : "";
  const sameDestination =
    persisted &&
    normalizedMcpEndpoint(persisted.endpoint) === identity &&
    persisted.transport === transport &&
    persisted.auth.type === type;
  const retained = (key: string) =>
    !!sameDestination &&
    savedRows.some((row) => row.key === key && row.secret);
  const reveal = (key: string) =>
    retained(key) && persisted
      ? async () =>
          (
            await mcpRequest<{ value: string }>(
              "/" + persisted.connectionId + "/reveal",
              "POST",
              { revision: persisted.revision, key },
            )
          ).value
      : undefined;
  const values =
    type === "bearer"
      ? [token || (retained("Authorization") ? null : "")]
      : isTable
        ? rows
            .filter(privateRow)
            .map((r) => r.value || (retained(r.key) ? null : ""))
        : [];
  const keep =
    persisted &&
    sameDestination &&
    JSON.stringify(persisted.auth) === JSON.stringify(auth) &&
    values.every((v) => v === null);
  const valid =
    !!name.trim() &&
    !!identity &&
    !endpointError &&
    values.every((v) => v === null || !!v.trim()) &&
    (!isTable ||
      (rows.every((r) => !!r.key.trim()) &&
        new Set(
          rows.map((r) => (type === "headers" ? r.key.toLowerCase() : r.key)),
        ).size === rows.length));
  const submitting = useRef(false);
  const draft = useMemo(() => ({name, description, transport, endpoint, type, rows, token}),
    [name, description, transport, endpoint, type, rows, token]);
  const savedDraft = useRef<typeof draft | null>(null);
  async function submit(connect: boolean) {
    if (!valid || submitting.current) return;
    submitting.current = true;
    setError("");
    try {
      let connection = persisted;
      if (!connection || savedDraft.current !== draft) {
        setPhase("Saving…");
        connection = await mcpRequest<McpConnection>(
          persisted ? "/" + persisted.connectionId : "",
          persisted ? "PUT" : "POST",
          {
            name, description, transport, endpoint, auth,
            ...(persisted ? {revision: persisted.revision} : {}),
            ...(!keep && values.length ? {secretValues: values} : {}),
          },
        );
        setPersisted(connection);
        savedDraft.current = draft;
        saved(connection);
      }
      if (connect) {
        setPhase("Connecting and discovering tools…");
        await refresh(connection.connectionId);
      }
      close();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not connect. Please retry.");
    } finally {
      submitting.current = false;
      setPhase("");
    }
  }
  return (
    <Dialog
      open
      fullWidth
      maxWidth="sm"
      onClose={() => {
        if (!submitting.current) close();
      }}
      aria-labelledby="mcp-settings-title"
    >
      <DialogTitle id="mcp-settings-title">
        {initial ? "MCP Plugin settings" : "Add MCP Plugin"}
      </DialogTitle>
      <DialogContent dividers>
        <Stack
          spacing={2}
          component="fieldset"
          disabled={!!phase}
          sx={{ border: 0, p: 0, m: 0, minWidth: 0 }}
        >
          <TextField
            required
            label="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <TextField
            multiline
            label="Description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          <TextField
            select
            label="Transport"
            value={transport}
            onChange={(e) =>
              setTransport(e.target.value as McpConfig["transport"])
            }
          >
            <MenuItem value="streamable-http">Streamable HTTP</MenuItem>
            <MenuItem value="sse">Legacy HTTP + SSE</MenuItem>
          </TextField>
          <TextField
            required
            label="Endpoint"
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            error={!!endpointError}
            helperText={
              endpointError ||
              "Use HTTPS or a local development HTTP address. Enter query credentials below."
            }
          />
          <TextField
            select
            label="Authentication"
            value={type}
            onChange={(e) => {
              const next = e.target.value as McpAuth["type"];
              setType(next);
              setToken("");
              setRows(
                next === persisted?.auth.type
                  ? savedRows.map((r) => ({
                      ...r,
                      id: crypto.randomUUID(),
                      value: r.value ?? "",
                    }))
                  : [],
              );
            }}
          >
            <MenuItem value="none">None</MenuItem>
            <MenuItem value="bearer">Bearer Token</MenuItem>
            <MenuItem value="query">Query Parameter</MenuItem>
            <MenuItem value="headers">Custom Headers</MenuItem>
          </TextField>
          {type === "bearer" && (
            <McpParameterValue
              key={String(!!sameDestination)}
              outlined
              label="Bearer Token"
              secret
              value={token}
              change={setToken}
              reveal={reveal("Authorization")}
              onError={setError}
            />
          )}
          {isTable && (
            <ParameterEditor
              label={type === "query" ? "Query Parameters" : "Custom Headers"}
              parameters={rows}
              maxRows={16}
              validate={() => undefined}
              onChange={setRows}
              renderValue={(row, update) => {
                const secret = privateRow(row);
                return (
                  <McpParameterValue
                    key={JSON.stringify([row.key, !!sameDestination, secret])}
                    label={row.key || "Parameter value"}
                    secret={secret}
                    value={row.value}
                    change={(value) => update({ value })}
                    reveal={secret ? reveal(row.key) : undefined}
                    onError={setError}
                  />
                );
              }}
            />
          )}
          {initial && <Button variant="outlined" onClick={() => setEditingMode(true)}>Configure execution mode</Button>}
          {initial && editingMode && <McpExecutionMode id={initial.connectionId} name={initial.name} close={() => setEditingMode(false)} />}

        </Stack>
      </DialogContent>
      {error && <Alert severity="error" sx={{mx:3, mt:1}}>{error}</Alert>}
      {phase && <Stack role="status" direction="row" alignItems="center" spacing={1} sx={{mx:3, mt:1}}>
        <CircularProgress size={16}/><Typography variant="body2">{phase}</Typography>
      </Stack>}
      <DialogActions>
        <Button disabled={!!phase} onClick={close}>
          Cancel
        </Button>
        {initial && (
          <Button
            disabled={!valid || !!phase}
            onClick={() => void submit(false)}
          >
            Save settings
          </Button>
        )}
        <Button
          variant="contained"
          disabled={!valid || !!phase}
          onClick={() => void submit(true)}
        >
          Connect
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export function CatalogContents({
  catalog,
  onRemove,
  onWatch,
  watchBusy,
}: {
  catalog: McpCatalog;
  onWatch?: (tool: McpTool) => void;
  watchBusy?: boolean;
  onRemove?: (tool: McpTool) => void;
}) {
  const [selected, setSelected] = useState("");
  const tool =
    catalog.tools.find((t) => t.toolId === selected) ?? catalog.tools[0];
  const { description, inputSchema, outputSchema, name, ...metadata } =
    tool?.document ?? {};
  return (
    <>
      {tool ? (
        <Box
          sx={{
            display: "grid",
            height: "100%",
            minHeight: 0,
            minWidth: 0,
            gap: { xs: 1, sm: 2 },
            gridTemplateColumns: "minmax(0,3fr) minmax(0,7fr)",
            gridTemplateRows: "minmax(0,1fr)",
          }}
        >
          <List
            component="nav"
            aria-label="Discovered tools"
            sx={{
              minWidth: 0,
              minHeight: 0,
              scrollbarGutter: "stable",
              overflow: "auto",
            }}
          >
            {catalog.tools.map((t) => (
              <ListItemButton
                key={t.toolId}
                selected={tool.toolId === t.toolId}
                aria-current={tool.toolId === t.toolId || undefined}
                onClick={() => setSelected(t.toolId)}
              >
                <ListItemText
                  primary={t.originalName}
                  sx={{ overflowWrap: "anywhere" }}
                />
              </ListItemButton>
            ))}
          </List>
          <Paper
            key={tool.toolId}
            component="section"
            aria-label="Selected tool details"
            tabIndex={0}
            variant="outlined"
            sx={{
              p: { xs: 1, sm: 2 },
              minHeight: 0,
              minWidth: 0,
              overflow: "auto",
              scrollbarGutter: "stable",
              overflowWrap: "anywhere",
            }}
          >
            <Stack spacing={1}>
              <Stack
                direction="row"
                alignItems="center"
                justifyContent="space-between"
              >
                <Typography variant="h6">{tool.originalName}</Typography>
                {onRemove && (
                  <Tooltip title="Remove local tool">
                    <IconButton
                      aria-label={"Remove " + tool.originalName}
                      size="small"
                      onClick={() => onRemove(tool)}
                    >
                      <DeleteOutline fontSize="small" />
                    </IconButton>
                  </Tooltip>
                )}
              </Stack>
              <AsyncEvents connection={catalog.connection} tool={tool} />
              {onWatch && (
                <FormControlLabel
                  sx={{alignSelf:"flex-start"}}
                  label="Automatic Resource Watching"
                  control={<Switch size="small" checked={tool.watchAttachedChats === true}
                    disabled={watchBusy || tool.watchAttachedChats === undefined}
                    onChange={() => onWatch(tool)} />}
                />
              )}
              {description && <Typography>{description}</Typography>}
              <Typography variant="subtitle2">Input JSON Schema</Typography>
              <JsonView value={inputSchema} />
              {outputSchema != null && (
                <>
                  <Typography variant="subtitle2">
                    Output JSON Schema
                  </Typography>
                  <JsonView value={outputSchema} />
                </>
              )}
              {!!Object.keys(metadata).length && (
                <>
                  <Typography variant="subtitle2">
                    Additional metadata
                  </Typography>
                  <JsonView value={metadata} />
                </>
              )}
            </Stack>
          </Paper>
        </Box>
      ) : (
        <Typography>No discovered tools.</Typography>
      )}
    </>
  );
}
export function McpDetails({
  item,
  onChange,
  close,
}: {
  item: McpConnection;
  onChange?: (item: McpConnection) => void;
  close: () => void;
}) {
  const [removing, setRemoving] = useState<McpTool>();
  const [busy, setBusy] = useState(false);
  const [removeError, setRemoveError] = useState("");
  const [catalog, setCatalog] = useState<McpCatalog>(),
    [error, setError] = useState(""),
    [loadError, setLoadError] = useState("");
  useEffect(() => {
    if (busy) return;
    return observeMcpSnapshot<McpCatalog>("/" + item.connectionId, value => {
      setCatalog(value);
      setLoadError("");
    }, e => setLoadError(e.message));
  }, [item.connectionId, busy]);
  const connection = catalog?.connection ?? item;
  return (
    <Dialog
      open
      onClose={close}
      maxWidth={false}
      slotProps={{
        paper: {
          sx: {
            width: "90vw",
            height: "85dvh",
            maxHeight: "85dvh",
            maxWidth: "90vw",
            m: 0,
            overflow: "hidden",
          },
        },
      }}
      aria-labelledby="mcp-catalog-title"
    >
      <Box
        component="header"
        sx={{
          flexShrink: 0,
          px: { xs: 2, sm: 3 },
          py: 1.5,
          maxHeight: "35%",
          overflow: "auto",
          overflowWrap: "anywhere",
        }}
      >
        <DialogTitle id="mcp-catalog-title" sx={{ p: 0 }}>
          {connection.name}
        </DialogTitle>
        <Typography variant="body2" sx={{ whiteSpace: "pre-wrap" }}>
          {connection.description}
        </Typography>
        <Typography variant="caption">
          {connectionStatus(connection)} · {connection.toolCount} tools · Last
          successful discovery{" "}
          {connection.lastSuccess == null
            ? "—"
            : new Date(connection.lastSuccess).toLocaleString()}
        </Typography>
      </Box>
      <DialogContent
        dividers
        sx={{
          flex: "1 1 0",
          minHeight: 0,
          overflow: "hidden",
          p: { xs: 1, sm: 2 },
        }}
      >
        {(error || loadError) && <Alert severity="error">{error || loadError}</Alert>}
        {catalog ? (
          <CatalogContents
            catalog={catalog}
            watchBusy={busy}
            onWatch={async (tool) => {
              setBusy(true);
              setError("");
              try {
                const next = await mcpRequest<McpCatalog>(
                  `/${connection.connectionId}/tools/${tool.toolId}/watch-policy`,
                  "PUT",
                  {
                    revision: connection.revision,
                    enabled: !tool.watchAttachedChats,
                  },
                );
                setCatalog(next);
                onChange?.(next.connection);
              } catch (e) {
                setError(
                  e instanceof Error
                    ? e.message
                    : "Could not change automatic watching.",
                );
              } finally {
                setBusy(false);
              }
            }}
            onRemove={(tool) => {
              setRemoveError("");
              setRemoving(tool);
            }}
          />
        ) : !loadError && <CircularProgress aria-label="Loading catalog" />}
      </DialogContent>
      <DialogActions>
        <Button onClick={close}>Close</Button>
      </DialogActions>
      {removing && (
        <Dialog
          open
          onClose={() => {
            if (!busy) setRemoving(undefined);
          }}
          aria-labelledby="remove-local-tool"
        >
          <DialogTitle id="remove-local-tool">
            Remove {removing.originalName}?
          </DialogTitle>
          <DialogContent>
            <Typography>
              This removes the local tool and stops its automatic watches in
              every chat. Future catalog refreshes will keep it removed.
            </Typography>
            {removeError && <Alert severity="error">{removeError}</Alert>}
          </DialogContent>
          <DialogActions>
            <Button disabled={busy} onClick={() => setRemoving(undefined)}>
              Cancel
            </Button>
            <Button
              color="error"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const next = await mcpRequest<McpCatalog>(
                    `/${connection.connectionId}/tools/${removing.toolId}`,
                    "DELETE",
                    { revision: connection.revision },
                  );
                  setCatalog(next);
                  onChange?.(next.connection);
                  setRemoving(undefined);
                } catch (e) {
                  setRemoveError(
                    e instanceof Error
                      ? e.message
                      : "Could not remove the local tool.",
                  );
                } finally {
                  setBusy(false);
                }
              }}
            >
              Remove
            </Button>
          </DialogActions>
        </Dialog>
      )}
    </Dialog>
  );
}
