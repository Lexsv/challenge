import { useState } from "react";
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Typography,
} from "@mui/material";
import Close from "@mui/icons-material/Close";
import { AnswerMarkdown } from "./answer-markdown";

export function classifyAnswer(text: string): {
  kind: "json" | "markdown" | "plain";
  formatted: string;
} {
  try {
    const value: unknown = JSON.parse(text);
    if (value !== null && typeof value === "object")
      return { kind: "json", formatted: JSON.stringify(value, null, 2) };
  } catch {
    /* Treat non-JSON as text. */
  }
  const markdown =
    /(^|\n)\s{0,3}(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s?|```|~~~|\|.+\|)|\*\*\S|__\S|\[[^\]]+\]\([^)]+\)|`[^`]+`|(?:^|\s)\*[^*\n]+\*(?:\s|[.,!?]|$)/m.test(
      text,
    );
  return { kind: markdown ? "markdown" : "plain", formatted: text };
}
// Tokenize JSON into React text nodes; no HTML from the response is injected.
function JsonValue({ value }: { value: string }) {
  const pieces = value.split(
    /("(?:\\.|[^"\\])*"(?=\s*:)|"(?:\\.|[^"\\])*"|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
  );
  return (
    <>
      {pieces.map((piece, index) => {
        const color = /^"/.test(piece)
          ? pieces[index + 1]?.trimStart().startsWith(":")
            ? "#705500"
            : "#80512c"
          : /^(?:true|false|null|-?\d)/.test(piece)
            ? "#5b5682"
            : undefined;
        return (
          <span key={index} style={color ? { color } : undefined}>
            {piece}
          </span>
        );
      })}
    </>
  );
}
export function FormattedAnswer({ text }: { text: string }) {
  const answer = classifyAnswer(text);
  if (answer.kind === "json")
    return (
      <Box
        component="pre"
        aria-label="Formatted JSON answer"
        tabIndex={0}
        sx={{
          m: 0,
          p: 1.5,
          bgcolor: "background.default",
          borderRadius: 1,
          overflow: "auto",
          maxWidth: "100%",
          fontSize: "0.875rem",
          lineHeight: 1.55,
          whiteSpace: "pre",
        }}
      >
        <JsonValue value={answer.formatted} />
      </Box>
    );
  if (answer.kind === "markdown") return <AnswerMarkdown text={text} />;
  return (
    <Typography
      component="div"
      sx={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
    >
      {text}
    </Typography>
  );
}
export function AnswerDialog({
  text,
  open,
  onClose,
}: {
  text: string;
  open: boolean;
  onClose: () => void;
}) {
  const [copyError, setCopyError] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopyError(false);
    } catch {
      setCopyError(true);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullWidth
      maxWidth="md"
      scroll="paper"
      aria-labelledby="answer-preview-title"
      slotProps={{
        paper: {
          sx: {
            m: { xs: 1, sm: 4 },
            width: { xs: "calc(100% - 16px)", sm: "calc(100% - 64px)" },
            maxHeight: "calc(100% - 16px)",
          },
        },
      }}
    >
      <DialogTitle
        id="answer-preview-title"
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 1,
        }}
      >
        Answer Preview
        <IconButton
          aria-label="Close answer preview"
          onClick={onClose}
          autoFocus
        >
          <Close />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers sx={{ minWidth: 0, overflowWrap: "anywhere" }}>
        <FormattedAnswer text={text} />
        {copyError && (
          <Alert severity="warning" sx={{ mt: 2 }}>
            Unable to copy. Select and copy the answer manually.
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={copy}>Copy Answer</Button>
      </DialogActions>
    </Dialog>
  );
}
