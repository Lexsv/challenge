import { Chip, Stack } from "@mui/material";
import { capabilities, resolveExpert, type Expert } from "./models";
import { statusLabel } from "./labels";

export function expertConfigurationLabels(
  expert: Expert,
  defaultModel: string,
) {
  const resolved = resolveExpert(expert, defaultModel);
  const efforts = capabilities(resolved.model)?.reasoningEfforts;
  const reasoning = !efforts
    ? "Default"
    : !efforts.length ||
        (resolved.reasoning && !efforts.includes(resolved.reasoning))
      ? "Not supported"
      : resolved.reasoning
        ? statusLabel(resolved.reasoning)
        : "Default";
  return [
    `Model: ${resolved.model}`,
    `Reasoning: ${reasoning}`,
    `Output limit: ${resolved.maxTokens}`,
  ];
}

export function ExpertConfigurationChips({
  expert,
  defaultModel,
}: {
  expert: Expert;
  defaultModel: string;
}) {
  return (
    <Stack
      direction="row"
      useFlexGap
      flexWrap="wrap"
      spacing={0.75}
      sx={{ minWidth: 0 }}
    >
      {expertConfigurationLabels(expert, defaultModel).map((label) => (
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
