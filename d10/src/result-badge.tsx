import { vintagePalette as p } from "./vintage-palette";
import { Chip, CircularProgress, Tooltip } from "@mui/material";
import { alpha } from "@mui/material/styles";
import { statusLabel } from "./labels";

export function ResultBadge({
  value,
  automated = false,
  explanation,
  manual = false,
}: {
  value: string;
  automated?: boolean;
  explanation?: string;
  manual?: boolean;
}) {
  const label = statusLabel(value);
  const tone =
    value === "correct" || value === "succeeded"
      ? p.success
      : value === "incorrect" || value === "failed"
        ? p.error
        : ["incomplete", "timed-out", "unable_to_assess"].includes(value)
          ? p.warning
          : value === "running"
            ? p.muted
            : p.muted;
  const description = manual
    ? `Manual verdict: ${label}`
    : automated
      ? `AI evaluation: ${label}`
      : `Technical status: ${label}`;
  return (
    <Tooltip
      describeChild
      title={`${description}. ${explanation || ""}`.trim()}
      slotProps={{
        popper: {
          popperOptions: { strategy: "fixed" },
          modifiers: [
            {
              name: "preventOverflow",
              options: { rootBoundary: "viewport", altAxis: true, padding: 8 },
            },
            { name: "flip", options: { rootBoundary: "viewport", padding: 8 } },
          ],
        },
        tooltip: {
          sx: {
            maxWidth: "min(360px, calc(100vw - 48px))",
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
            fontSize: "0.8125rem",
            lineHeight: 1.5,
          },
        },
      }}
    >
      <Chip
        size="small"
        label={manual ? `Manual: ${label}` : label}
        aria-label={description}
        tabIndex={0}
        icon={
          value === "running" ? (
            <CircularProgress size={11} thickness={5} aria-hidden="true" />
          ) : undefined
        }
        sx={{
          height: manual ? "auto" : 24,
          minHeight: 24,
          maxWidth: "100%",
          fontSize: "0.75rem",
          fontWeight: 600,
          color: tone,
          bgcolor: alpha(tone, 0.1),
          border: "1px solid",
          borderColor: alpha(tone, 0.18),
          "&:focus-visible": {
            outline: "2px solid",
            outlineColor: "primary.dark",
            outlineOffset: 3,
          },
          "& .MuiChip-label": {
            px: 0.75,
            whiteSpace: manual ? "normal" : "nowrap",
            overflowWrap: "anywhere",
            overflow: "visible",
            textOverflow: "clip",
          },
          "& .MuiChip-icon": { color: tone, ml: 0.75, mr: 0 },
        }}
      />
    </Tooltip>
  );
}
