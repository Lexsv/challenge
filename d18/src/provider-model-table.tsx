import { useState } from "react";
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
  TableSortLabel,
  Typography,
} from "@mui/material";
import CheckCircle from "@mui/icons-material/CheckCircle";
import ArrowDropDown from "@mui/icons-material/ArrowDropDown";
import SettingsOutlined from "@mui/icons-material/SettingsOutlined";
import { tokenPricing, pricingSourceLabels } from "./token-billing.ts";
import { DEFAULT_ENDPOINTS } from "./provider-endpoints.ts";
import { resolvePrice } from "./opencode-catalog";
import type { ProviderRegistry } from "./provider-registry";

export type ModelView = "models" | "pricing" | "limits";

const priceColumns = { input: "Input", output: "Output", cacheRead: "Cache Read", cacheWrite: "Cache Write" } as const;
const buckets = Object.keys(priceColumns) as (keyof typeof priceColumns)[];
type SortColumn = "id" | keyof typeof priceColumns | "source";
type Direction = "asc" | "desc";

function pricingRow(id: string, provider: string, registry: ProviderRegistry) {
  const endpoint = registry.endpointFor(provider);
  const discovered = registry.get(provider)?.limits?.(id)?.price;
  const rates = tokenPricing(provider, id, endpoint, 0, discovered);
  const catalog = provider === "opencode-console" && endpoint === DEFAULT_ENDPOINTS[provider]
    ? resolvePrice(id, discovered) : undefined;
  const apiRate = catalog && buckets.some(bucket => catalog[bucket].source === "API");
  const catalogRate = catalog && buckets.some(bucket => catalog[bucket].source === "Catalog");
  const source = rates ? pricingSourceLabels[rates.source] : apiRate
    ? pricingSourceLabels[catalogRate ? "opencode-mixed" : "opencode-discovery"]
    : catalogRate ? pricingSourceLabels["opencode-catalog"]
    : provider === "opencode-go" ? "Subscription · see provider charge" : undefined;
  return {
    id, source, date: rates?.asOf ?? catalog?.sourceDate,
    perMinute: catalog?.unit === "per minute",
    input: rates?.inputPerMillion ?? catalog?.input.value,
    output: rates?.outputPerMillion ?? catalog?.output.value,
    cacheRead: rates?.cachedInputPerMillion ?? catalog?.cacheRead.value,
    cacheWrite: rates?.cacheWritePerMillion ?? catalog?.cacheWrite.value,
    longWrite: rates?.longCacheWritePerMillion,
  };
}

export function sortedPricingRows(ids: readonly string[], provider: string, registry: ProviderRegistry, column: SortColumn, direction: Direction) {
  return ids.map(id => pricingRow(id, provider, registry)).sort((a, b) => {
    const left = a[column], right = b[column];
    if (left == null && right != null) return 1;
    if (left != null && right == null) return -1;
    const order = typeof left === "number" && typeof right === "number" ? left - right
      : String(left ?? "").localeCompare(String(right ?? ""), "en");
    return (direction === "asc" ? order : -order) || a.id.localeCompare(b.id, "en");
  });
}

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
  const [sort, setSort] = useState<{ column: SortColumn; direction: Direction }>({ column: "id", direction: "asc" });
  const sortHeader = (column: SortColumn, label: string) => (
    <TableCell key={column} sortDirection={sort.column === column ? sort.direction : false}>
      <TableSortLabel active={sort.column === column} direction={sort.column === column ? sort.direction : "asc"}
        IconComponent={ArrowDropDown}
        sx={{
          position: "relative", whiteSpace: "nowrap",
          "& .MuiTableSortLabel-icon": {
            position: "absolute", insetInlineStart: "calc(100% - 2px)", m: 0,
            fontSize: 18, opacity: 1, color: "text.secondary",
          },
          "&.Mui-active, &.Mui-active .MuiTableSortLabel-icon, &:hover, &:focus-visible": { color: "primary.main" },
          "&:focus-visible": { outline: "2px solid currentColor", outlineOffset: 2 },
        }}
        onClick={() => setSort(previous => ({ column, direction: previous.column === column && previous.direction === "asc" ? "desc" : "asc" }))}>
        {label}
      </TableSortLabel>
    </TableCell>
  );
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
          "& th": { fontWeight: 700 },
        }}
      >
        <TableHead>
          <TableRow>
            {view === "pricing" ? sortHeader("id", "Model") : <TableCell>Model</TableCell>}
            {view === "models" && (
              <>
                <TableCell>Structured output</TableCell>
                {provider === "opencode-console" && <TableCell sx={{width:120}}>Capabilities</TableCell>}
                <TableCell sx={{ width: 92 }}>Options</TableCell>
              </>
            )}
            {view === "pricing" && (
              <>
                {buckets.map(bucket => sortHeader(bucket, priceColumns[bucket]))}
                {sortHeader("source", "Rate Base")}
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
          {view === "pricing" ? sortedPricingRows(ids, provider, registry, sort.column, sort.direction).map(row => (
            <TableRow key={row.id}>
              <TableCell component="th" scope="row" sx={{ overflowWrap: "anywhere" }}>{row.id}</TableCell>
              {buckets.map(bucket => <TableCell key={bucket}>
                {row[bucket] == null ? "Unavailable" : `$${row[bucket]}${row.perMinute ? " / min" : ""}`}
                {bucket === "cacheWrite" && row.longWrite !== undefined && ` (30m) / $${row.longWrite} (12h)`}
              </TableCell>)}
              <TableCell>{row.source ?? "Unavailable"}{row.date && ` · ${row.date}`}</TableCell>
            </TableRow>
          )) : ids.map((id) => {
            const capabilities = registry.capabilitiesFor(provider, id);
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
                          disabled={provider === "openai" && !capabilities}
                          aria-label={`Configure model ${id}`}
                        >
                          <SettingsOutlined fontSize="small" />
                        </IconButton>
                      </Box>
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
