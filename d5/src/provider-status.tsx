import { CircularProgress, Stack, Typography } from "@mui/material";
import CheckCircleOutline from "@mui/icons-material/CheckCircleOutline";
import ErrorOutline from "@mui/icons-material/ErrorOutline";
import HelpOutline from "@mui/icons-material/HelpOutline";
import type { VerificationStatus } from "./connection";

export function ProviderStatus({
  verification,
}: {
  verification: VerificationStatus;
}) {
  const status =
    verification === "verified"
      ? "Verified"
      : verification === "failed"
        ? "Verification failed"
        : verification === "verifying"
          ? "Verifying"
          : "Not verified";
  const icon =
    verification === "verified" ? (
      <CheckCircleOutline sx={{ color: "#28733F" }} />
    ) : verification === "failed" ? (
      <ErrorOutline sx={{ color: "#A43B35" }} />
    ) : verification === "verifying" ? (
      <CircularProgress size={18} sx={{ color: "text.secondary" }} />
    ) : (
      <HelpOutline sx={{ color: "text.secondary" }} />
    );
  return (
    <Stack
      direction="row"
      spacing={0.75}
      alignItems="center"
      role="status"
      aria-label={`OpenAI: ${status}`}
      sx={{ minWidth: 0, "& svg": { fontSize: 20, flexShrink: 0 } }}
    >
      {icon}
      <Typography
        variant="body2"
        sx={{ fontWeight: 650, overflowWrap: "anywhere" }}
      >
        OpenAI · {status}
      </Typography>
    </Stack>
  );
}
