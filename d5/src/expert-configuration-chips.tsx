import { Chip, Stack } from "@mui/material";
import { resolveExpert, type Expert } from "./models";
import { statusLabel } from "./labels";
import type { ProviderRegistry } from "./provider-registry";

export function expertConfigurationLabels(
  expert: Expert,
  defaultModel: string,
  registry?: ProviderRegistry,
  defaultProvider?: string,
) {
  const resolved = resolveExpert(expert, defaultModel, defaultProvider);
  const capability =
    registry && resolved.provider
      ? registry.get(resolved.provider)?.capabilities(resolved.model)
      : undefined;
  const efforts = capability?.reasoningEfforts;
  const configured = resolved.reasoning;
  const reasoning = !configured
    ? "Unspecified"
    : !efforts
      ? "Unknown"
      : !efforts.length || (configured && !efforts.includes(configured))
        ? "Not supported"
        : statusLabel(configured);
  return [
    `Model: ${resolved.model}`,
    `Reasoning: ${reasoning}`,
    ...(!resolved.parameters ? [`Output limit: ${resolved.maxTokens}`] : []),
    ...(resolved.parameters ?? [])
      .filter((p) => p.enabled)
      .map(
        (p) =>
          `${p.key === "max_output_tokens" ? "Output limit" : p.key}: ${p.value}`,
      ),
  ];
}

export function ExpertConfigurationChips({
  expert,
  defaultModel,
  registry,
  defaultProvider,
}: {
  expert: Expert;
  defaultModel: string;
  registry?: ProviderRegistry;
  defaultProvider?: string;
}) {
  return (
    <Stack
      direction="row"
      useFlexGap
      flexWrap="wrap"
      spacing={0.75}
      sx={{ minWidth: 0 }}
    >
      {expertConfigurationLabels(
        expert,
        defaultModel,
        registry,
        defaultProvider,
      ).map((label) => (
        <Chip
          key={label}
          label={label}
          size="small"
          sx={{
            maxWidth: "100%",
            height: "auto",
            minHeight: 24,
            "& .MuiChip-label": {
              whiteSpace: "normal",
              overflowWrap: "anywhere",
              py: 0.25,
            },
          }}
        />
      ))}
    </Stack>
  );
}
