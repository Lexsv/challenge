import { useId, type ReactNode } from "react";
import { Box } from "@mui/material";

export const chatStatusColor = (status: string) =>
  status === "completed"
    ? "success.main"
    : status === "failed"
      ? "error.main"
      : status === "running"
        ? "text.secondary"
        : status === "error"
          ? "warning.main"
          : "text.primary";

// Native details keeps each disclosure independent and keyboard accessible.
// Leaving the children mounted preserves a step's expansion when Logs is closed.
export function ChatDisclosure({
  label,
  children,
}: {
  label: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <Box
      component="details"
      sx={{
        minWidth: 0,
        width: "100%",
        "& > summary": {
          cursor: "pointer",
          listStyle: "none",
          display: "flex",
          alignItems: "center",
          gap: 0.75,
          width: "fit-content",
          maxWidth: "100%",
          py: 0.4,
          borderRadius: 0.5,
          "&::-webkit-details-marker": { display: "none" },
          "&:focus-visible": {
            outline: "2px solid",
            outlineColor: "primary.main",
            outlineOffset: 3,
          },
        },
        "& > summary::after": {
          content: '""',
          flexShrink: 0,
          width: 6,
          height: 6,
          borderRight: "1.5px solid currentColor",
          borderBottom: "1.5px solid currentColor",
          transform: "rotate(-45deg)",
          transition: "transform .12s",
        },
        "&[open] > summary::after": { transform: "rotate(45deg)" },
      }}
    >
      <Box component="summary" aria-controls={id}>
        {label}
      </Box>
      <Box id={id} sx={{ pl: 1.75, pt: 0.5, minWidth: 0 }}>
        {children}
      </Box>
    </Box>
  );
}
