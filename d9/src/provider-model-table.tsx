import { ModelCapabilitiesCell, CapabilitiesCardProvider } from "./model-capabilities-cell";
import {
  Box,
  IconButton,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from "@mui/material";
import CheckCircle from "@mui/icons-material/CheckCircle";
import SettingsOutlined from "@mui/icons-material/SettingsOutlined";
import { resolvePrice } from "./opencode-catalog";
import type { ProviderRegistry } from "./provider-registry";

export type ModelView = "models" | "pricing" | "limits";

export function ProviderModelTable({
  ids,
  provider,
  selectedModel,
  view,
  registry,
  onConfigure,
}: {
  ids: readonly string[];
  provider: string;
  selectedModel: string;
  view: ModelView;
  registry: ProviderRegistry;
  onConfigure: (model: string) => void;
}) {
  if (!ids.length)
    return (
      <Typography color="text.secondary">
        No models are listed for this provider.
      </Typography>
    );
  return (
    <CapabilitiesCardProvider><TableContainer
      tabIndex={0}
      role="region"
      aria-label="Scrollable provider models"
    >
      <Table
        size="small"
        aria-label={`Provider ${view}`}
        sx={{
          minWidth: 450,
          "& thead": { bgcolor: "secondary.main" },
          "& th": { fontWeight: 700 },
        }}
      >
        <TableHead>
          <TableRow>
            <TableCell>Model</TableCell>
            {view === "models" && (
              <>
                <TableCell>Structured output</TableCell>
                {provider === "opencode-console" && <TableCell sx={{width:120}}>Capabilities</TableCell>}
                <TableCell sx={{ width: 92 }}>Options</TableCell>
              </>
            )}
            {view === "pricing" && (
              <>
                <TableCell>Input</TableCell>
                <TableCell>Output</TableCell>
                <TableCell>Rate basis</TableCell>
              </>
            )}
            {view === "limits" && (
              <>
                <TableCell>Maximum output tokens</TableCell>
                <TableCell>Reasoning levels</TableCell>
              </>
            )}
          </TableRow>
        </TableHead>
        <TableBody>
          {ids.map((id) => {
            const capabilities = registry.capabilitiesFor(provider, id);
            const price =
              provider === "opencode-console" ? resolvePrice(id) : undefined;
            return (
              <TableRow key={id}>
                <TableCell
                  component="th"
                  scope="row"
                  sx={{ overflowWrap: "anywhere" }}
                >
                  {id}
                </TableCell>
                {view === "models" && (
                  <>
                    <TableCell>
                      {capabilities
                        ? capabilities.structuredOutput
                          ? "Supported"
                          : "Unsupported"
                        : "Unavailable"}
                    </TableCell>
                    {provider === "opencode-console" && <TableCell><ModelCapabilitiesCell model={id} features={registry.get(provider)?.modelFeatures?.(id)} /></TableCell>}
                    <TableCell>
                      <Box sx={{ display: "grid", gridTemplateColumns: "28px 32px", alignItems: "center", justifyItems: "center" }}>
                        <Box sx={{ gridColumn: 1, gridRow: 1, display: "flex" }}>
                          {selectedModel === id && (
                            <CheckCircle color="success" fontSize="small" titleAccess="Default model" />
                          )}
                        </Box>
                        <IconButton
                          size="small"
                          sx={{ gridColumn: 2, gridRow: 1 }}
                          onClick={() => onConfigure(id)}
                          aria-label={`Configure model ${id}`}
                        >
                          <SettingsOutlined fontSize="small" />
                        </IconButton>
                      </Box>
                    </TableCell>
                  </>
                )}
                {view === "pricing" && (
                  <>
                    <TableCell>
                      {price?.input.value == null
                        ? "Unavailable"
                        : `$${price.input.value}`}
                    </TableCell>
                    <TableCell>
                      {price?.output.value == null
                        ? "Unavailable"
                        : `$${price.output.value}`}
                    </TableCell>
                    <TableCell>
                      {price?.sourceDate
                        ? `USD ${price.unit} · catalog ${price.sourceDate}`
                        : "Unavailable"}
                    </TableCell>
                  </>
                )}
                {view === "limits" && (
                  <>
                    <TableCell>
                      {capabilities?.maxOutputTokens.toLocaleString("en-US") ??
                        "Unavailable"}
                    </TableCell>
                    <TableCell>
                      {capabilities?.reasoningEfforts?.join(", ") ||
                        "Unavailable"}
                    </TableCell>
                  </>
                )}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </TableContainer></CapabilitiesCardProvider>
  );
}
