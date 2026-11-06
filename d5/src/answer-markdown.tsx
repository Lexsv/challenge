import type { ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Box,
  Link,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from "@mui/material";
import { alpha } from "@mui/material/styles";

export function safeMarkdownLink(
  value: string | undefined,
): string | undefined {
  if (!value) return undefined;
  const url = value.trim();
  if (!url || /[\u0000-\u0020\u007f\\]/.test(url) || url.startsWith("//"))
    return undefined;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url);
  return !scheme ||
    ["https", "http", "mailto"].includes(scheme[1].toLowerCase())
    ? url
    : undefined;
}
const heading =
  (component: "h4" | "h5" | "h6", fontSize: string) =>
  ({ children }: { children?: ReactNode }) => (
    <Typography
      component={component}
      sx={{ fontSize, fontWeight: 700, color: "primary.dark", mt: 2, mb: 1 }}
    >
      {children}
    </Typography>
  );
const alignment = (value?: string | null) =>
  value === "right" || value === "center" ? value : "left";
const components: Components = {
  h1: heading("h4", "1.25rem"),
  h2: heading("h5", "1.15rem"),
  h3: heading("h6", "1.05rem"),
  h4: heading("h6", "1rem"),
  h5: heading("h6", "1rem"),
  h6: heading("h6", "1rem"),
  p: ({ children }) => (
    <Typography
      component="p"
      variant="body2"
      sx={{ my: 1, whiteSpace: "pre-wrap" }}
    >
      {children}
    </Typography>
  ),
  a: ({ href, children }) => {
    const safeHref = safeMarkdownLink(href);
    return safeHref ? (
      <Link
        href={safeHref}
        target="_blank"
        rel="noopener noreferrer"
        referrerPolicy="no-referrer"
        color="primary.dark"
        underline="always"
      >
        {children}
      </Link>
    ) : (
      <span>{children}</span>
    );
  },
  blockquote: ({ children }) => (
    <Box
      component="blockquote"
      sx={{
        mx: 0,
        my: 1.5,
        pl: 2,
        py: 0.5,
        borderLeft: "3px solid",
        borderColor: "primary.main",
        bgcolor: (theme) => alpha(theme.palette.primary.main, 0.05),
      }}
    >
      {children}
    </Box>
  ),
  code: ({ children }) => (
    <Box
      component="code"
      sx={{
        fontFamily: "monospace",
        fontSize: "0.9em",
        px: 0.5,
        py: 0.15,
        borderRadius: 0.25,
        bgcolor: (theme) => alpha(theme.palette.primary.main, 0.08),
      }}
    >
      {children}
    </Box>
  ),
  pre: ({ children }) => (
    <Box
      component="pre"
      role="region"
      aria-label="Code block"
      tabIndex={0}
      sx={{
        m: 0,
        my: 1.5,
        p: 1.5,
        maxWidth: "100%",
        overflowX: "auto",
        whiteSpace: "pre",
        fontFamily: "monospace",
        fontSize: "0.8125rem",
        border: "1px solid",
        borderColor: "divider",
        borderRadius: 1,
        bgcolor: (theme) => alpha(theme.palette.primary.main, 0.04),
        "& > code": {
          background: "none",
          p: 0,
          fontSize: "inherit",
          whiteSpace: "pre",
        },
      }}
    >
      {children}
    </Box>
  ),
  table: ({ children }) => (
    <TableContainer
      component={Paper}
      variant="outlined"
      role="region"
      aria-label="Scrollable answer table"
      tabIndex={0}
      sx={{ my: 1.5, maxWidth: "100%", overflowX: "auto", borderRadius: 1 }}
    >
      <Table
        size="small"
        aria-label="Answer Markdown table"
        sx={{
          width: "max-content",
          minWidth: "100%",
          "& th": {
            fontWeight: 700,
            color: "primary.dark",
            bgcolor: (theme) => alpha(theme.palette.primary.main, 0.08),
          },
          "& th, & td": { px: 1.5, py: 0.75 },
        }}
      >
        {children}
      </Table>
    </TableContainer>
  ),
  thead: ({ children }) => <TableHead>{children}</TableHead>,
  tbody: ({ children }) => <TableBody>{children}</TableBody>,
  tr: ({ children }) => <TableRow>{children}</TableRow>,
  th: ({ children, align }) => (
    <TableCell component="th" scope="col" align={alignment(align)}>
      {children}
    </TableCell>
  ),
  td: ({ children, align }) => (
    <TableCell align={alignment(align)}>{children}</TableCell>
  ),
};
const allowedElements = [
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "strong",
  "em",
  "del",
  "ul",
  "ol",
  "li",
  "blockquote",
  "a",
  "code",
  "pre",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "hr",
  "br",
  "sup",
];

export function AnswerMarkdown({ text }: { text: string }) {
  return (
    <Box
      sx={{
        minWidth: 0,
        maxWidth: "100%",
        overflowWrap: "anywhere",
        "& > :first-of-type": { mt: 0 },
        "& > :last-of-type": { mb: 0 },
        "& ul, & ol": { pl: 3, my: 1 },
        "& li": { mb: 0.5 },
        "& strong": { fontWeight: 700 },
        "& a": { overflowWrap: "anywhere" },
        "& :focus-visible": {
          outline: "2px solid",
          outlineColor: "primary.main",
          outlineOffset: 2,
        },
      }}
    >
      <Markdown
        skipHtml
        allowedElements={allowedElements}
        remarkPlugins={[remarkGfm]}
        urlTransform={(url, key) =>
          key === "href" ? safeMarkdownLink(url) : undefined
        }
        components={components}
      >
        {text}
      </Markdown>
    </Box>
  );
}
