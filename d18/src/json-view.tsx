import { Box } from "@mui/material";

// Keep small records in an array on one line, as in the journal reference.
// JSON.stringify handles escaping; tokens are always rendered as React text.
function journalJson(value: unknown, depth = 0, arrayEntry = false): string {
  if (value === null || typeof value !== "object")
    return JSON.stringify(value) ?? "";
  const pad = "  ".repeat(depth);
  const array = Array.isArray(value);
  const entries = Object.entries(value);
  const [open, close] = array ? ["[", "]"] : ["{", "}"];
  if (!entries.length) return open + close;
  const parts = entries.map(
    ([key, item]) =>
      (array ? "" : JSON.stringify(key) + ": ") +
      journalJson(item, depth + 1, array),
  );
  if (
    arrayEntry &&
    !array &&
    entries.every(([, v]) => v === null || typeof v !== "object")
  ) {
    const line = "{ " + parts.join(", ") + " }";
    if (line.length <= 100) return line;
  }
  return (
    open +
    "\n" +
    parts.map((p) => pad + "  " + p).join(",\n") +
    "\n" +
    pad +
    close
  );
}

export function JsonView({
  value,
  journal = false,
}: {
  value: unknown;
  journal?: boolean;
}) {
  const json = journal
    ? journalJson(value)
    : (JSON.stringify(value, null, 2) ?? "");
  const tokens = json.split(
    /("(?:\\.|[^"\\])*"\s*:?|\b(?:true|false|null)\b|-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)/g,
  );
  return (
    <Box
      component="pre"
      sx={{
        m: 0,
        p: 1.5,
        bgcolor: journal ? "secondary.light" : "action.hover",
        borderRadius: 1,
        ...(journal ? { typography: "body2" } : { fontSize: 12 }),
        fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace",
        whiteSpace: "pre",
        overflow: "auto",
        maxHeight: journal ? "48vh" : undefined,
        maxWidth: "100%",
      }}
    >
      {tokens.map((part, i) => (
        <Box
          component="span"
          key={i}
          sx={{
            color:
              i % 2 === 0
                ? "text.primary"
                : part.endsWith(":")
                  ? journal
                    ? "#a80038"
                    : "primary.dark"
                  : part.startsWith('"')
                    ? journal
                      ? "#132e9d"
                      : "success.dark"
                    : journal
                      ? "#006c75"
                      : "secondary.dark",
          }}
        >
          {part}
        </Box>
      ))}
    </Box>
  );
}
