import {
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from "@mui/material";
import { alpha } from "@mui/material/styles";
import { totals, type Attempt, type Result } from "./models";
import { formatTokens, seconds } from "./result-format";
import { statusLabel } from "./labels";
export const resultHeadingStyle = {
  fontWeight: 700,
  color: "primary.dark",
} as const;
export type MetadataRow = readonly [string, string];
const duration = (ms?: number) =>
  ms !== undefined && Number.isFinite(ms) && ms >= 0
    ? seconds(ms)
    : "Not available";
export function resultMetadataRows(
  result: Result,
  attempt: Attempt | undefined,
  includeTotals = true,
) {
  const settings: MetadataRow[] = [
    ["Actual model", attempt?.actualModel ?? "Not available"],
    ["Requested model", result.expert.model],
    [
      "Reasoning effort",
      result.expert.reasoning
        ? statusLabel(result.expert.reasoning)
        : "Not available",
    ],
    [
      "Output token limit",
      result.expert.parameters
        ? (() => {
            const row = result.expert.parameters.find(
              (p) => p.enabled && p.key === "max_output_tokens",
            );
            return row ? formatTokens(Number(row.value)) : "Not available";
          })()
        : formatTokens(result.expert.maxTokens),
    ],
  ];
  const metrics: MetadataRow[] = [
    ["Input tokens", formatTokens(attempt?.usage?.input)],
    ["Output tokens", formatTokens(attempt?.usage?.output)],
    ...(attempt?.usage?.reasoning !== undefined
      ? [
          [
            "Reasoning tokens",
            formatTokens(attempt.usage.reasoning),
          ] as MetadataRow,
        ]
      : []),
    [
      "Request duration",
      attempt?.status === "running" ? "Running" : duration(attempt?.ms),
    ],
  ];
  const aggregate = totals(result.attempts);
  if (includeTotals)
    metrics.push(
      [
        "Total input tokens across participant attempts",
        formatTokens(aggregate.input),
      ],
      [
        "Total output tokens across participant attempts",
        formatTokens(aggregate.output),
      ],
      [
        "Total participant request time across attempts",
        result.attempts.some((item) => item.status === "running")
          ? "Running"
          : result.attempts.length &&
              result.attempts.every(
                (item) => Number.isFinite(item.ms) && item.ms >= 0,
              )
            ? duration(result.attempts.reduce((sum, item) => sum + item.ms, 0))
            : "Not available",
      ],
    );
  return { settings, metrics, partial: includeTotals && aggregate.partial };
}
function MetadataTable({
  label,
  firstColumn,
  rows,
  numeric = false,
}: {
  label: string;
  firstColumn: string;
  rows: MetadataRow[];
  numeric?: boolean;
}) {
  return (
    <TableContainer
      component={Paper}
      variant="outlined"
      sx={{ borderRadius: 1, minWidth: 0, maxWidth: "100%" }}
    >
      <Table
        size="small"
        aria-label={label}
        sx={{
          tableLayout: "fixed",
          "& th, & td": {
            px: 1.5,
            py: 0.75,
            overflowWrap: "anywhere",
            verticalAlign: "top",
          },
          "& tbody tr:last-child th, & tbody tr:last-child td": {
            borderBottom: 0,
          },
        }}
      >
        <TableHead
          sx={{
            bgcolor: (theme) => alpha(theme.palette.primary.main, 0.08),
            "& th": {
              ...resultHeadingStyle,
              borderColor: (theme) => alpha(theme.palette.primary.main, 0.25),
            },
          }}
        >
          <TableRow>
            <TableCell sx={{ width: "58%" }}>{firstColumn}</TableCell>
            <TableCell align={numeric ? "right" : "left"}>Value</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.map(([name, value]) => (
            <TableRow key={name}>
              <TableCell component="th" scope="row" sx={{ fontWeight: 400 }}>
                {name}
              </TableCell>
              <TableCell
                align={numeric ? "right" : "left"}
                sx={{
                  fontVariantNumeric: numeric ? "tabular-nums" : undefined,
                }}
              >
                {value}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}
export function ResultMetadata({
  result,
  attempt,
  includeTotals = true,
  labelPrefix = "Participant",
}: {
  result: Result;
  attempt?: Attempt;
  includeTotals?: boolean;
  labelPrefix?: string;
}) {
  const rows = resultMetadataRows(result, attempt, includeTotals);
  return (
    <Stack spacing={1.5} sx={{ minWidth: 0 }}>
      <MetadataTable
        label={`${labelPrefix} captured settings`}
        firstColumn="Setting"
        rows={rows.settings}
      />
      <Typography component="h4" variant="subtitle2" sx={resultHeadingStyle}>
        Usage
      </Typography>
      <MetadataTable
        label={`${labelPrefix} usage`}
        firstColumn="Metric"
        rows={rows.metrics}
        numeric
      />
      {attempt?.usage?.reasoning !== undefined && (
        <Typography variant="caption" color="text.secondary">
          Reasoning tokens are included in output tokens, not added again.
        </Typography>
      )}
      {rows.partial && (
        <Typography variant="caption" color="text.secondary">
          Totals are partial: some attempts did not report complete token usage.
        </Typography>
      )}
    </Stack>
  );
}
