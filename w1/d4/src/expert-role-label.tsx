import { Typography } from "@mui/material";

export function ExpertRoleLabel({ roleLabel }: { roleLabel?: string }) {
  if (!roleLabel?.trim()) return null;
  return (
    <Typography
      component="span"
      variant="caption"
      color="text.secondary"
      sx={{
        display: "block",
        mt: 0.25,
        lineHeight: 1.45,
        minWidth: 0,
        maxWidth: "100%",
        overflowWrap: "anywhere",
        whiteSpace: "normal",
      }}
    >
      {roleLabel}
    </Typography>
  );
}
