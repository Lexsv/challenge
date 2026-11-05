import { useEffect, useRef, useState } from "react";
import { Box, Button, Typography } from "@mui/material";
import { alpha } from "@mui/material/styles";

// Measure laid-out content, including line wrapping, and release observation on unmount.
export function observeAnswerOverflow(
  element: HTMLElement,
  onChange: (overflow: boolean) => void,
) {
  const measure = () => onChange(element.scrollHeight > element.clientHeight);
  measure();
  const observer = new ResizeObserver(measure);
  observer.observe(element);
  return () => observer.disconnect();
}

export function AnswerPreview({
  text,
  expertName,
  onMore,
}: {
  text: string;
  expertName: string;
  onMore: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState(false);
  useEffect(() => {
    if (ref.current) return observeAnswerOverflow(ref.current, setOverflow);
  }, [text]);
  return (
    <Box sx={{ minWidth: 0 }}>
      <Typography
        ref={ref}
        component="div"
        variant="body2"
        role="region"
        aria-label={`Answer from ${expertName}`}
        tabIndex={text ? 0 : undefined}
        sx={{
          maxHeight: "6em",
          lineHeight: 1.5,
          overflowY: "auto",
          overflowX: "hidden",
          whiteSpace: "pre-wrap",
          overflowWrap: "anywhere",
          wordBreak: "break-word",
          scrollbarWidth: "thin",
          scrollbarColor: (theme) =>
            `${alpha(theme.palette.primary.main, 0.55)} ${alpha(theme.palette.primary.main, 0.08)}`,
          "&::-webkit-scrollbar": { width: 7 },
          "&::-webkit-scrollbar-thumb": {
            bgcolor: (theme) => alpha(theme.palette.primary.main, 0.55),
            borderRadius: 8,
          },
          "&::-webkit-scrollbar-track": {
            bgcolor: (theme) => alpha(theme.palette.primary.main, 0.08),
            borderRadius: 8,
          },
          "&:focus-visible": {
            outline: "2px solid",
            outlineColor: "primary.main",
            outlineOffset: 3,
          },
        }}
      >
        {text || "—"}
      </Typography>
      {overflow && (
        <Button
          size="small"
          variant="text"
          aria-label={`More: answer preview for ${expertName}`}
          aria-haspopup="dialog"
          onClick={onMore}
          sx={{
            mt: 0.25,
            p: 0,
            minWidth: 0,
            fontSize: "0.75rem",
            "&:focus-visible": {
              outline: "2px solid",
              outlineColor: "primary.main",
              outlineOffset: 3,
            },
          }}
        >
          More
        </Button>
      )}
    </Box>
  );
}
