import { Box, Button, CircularProgress, TextField } from "@mui/material";
import SendRounded from "@mui/icons-material/SendRounded";

export function ChatComposer({
  draft,
  onDraftChange,
  onSend,
  disabled,
  running,
}: {
  draft: string;
  onDraftChange: (value: string) => void;
  onSend: () => void;
  disabled: boolean;
  running: boolean;
}) {
  return (
    <Box
      sx={{
        position: "sticky",
        bottom: 0,
        bgcolor: "background.paper",
        pt: 0.5,
      }}
    >
      <Box sx={{ position: "relative", width: "100%" }}>
        <TextField
          fullWidth
          placeholder="Message"
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              onSend();
            }
          }}
          multiline
          minRows={1}
          maxRows={6}
          disabled={disabled}
          sx={{
            "& .MuiOutlinedInput-root": {
              borderRadius: "8px",
              minHeight: 56,
              // The textarea's content and scrollbar end before the anchored button.
              padding: "12px 56px 12px 14px",
            },
            "& textarea": { overflowY: "auto" },
          }}
        />
        <Button
          variant="contained"
          onClick={onSend}
          disabled={disabled || !draft.trim()}
          aria-label="Send message"
          aria-busy={running}
          sx={{
            position: "absolute",
            right: 8,
            bottom: 8,
            width: 40,
            height: 40,
            minWidth: 40,
            minHeight: 40,
            p: 0,
            borderRadius: "50%",
          }}
        >
          {running ? (
            <CircularProgress
              size={18}
              color="inherit"
              aria-label="Sending message"
            />
          ) : (
            <SendRounded fontSize="small" />
          )}
        </Button>
      </Box>
    </Box>
  );
}
