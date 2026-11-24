import { Chip, Stack } from "@mui/material";
import { resolveExpert, type Expert } from "./models";
import type { ProviderRegistry } from "./provider-registry";

export function expertConfigurationLabels(
  expert: Expert,
  defaultModel: string,
  _registry?: ProviderRegistry,
  defaultProvider?: string,
) {
  const resolved = resolveExpert(expert, defaultModel, defaultProvider);
  const seen = new Set<string>();
  return [
    `Model: ${resolved.model}`,
    ...(resolved.parameters ?? [])
      .filter((p) => {
        if (!p.enabled || !p.key.trim() || !p.value.trim() || seen.has(p.key)) return false;
        seen.add(p.key);
        return true;
      })
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
