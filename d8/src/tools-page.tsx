import { Fragment, useMemo, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Chip,
  Collapse,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  MenuItem,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tab,
  Tabs,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import Add from "@mui/icons-material/Add";
import Close from "@mui/icons-material/Close";
import CalculateOutlined from "@mui/icons-material/CalculateOutlined";
import LanguageOutlined from "@mui/icons-material/LanguageOutlined";
import SmartToyOutlined from "@mui/icons-material/SmartToyOutlined";
import BuildOutlined from "@mui/icons-material/BuildOutlined";
import SettingsOutlined from "@mui/icons-material/SettingsOutlined";
import DeleteOutline from "@mui/icons-material/DeleteOutline";
import ChevronRight from "@mui/icons-material/ChevronRight";
import type { Expert } from "./models";
import type { ToolCatalogItem, ToolRegistry } from "./tool-runtime";
import { toolExecutionTypeMeta } from "./tool-execution-type";

const toolTypes = ["Function", "API Tool", "AI Agent Tool"] as const;
type ToolType = (typeof toolTypes)[number];
type RequestParameter = {
  id: number;
  name: string;
  location: string;
  example: string;
};

const examples: Record<ToolType, string> = {
  Function:
    "Name: calculate_discount\n\nInputs:\n  price: number\n  discount: number\n\nFormula:\n  result = price * (1 - discount / 100)\n\nOutput:\n  result: number",
  "API Tool":
    'Name: currency_converter\nMethod: GET\nEndpoint: https://api.example.com/convert\n\nQuery parameters:\n  from: USD\n  to: CAD\n  amount: 100\n\nResult path: result\nExample response: { "result": 136.25 }',
  "AI Agent Tool":
    "Name: math_expert\nAgent: Analyst\n\nDescription:\n  Ask the selected agent to solve a specialized math problem.",
};

type FunctionConfig = { definition: string };
type ApiConfig = {
  endpoint: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  resultPath: string;
  parameters: RequestParameter[];
};
type AgentToolConfig = { agentId: string };
type ToolConfigMap = {
  Function: FunctionConfig;
  "API Tool": ApiConfig;
  "AI Agent Tool": AgentToolConfig;
};

export type ToolRecord = {
  id: string;
  name: string;
  type: ToolType;
  description: string;
  config: ToolConfigMap[ToolType];
};

type ToolDraft = {
  id: string;
  name: string;
  type: ToolType;
  description: string;
  config: ToolConfigMap[ToolType];
};

type RawPreview = "raw" | "preview";

const typeIcons = {
  Function: CalculateOutlined,
  "API Tool": LanguageOutlined,
  "AI Agent Tool": SmartToyOutlined,
} as const;

const typeDescriptions: Record<ToolType, string> = {
  Function: "Define a function using inputs, a formula, and an output.",
  "API Tool":
    "Configure an HTTP request and identify the response value to use.",
  "AI Agent Tool": "Reference an existing agent for a specialized task.",
};

function emptyConfig(type: ToolType): ToolConfigMap[ToolType] {
  if (type === "Function") return { definition: "" };
  if (type === "API Tool")
    return { endpoint: "", method: "GET", resultPath: "", parameters: [] };
  return { agentId: "" };
}

function createDraft(type: ToolType): ToolDraft {
  return {
    id: crypto.randomUUID(),
    type,
    name: "",
    description: "",
    config: emptyConfig(type),
  };
}

function editDraft(tool: ToolRecord): ToolDraft {
  return structuredClone(tool);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function pseudocodePreviewHtml(source: string): string {
  const escaped = escapeHtml(source);
  const token =
    /(\/\/.*$|#.*$)|\b(if|then|else|for|while|return|function|input|output|let|set)\b|(-?\d+(?:\.\d+)?)|(\+|\-|\*|\/|!=|<=|>=|=|<|>)/gim;
  return escaped.replace(
    token,
    (match, comment: string, keyword: string, number: string, operator: string) => {
      if (comment)
        return `<span style="color:#5f6b7a;font-style:italic">${match}</span>`;
      if (keyword)
        return `<span style="color:#6b3fd4;font-weight:600">${match}</span>`;
      if (number) return `<span style="color:#0b6e99">${match}</span>`;
      if (operator) return `<span style="color:#7a4e0b">${match}</span>`;
      return match;
    },
  );
}

export function rawToolConfiguration(tool: ToolRecord, agents: readonly Expert[]): string {
  if (tool.type === "Function") return (tool.config as FunctionConfig).definition;
  if (tool.type === "API Tool") {
    const config = tool.config as ApiConfig;
    return [
      `method: ${config.method}`,
      `endpoint: ${config.endpoint}`,
      `resultPath: ${config.resultPath || "(none)"}`,
      `parameters: ${JSON.stringify(config.parameters, null, 2)}`,
    ].join("\n");
  }
  const config = tool.config as AgentToolConfig;
  const agent = agents.find((item) => item.id === config.agentId);
  return [
    `agentId: ${config.agentId || "(none)"}`,
    `agentName: ${agent?.name ?? "(missing)"}`,
  ].join("\n");
}

function CodeBlock({ source, highlighted = false }: { source: string; highlighted?: boolean }) {
  return (
    <Box
      component="pre"
      sx={{
        p: 2,
        borderRadius: 1.5,
        border: 1,
        borderColor: "divider",
        bgcolor: "background.paper",
        whiteSpace: "pre-wrap",
        overflowWrap: "anywhere",
        overflow: "auto",
        maxHeight: 320,
        fontFamily:
          'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
        fontSize: "0.85rem",
      }}
      {...(highlighted
        ? { dangerouslySetInnerHTML: { __html: pseudocodePreviewHtml(source) } }
        : { children: source })}
    />
  );
}

export function validateToolDraft(draft: ToolDraft, agents: Expert[]): string | undefined {
  if (!draft.name.trim()) return "Tool name is required.";
  if (!draft.description.trim()) return "Description is required.";
  if (draft.type === "API Tool") {
    const config = draft.config as ApiConfig;
    if (!config.endpoint.trim()) return "Endpoint URL is required.";
  }
  if (draft.type === "AI Agent Tool") {
    const config = draft.config as AgentToolConfig;
    if (!config.agentId) return "Select an agent for this tool.";
    if (!agents.some((agent) => agent.id === config.agentId))
      return "Selected agent is unavailable.";
  }
  return undefined;
}

export function saveToolRecord(
  tools: readonly ToolRecord[],
  draft: ToolDraft,
  mode: "create" | "edit",
): ToolRecord[] {
  if (mode === "edit")
    return tools.map((tool) =>
      tool.id === draft.id ? structuredClone(draft) : structuredClone(tool),
    );
  return [...tools.map((tool) => structuredClone(tool)), structuredClone(draft)];
}

export function deleteToolRecord(
  tools: readonly ToolRecord[],
  id: string,
): ToolRecord[] {
  return tools.filter((tool) => tool.id !== id).map((tool) => structuredClone(tool));
}

function ToolDialog({
  draft,
  mode,
  agents,
  onSave,
  onClose,
}: {
  draft: ToolDraft;
  mode: "create" | "edit";
  agents: Expert[];
  onSave: (draft: ToolDraft) => void;
  onClose: () => void;
}) {
  const [localDraft, setLocalDraft] = useState<ToolDraft>(() => structuredClone(draft));
  const [error, setError] = useState("");
  const [functionTab, setFunctionTab] = useState<RawPreview>("raw");
  const type = localDraft.type;
  const config = localDraft.config;
  const updateParameter = (id: number, change: Partial<RequestParameter>) =>
    setLocalDraft((current) => ({
      ...current,
      config: {
        ...(current.config as ApiConfig),
        parameters: (current.config as ApiConfig).parameters.map((row) =>
          row.id === id ? { ...row, ...change } : row,
        ),
      },
    }));

  const title = mode === "create" ? "Create Tool" : "Edit Tool";
  const saveLabel = mode === "create" ? "Create Tool" : "Save";
  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="lg" aria-labelledby="tool-dialog-title">
      <DialogTitle id="tool-dialog-title" sx={{ pr: 7 }}>
        {title} <Chip label={type} sx={{ ml: 1, bgcolor: "secondary.main" }} />
        <IconButton
          aria-label={`Close ${title}`}
          onClick={onClose}
          sx={{ position: "absolute", right: 12, top: 12 }}
        >
          <Close />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers>
        <Box
          sx={{
            display: "grid",
            gridTemplateColumns: {
              xs: "minmax(0, 1fr)",
              md: "minmax(0, 1.2fr) minmax(0, 1fr)",
            },
            gap: 3,
          }}
        >
          <Stack spacing={2} sx={{ pt: 1 }}>
            <TextField
              label="Name"
              required
              value={localDraft.name}
              onChange={(event) =>
                setLocalDraft((current) => ({ ...current, name: event.target.value }))
              }
            />
            <TextField
              label="Description"
              required
              multiline
              minRows={3}
              value={localDraft.description}
              onChange={(event) =>
                setLocalDraft((current) => ({
                  ...current,
                  description: event.target.value,
                }))
              }
            />
            {type === "Function" && (
              <Box>
                <Typography variant="subtitle1" fontWeight={700} sx={{ mb: 1 }}>
                  Pseudocode
                </Typography>
                <Tabs
                  value={functionTab}
                  onChange={(_, next: RawPreview) => setFunctionTab(next)}
                  aria-label="Pseudocode mode"
                  sx={{ mb: 1 }}
                >
                  <Tab value="raw" label="Raw" />
                  <Tab value="preview" label="Preview" />
                </Tabs>
                {functionTab === "raw" ? (
                  <TextField
                    label="Pseudocode"
                    multiline
                    minRows={6}
                    value={(config as FunctionConfig).definition}
                    onChange={(event) =>
                      setLocalDraft((current) => ({
                        ...current,
                        config: { definition: event.target.value },
                      }))
                    }
                  />
                ) : (
                  <CodeBlock source={(config as FunctionConfig).definition} highlighted />
                )}
              </Box>
            )}
            {type === "API Tool" && (
              <Paper variant="outlined" sx={{ p: 2, minWidth: 0 }}>
                <Stack spacing={2}>
                  <Typography variant="h6">API Configuration</Typography>
                  <TextField
                    label="Endpoint (URL)"
                    type="url"
                    required
                    value={(config as ApiConfig).endpoint}
                    onChange={(event) =>
                      setLocalDraft((current) => ({
                        ...current,
                        config: {
                          ...(current.config as ApiConfig),
                          endpoint: event.target.value,
                        },
                      }))
                    }
                  />
                  <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
                    <TextField
                      select
                      label="Method"
                      value={(config as ApiConfig).method}
                      required
                      onChange={(event) =>
                        setLocalDraft((current) => ({
                          ...current,
                          config: {
                            ...(current.config as ApiConfig),
                            method: event.target.value as ApiConfig["method"],
                          },
                        }))
                      }
                    >
                      {["GET", "POST", "PUT", "PATCH", "DELETE"].map((method) => (
                        <MenuItem key={method} value={method}>
                          {method}
                        </MenuItem>
                      ))}
                    </TextField>
                    <TextField
                      label="Result path (JSON, optional)"
                      value={(config as ApiConfig).resultPath}
                      onChange={(event) =>
                        setLocalDraft((current) => ({
                          ...current,
                          config: {
                            ...(current.config as ApiConfig),
                            resultPath: event.target.value,
                          },
                        }))
                      }
                    />
                  </Stack>
                  <TableContainer>
                    <Table size="small" aria-label="Request parameters" sx={{ minWidth: 360 }}>
                      <TableHead>
                        <TableRow>
                          <TableCell>NAME</TableCell>
                          <TableCell>IN</TableCell>
                          <TableCell>VALUE / EXAMPLE</TableCell>
                          <TableCell>DELETE</TableCell>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {(config as ApiConfig).parameters.map((row, index) => (
                          <TableRow key={row.id}>
                            <TableCell>
                              <TextField
                                value={row.name}
                                onChange={(event) =>
                                  updateParameter(row.id, { name: event.target.value })
                                }
                                slotProps={{
                                  htmlInput: {
                                    "aria-label": `Parameter ${index + 1} name`,
                                  },
                                }}
                              />
                            </TableCell>
                            <TableCell>
                              <TextField
                                select
                                value={row.location}
                                onChange={(event) =>
                                  updateParameter(row.id, { location: event.target.value })
                                }
                                SelectProps={{
                                  inputProps: {
                                    "aria-label": `Parameter ${index + 1} location`,
                                  },
                                }}
                              >
                                {["query", "path", "body"].map((location) => (
                                  <MenuItem key={location} value={location}>
                                    {location}
                                  </MenuItem>
                                ))}
                              </TextField>
                            </TableCell>
                            <TableCell>
                              <TextField
                                value={row.example}
                                onChange={(event) =>
                                  updateParameter(row.id, {
                                    example: event.target.value,
                                  })
                                }
                                slotProps={{
                                  htmlInput: {
                                    "aria-label": `Parameter ${index + 1} example`,
                                  },
                                }}
                              />
                            </TableCell>
                            <TableCell>
                              <IconButton
                                aria-label={`Delete request parameter ${index + 1}`}
                                onClick={() =>
                                  setLocalDraft((current) => ({
                                    ...current,
                                    config: {
                                      ...(current.config as ApiConfig),
                                      parameters: (current.config as ApiConfig).parameters.filter(
                                        (item) => item.id !== row.id,
                                      ),
                                    },
                                  }))
                                }
                              >
                                <Close fontSize="small" />
                              </IconButton>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </TableContainer>
                  <Box>
                    <Button
                      startIcon={<Add />}
                      onClick={() =>
                        setLocalDraft((current) => ({
                          ...current,
                          config: {
                            ...(current.config as ApiConfig),
                            parameters: [
                              ...(current.config as ApiConfig).parameters,
                              {
                                id:
                                  ((current.config as ApiConfig).parameters.at(-1)?.id ?? 0) +
                                  1,
                                name: "",
                                location: "query",
                                example: "",
                              },
                            ],
                          },
                        }))
                      }
                    >
                      Add parameter
                    </Button>
                  </Box>
                </Stack>
              </Paper>
            )}
            {type === "AI Agent Tool" && (
              <TextField
                select
                required
                label="Agent"
                value={(config as AgentToolConfig).agentId}
                onChange={(event) =>
                  setLocalDraft((current) => ({
                    ...current,
                    config: { agentId: event.target.value },
                  }))
                }
                helperText={
                  agents.length
                    ? "References the selected agent."
                    : "Create an agent in the Agents tab first."
                }
              >
                <MenuItem value="" disabled>
                  Select an agent
                </MenuItem>
                {agents.map((agent) => (
                  <MenuItem key={agent.id} value={agent.id}>
                    {agent.name}
                  </MenuItem>
                ))}
              </TextField>
            )}
          </Stack>
          <Paper
            variant="outlined"
            sx={{
              p: 2.5,
              bgcolor: "secondary.main",
              alignSelf: "start",
              minWidth: 0,
            }}
          >
            <Typography variant="h6">Example</Typography>
            <Typography variant="body2" color="text.secondary">
              Use this example to describe what the tool should do.
            </Typography>
            <Box
              component="pre"
              sx={{
                p: 2,
                borderRadius: 1.5,
                bgcolor: "background.paper",
                whiteSpace: "pre-wrap",
                overflowWrap: "anywhere",
                fontSize: "0.85rem",
              }}
            >
              {examples[type]}
            </Box>
          </Paper>
        </Box>
        {error && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {error}
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="contained"
          onClick={() => {
            const issue = validateToolDraft(localDraft, agents);
            if (issue) {
              setError(issue);
              return;
            }
            onSave(localDraft);
          }}
        >
          {saveLabel}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function ToolDetailsDialog({
  tool,
  agents,
  onClose,
}: {
  tool: ToolRecord;
  agents: Expert[];
  onClose: () => void;
}) {
  const [tab, setTab] = useState<RawPreview>("preview");
  const agent =
    tool.type === "AI Agent Tool"
      ? agents.find((item) => item.id === (tool.config as AgentToolConfig).agentId)
      : undefined;
  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="md" aria-labelledby="tool-details-title">
      <DialogTitle id="tool-details-title" sx={{ pr: 7 }}>
        {tool.name} <Chip label={tool.type} sx={{ ml: 1, bgcolor: "secondary.main" }} />
        <IconButton
          aria-label="Close Tool Details"
          onClick={onClose}
          sx={{ position: "absolute", right: 12, top: 12 }}
        >
          <Close />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2}>
          <Typography color="text.secondary">{tool.description}</Typography>
          <Tabs
            value={tab}
            onChange={(_, next: RawPreview) => setTab(next)}
            aria-label="Tool details mode"
          >
            <Tab value="raw" label="Raw" />
            <Tab value="preview" label="Preview" />
          </Tabs>
          {tab === "raw" ? (
            <CodeBlock
              source={
                tool.type === "Function"
                  ? (tool.config as FunctionConfig).definition
                  : rawToolConfiguration(tool, agents)
              }
              highlighted={tool.type === "Function"}
            />
          ) : tool.type === "Function" ? (
            <CodeBlock source={(tool.config as FunctionConfig).definition} highlighted />
          ) : tool.type === "API Tool" ? (
            <Stack spacing={1}>
              <Typography>
                <strong>Method:</strong> {(tool.config as ApiConfig).method}
              </Typography>
              <Typography sx={{ overflowWrap: "anywhere" }}>
                <strong>Endpoint:</strong> {(tool.config as ApiConfig).endpoint}
              </Typography>
              <Typography>
                <strong>Result path:</strong>{" "}
                {(tool.config as ApiConfig).resultPath || "(none)"}
              </Typography>
              <Typography>
                <strong>Parameters:</strong>
              </Typography>
              <CodeBlock
                source={JSON.stringify((tool.config as ApiConfig).parameters, null, 2)}
              />
            </Stack>
          ) : (
            <Stack spacing={1}>
              <Typography>
                <strong>Agent ID:</strong>{" "}
                {(tool.config as AgentToolConfig).agentId || "(none)"}
              </Typography>
              <Typography>
                <strong>Agent:</strong> {agent?.name ?? "Missing agent reference"}
              </Typography>
              {!!agent?.description && (
                <Typography color="text.secondary">{agent.description}</Typography>
              )}
            </Stack>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}

function TypeSelectionDialog({
  onSelect,
  onClose,
}: {
  onSelect: (type: ToolType) => void;
  onClose: () => void;
}) {
  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="sm" aria-labelledby="add-tool-type-title">
      <DialogTitle id="add-tool-type-title">Add Tool</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={1.5}>
          {toolTypes.map((type) => {
            const Icon = typeIcons[type];
            return (
              <Paper key={type} variant="outlined" sx={{ p: 1.25 }}>
                <Button
                  fullWidth
                  onClick={() => onSelect(type)}
                  sx={{ justifyContent: "flex-start", textAlign: "left", py: 1 }}
                  aria-label={`Select tool type ${type}`}
                >
                  <Stack direction="row" spacing={1.5} alignItems="flex-start">
                    <Box sx={{ display: "flex", p: 1, borderRadius: 1.5, bgcolor: "secondary.main", color: "primary.dark" }}>
                      <Icon fontSize="small" />
                    </Box>
                    <Box>
                      <Typography fontWeight={700}>{type}</Typography>
                      <Typography variant="body2" color="text.secondary">
                        {typeDescriptions[type]}
                      </Typography>
                    </Box>
                  </Stack>
                </Button>
              </Paper>
            );
          })}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
      </DialogActions>
    </Dialog>
  );
}

export function BuiltInToolRow({ tool, expanded = false, onToggle }: {
  tool: ToolCatalogItem; expanded?: boolean; onToggle: () => void;
}) {
  const meta = tool.executionType ? toolExecutionTypeMeta[tool.executionType] : undefined;
  const ExecutionIcon = meta?.icon;
  const nameId = `built-in-${tool.id}-name`;
  const detailsId = `built-in-${tool.id}-details`;
  return <Fragment>
    <TableRow hover>
      <TableCell component="th" scope="row">
        <Button id={nameId} size="small" onClick={onToggle} aria-expanded={expanded} aria-controls={detailsId}
          startIcon={<ChevronRight fontSize="small" sx={{ transform: expanded ? 'rotate(90deg)' : 'none' }} />}
          sx={{ justifyContent: 'flex-start', textAlign: 'left', minWidth: 0, p: 0.5, overflowWrap: 'anywhere' }}>
          {tool.name}
        </Button>
      </TableCell>
      <TableCell>{meta && ExecutionIcon ? <Chip size="small" icon={<ExecutionIcon fontSize="small" />} label={meta.label}
        sx={{ bgcolor: meta.background, color: meta.color, '& .MuiChip-icon': { color: meta.color } }} /> : '—'}</TableCell>
      <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.8rem', overflowWrap: 'anywhere' }}>{tool.id}</TableCell>
      <TableCell><Typography variant="body2" noWrap>{tool.description}</Typography></TableCell>
    </TableRow>
    <TableRow aria-hidden={!expanded}>
      <TableCell colSpan={4} sx={{ py: 0, borderBottom: expanded ? undefined : 0 }}>
        <Collapse in={expanded} timeout="auto">
          <Stack id={detailsId} role="region" aria-labelledby={nameId} spacing={1} sx={{ py: 1.5, minWidth: 0 }}>
            <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>{tool.description}</Typography>
            {tool.inputSchema && <Box sx={{ minWidth: 0 }}>
              <Typography variant="subtitle2">Input schema</Typography>
              <CodeBlock source={JSON.stringify(tool.inputSchema, null, 2)} />
            </Box>}
            {tool.executionType === 'library' && <Typography variant="caption">Runs automatically before each Manager Agent request. Not callable by the model.</Typography>}
          </Stack>
        </Collapse>
      </TableCell>
    </TableRow>
  </Fragment>;
}

export function ToolsPage({
  agents,
  toolRegistry,
  initialTools = [],
}: {
  agents: Expert[];
  toolRegistry: ToolRegistry;
  initialTools?: ToolRecord[];
}) {
  const [tools, setTools] = useState<ToolRecord[]>(() => structuredClone(initialTools));
  const builtInTools = toolRegistry.listBuiltIn();
  const [expandedBuiltIns, setExpandedBuiltIns] = useState<Set<string>>(() => new Set());
  const [typePickerOpen, setTypePickerOpen] = useState(false);
  const [comingSoonOpen, setComingSoonOpen] = useState(false);
  const [editor, setEditor] = useState<
    | {
        mode: "create" | "edit";
        draft: ToolDraft;
      }
    | null
  >(null);
  const [deleteToolId, setDeleteToolId] = useState<string | null>(null);
  const [detailsToolId, setDetailsToolId] = useState<string | null>(null);
  const deleteTool = useMemo(
    () => tools.find((tool) => tool.id === deleteToolId) ?? null,
    [tools, deleteToolId],
  );
  const detailsTool = useMemo(
    () => tools.find((tool) => tool.id === detailsToolId) ?? null,
    [tools, detailsToolId],
  );
  return (
    <Stack spacing={2.5} sx={{ minWidth: 0 }}>
      <Stack
        direction="row"
        gap={2}
        justifyContent="space-between"
        alignItems="center"
        flexWrap="wrap"
      >
        <Box>
          <Typography variant="h4" component="h2">
            Tools
          </Typography>
          <Typography color="text.secondary">
            Create and manage reusable tools for experiments.
          </Typography>
        </Box>
      </Stack>
      <Stack component="section" spacing={1.5} aria-labelledby="built-in-tools-heading" sx={{ minWidth: 0 }}>
        <Typography variant="h5" component="h3" id="built-in-tools-heading">
          Built-in Tools
        </Typography>
        <TableContainer component={Paper} variant="outlined" role="region" aria-labelledby="built-in-tools-heading" tabIndex={0}
          sx={{ maxWidth: '100%', overflowX: 'auto', '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: 2 } }}>
          <Table size="small" aria-label="Built-in tools" sx={{ minWidth: 680, tableLayout: 'fixed' }}>
            <TableHead><TableRow>
              <TableCell scope="col" sx={{ width: '26%' }}>Name</TableCell>
              <TableCell scope="col" sx={{ width: '17%' }}>Type</TableCell>
              <TableCell scope="col" sx={{ width: '26%' }}>Tool ID</TableCell>
              <TableCell scope="col" sx={{ width: '31%' }}>Description</TableCell>
            </TableRow></TableHead>
            <TableBody>{builtInTools.map((tool) => <BuiltInToolRow key={tool.id} tool={tool} expanded={expandedBuiltIns.has(tool.id)}
              onToggle={() => setExpandedBuiltIns((current) => {
                const next = new Set(current);
                if (next.has(tool.id)) next.delete(tool.id); else next.add(tool.id);
                return next;
              })} />)}</TableBody>
          </Table>
        </TableContainer>
      </Stack>
      <Stack component="section" spacing={1.5} aria-labelledby="custom-tools-heading">
        <Stack direction="row" gap={1} justifyContent="space-between" alignItems="center" flexWrap="wrap">
          <Typography variant="h5" component="h3" id="custom-tools-heading">Custom Tools</Typography>
          {tools.length > 0 && <Button variant="contained" startIcon={<Add />} onClick={() => setComingSoonOpen(true)}>Add custom tool</Button>}
        </Stack>
      {tools.length === 0 ? (
        <Paper variant="outlined" sx={{ px: 2, py: { xs: 7, md: 10 } }}>
          <Stack alignItems="center" spacing={1.5} textAlign="center">
            <BuildOutlined color="primary" />
            <Typography variant="h5" component="h3">
              No custom tools yet
            </Typography>
            <Typography color="text.secondary">
              Create your first custom tool to extend your agents&apos; capabilities.
            </Typography>
            <Button variant="contained" startIcon={<Add />} onClick={() => setComingSoonOpen(true)}>
              Add custom tool
            </Button>
          </Stack>
        </Paper>
      ) : (
        <Box
          sx={{
            display: "grid",
            gridTemplateColumns: {
              xs: "1fr",
              sm: "repeat(2, minmax(0, 1fr))",
              lg: "repeat(3, minmax(0, 1fr))",
            },
            gap: 2,
          }}
        >
          {tools.map((tool) => {
            const Icon = typeIcons[tool.type];
            return (
              <Paper
                key={tool.id}
                variant="outlined"
                role="button"
                tabIndex={0}
                onClick={() => setDetailsToolId(tool.id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    setDetailsToolId(tool.id);
                  }
                }}
                sx={{
                  p: 2,
                  borderRadius: 2,
                  minHeight: 210,
                  maxHeight: 240,
                  bgcolor: "background.paper",
                  display: "flex",
                  cursor: "pointer",
                  outline: "none",
                  "&:focus-visible": {
                    boxShadow: (theme) => `0 0 0 2px ${theme.palette.primary.main}`,
                  },
                }}
              >
                <Stack spacing={1.2} sx={{ minWidth: 0, flex: 1 }}>
                  <Stack direction="row" justifyContent="space-between" alignItems="flex-start">
                    <Box sx={{ display: "flex", p: 1, borderRadius: 1.5, bgcolor: "secondary.main", color: "primary.dark" }}>
                      <Icon />
                    </Box>
                    <Stack direction="row" spacing={0.5}>
                      <Tooltip title="Edit tool">
                        <IconButton
                          size="small"
                          aria-label={`Edit tool ${tool.name}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            setEditor({ mode: "edit", draft: editDraft(tool) });
                          }}
                        >
                          <SettingsOutlined fontSize="small" />
                        </IconButton>
                      </Tooltip>
                      <Tooltip title="Delete tool">
                        <IconButton
                          size="small"
                          color="error"
                          aria-label={`Delete tool ${tool.name}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            setDeleteToolId(tool.id);
                          }}
                        >
                          <DeleteOutline fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    </Stack>
                  </Stack>
                  <Typography variant="h6" sx={{ overflowWrap: "anywhere" }}>
                    {tool.name}
                  </Typography>
                  <Chip size="small" label={tool.type} sx={{ alignSelf: "flex-start", bgcolor: "secondary.main" }} />
                  <Typography
                    color="text.secondary"
                    sx={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      display: "-webkit-box",
                      WebkitLineClamp: 5,
                      WebkitBoxOrient: "vertical",
                    }}
                  >
                    {tool.description}
                  </Typography>
                  <Box sx={{ mt: "auto", display: "flex", justifyContent: "flex-end" }}>
                    <Button
                      size="small"
                      endIcon={<ChevronRight fontSize="small" />}
                      onClick={(event) => {
                        event.stopPropagation();
                        setDetailsToolId(tool.id);
                      }}
                    >
                      View Details
                    </Button>
                  </Box>
                </Stack>
              </Paper>
            );
          })}
        </Box>
      )}
      </Stack>
      {typePickerOpen && (
        <TypeSelectionDialog
          onClose={() => setTypePickerOpen(false)}
          onSelect={(type) => {
            setTypePickerOpen(false);
            setEditor({ mode: "create", draft: createDraft(type) });
          }}
        />
      )}
      <Dialog
        open={comingSoonOpen}
        onClose={() => setComingSoonOpen(false)}
        fullWidth
        maxWidth="xs"
        aria-labelledby="add-tool-coming-soon-title"
      >
        <DialogTitle id="add-tool-coming-soon-title">Coming Soon</DialogTitle>
        <DialogContent>
          <Typography color="text.secondary">
            Tool creation is not available yet. This workflow is still in progress.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setComingSoonOpen(false)}>Close</Button>
        </DialogActions>
      </Dialog>
      {editor && (
        <ToolDialog
          mode={editor.mode}
          draft={editor.draft}
          agents={agents}
          onClose={() => setEditor(null)}
          onSave={(draft) => {
            setTools((current) => saveToolRecord(current, draft, editor.mode));
            setEditor(null);
          }}
        />
      )}
      {detailsTool && (
        <ToolDetailsDialog
          tool={detailsTool}
          agents={agents}
          onClose={() => setDetailsToolId(null)}
        />
      )}
      <Dialog open={!!deleteTool} onClose={() => setDeleteToolId(null)} aria-labelledby="delete-tool-title">
        <DialogTitle id="delete-tool-title">Delete tool?</DialogTitle>
        <DialogContent>
          <Typography>Remove {deleteTool?.name} from tools?</Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteToolId(null)}>Cancel</Button>
          <Button
            color="error"
            onClick={() => {
              if (!deleteTool) return;
              setTools((current) => deleteToolRecord(current, deleteTool.id));
              setDeleteToolId(null);
            }}
          >
            Delete tool
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
