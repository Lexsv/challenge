import { useId, useState } from "react";
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  Paper,
  Stack,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Tabs,
  TextField,
  Typography,
  useMediaQuery,
  useTheme,
} from "@mui/material";
import ArrowForward from "@mui/icons-material/ArrowForward";
import ExpandMore from "@mui/icons-material/ExpandMore";
import Search from "@mui/icons-material/Search";
import {
  compareSource,
  fields,
  versions,
  type Catalog,
  type Change,
  type TopicCard,
} from "./topic-cards";

const display = (value: Change["value"]) =>
  Array.isArray(value) ? (value.length ? value.join(", ") : "[]") : value;
const countLabel = (n: number, noun: string) =>
  n + " " + noun + (n === 1 ? "" : "s");
function ChangedAt({ at }: { at: number }) {
  const iso = new Date(at).toISOString();
  return <time dateTime={iso}>{iso.replace("T", " ")}</time>;
}
function Tags({ tags }: { tags: string[] }) {
  if (!tags.length) return null;
  return (
    <Stack direction="row" useFlexGap flexWrap="wrap" gap={0.5}>
      {tags.map((tag) => (
        <Chip
          key={tag}
          size="small"
          label={tag}
          variant="outlined"
          sx={{
            maxWidth: "100%",
            height: "auto",
            color: "text.secondary",
            "& .MuiChip-label": { whiteSpace: "normal" },
          }}
        />
      ))}
    </Stack>
  );
}
function currentFields(card: TopicCard) {
  return fields(card).map((field) => {
    const history = versions(card, field);
    return { field, history, last: history[history.length - 1] };
  });
}

type FieldRow = ReturnType<typeof currentFields>[number];
type DetailView = "Current Values" | "Version History" | "Change Journal";
const views: DetailView[] = [
  "Current Values",
  "Version History",
  "Change Journal",
];

function ValuePair({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <Box sx={{ minWidth: 0 }}>
      <Typography variant="caption" component="dt" color="text.secondary">
        {label}
      </Typography>
      <Typography
        variant="body2"
        component="dd"
        sx={{ m: 0, whiteSpace: "pre-wrap" }}
      >
        {children}
      </Typography>
    </Box>
  );
}
function CurrentValues({
  rows,
  narrow,
}: {
  rows: FieldRow[];
  narrow: boolean;
}) {
  if (narrow)
    return (
      <Stack spacing={1}>
        {rows.map(({ field, last, history }) => (
          <Paper variant="outlined" key={field} sx={{ p: 1.5 }}>
            <Typography variant="subtitle2">{field}</Typography>
            <Box
              component="dl"
              sx={{ m: 0, mt: 0.5, display: "grid", gap: 0.75 }}
            >
              <ValuePair label="Current value">{display(last.value)}</ValuePair>
              <ValuePair label="Version">{history.length}</ValuePair>
              <ValuePair label="Last changed (UTC)">
                <ChangedAt at={last.at} />
              </ValuePair>
            </Box>
          </Paper>
        ))}
      </Stack>
    );
  return (
    <Table
      aria-label="Current values"
      size="small"
      sx={{
        tableLayout: "fixed",
        "& th, & td": { px: 1.5, py: 1.25, verticalAlign: "top" },
        "& thead": { bgcolor: "action.hover" },
        "& th": { fontWeight: 600 },
      }}
    >
      <TableHead>
        <TableRow>
          {[
            "Field / Key",
            "Current value",
            "Version",
            "Last changed (UTC)",
          ].map((h, i) => (
            <TableCell key={h} sx={{ width: ["21%", "36%", "13%", "30%"][i] }}>
              {h}
            </TableCell>
          ))}
        </TableRow>
      </TableHead>
      <TableBody>
        {rows.map(({ field, history, last }) => (
          <TableRow key={field}>
            <TableCell component="th" scope="row">
              {field}
            </TableCell>
            <TableCell sx={{ whiteSpace: "pre-wrap" }}>
              {display(last.value)}
            </TableCell>
            <TableCell>{history.length}</TableCell>
            <TableCell>
              <ChangedAt at={last.at} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

interface Entry {
  change: Change;
  label: string;
  version?: number;
  previous?: Change["value"];
}
function HistoryEntries({ entries }: { entries: Entry[] }) {
  return (
    <Stack component="ol" spacing={1.25} sx={{ listStyle: "none", m: 0, p: 0 }}>
      {entries.map(({ change, label, version, previous }) => (
        <Paper
          component="li"
          variant="outlined"
          key={JSON.stringify([change.id, change.field])}
          sx={{ p: 1.5 }}
        >
          <Stack
            direction="row"
            alignItems="baseline"
            useFlexGap
            flexWrap="wrap"
            gap={0.75}
          >
            <Typography variant="subtitle2" sx={{ mr: "auto" }}>
              {change.field}
            </Typography>
            {version !== undefined && (
              <Typography variant="caption" color="text.secondary">
                Version {version}
              </Typography>
            )}
            <Chip
              size="small"
              label={label}
              color={label === "Confirmation" ? "default" : "primary"}
              variant="outlined"
            />
          </Stack>
          <Typography variant="caption" color="text.secondary">
            <ChangedAt at={change.at} />
          </Typography>
          <Box
            component="dl"
            sx={{
              my: 1,
              display: "grid",
              gap: 1,
              gridTemplateColumns: { xs: "1fr", sm: "repeat(2,minmax(0,1fr))" },
            }}
          >
            <ValuePair label="Previous value">
              {previous === undefined ? "—" : display(previous)}
            </ValuePair>
            <ValuePair label="Recorded value">
              {display(change.value)}
            </ValuePair>
          </Box>
          {change.evidence && (
            <Box sx={{ borderLeft: 2, borderColor: "divider", pl: 1 }}>
              <Typography variant="caption" color="text.secondary">
                Source evidence
              </Typography>
              <Typography variant="body2" sx={{ whiteSpace: "pre-wrap" }}>
                {change.evidence}
              </Typography>
            </Box>
          )}
          {change.resolvedBy && (
            <Typography variant="body2" sx={{ mt: 1 }}>
              Clarification · <ChangedAt at={change.resolvedBy.at} />
              {change.resolvedBy.evidence && " · " + change.resolvedBy.evidence}
            </Typography>
          )}
        </Paper>
      ))}
    </Stack>
  );
}
function journalEntries(card: TopicCard): Entry[] {
  const effectiveVersions = new Map<Change, number>();
  for (const { history } of currentFields(card)) {
    history.forEach((change, index) =>
      effectiveVersions.set(change, index + 1),
    );
  }
  const previous = new Map<string, Entry>();
  return [
    ...card.changes.map((change) => ({ change, label: "Change" })),
    ...(card.confirmations ?? []).map((change) => ({
      change,
      label: "Confirmation",
    })),
  ]
    .sort((a, b) => compareSource(a.change, b.change))
    .map((entry) => {
      const prior = previous.get(entry.change.field);
      const row = {
        ...entry,
        previous: prior?.change.value,
        version: effectiveVersions.get(entry.change) ?? prior?.version,
      };
      previous.set(entry.change.field, row);
      return row;
    });
}
function TopicDetails({ card, close }: { card: TopicCard; close: () => void }) {
  const id = useId(),
    narrow = useMediaQuery(useTheme().breakpoints.down("sm"));
  const [view, setView] = useState<DetailView>("Current Values");
  const rows = currentFields(card);
  const [field, setField] = useState(rows[0]?.field ?? "");
  const selected = rows.find((r) => r.field === field) ?? rows[0];
  const tab = views.indexOf(view);
  return (
    <Dialog
      open
      onClose={close}
      fullWidth
      maxWidth="md"
      fullScreen={narrow}
      scroll="paper"
      aria-labelledby={id + "-title"}
      sx={{ "& .MuiDialog-paper": { overflowWrap: "anywhere", minWidth: 0 } }}
    >
      <DialogTitle id={id + "-title"}>{card.description}</DialogTitle>
      <Box sx={{ px: { xs: 2, sm: 3 }, pb: 1 }}>
        <Tags tags={card.tags} />
      </Box>
      <Tabs
        selectionFollowsFocus
        value={view}
        onChange={(_, v: DetailView) => setView(v)}
        aria-label="Topic details views"
        variant="fullWidth"
        sx={{
          borderBottom: 1,
          borderColor: "divider",
          "& .MuiTab-root": { minWidth: 0, px: { xs: 0.5, sm: 1.5 } },
        }}
      >
        {views.map((v, i) => (
          <Tab
            key={v}
            value={v}
            label={v}
            id={id + "-tab-" + i}
            aria-controls={id + "-panel-" + i}
          />
        ))}
      </Tabs>
      <DialogContent sx={{ p: { xs: 2, sm: 3 }, minHeight: 240 }}>
        <Box
          role="tabpanel"
          id={id + "-panel-" + tab}
          aria-labelledby={id + "-tab-" + tab}
          tabIndex={0}
        >
          {!rows.length ? (
            <Typography color="text.secondary">
              No fields recorded yet.
            </Typography>
          ) : view === "Current Values" ? (
            <CurrentValues rows={rows} narrow={narrow} />
          ) : view === "Change Journal" ? (
            <HistoryEntries entries={journalEntries(card)} />
          ) : (
            <Stack spacing={2}>
              <TextField
                select
                size="small"
                label="Field / Key"
                value={selected.field}
                onChange={(e) => setField(e.target.value)}
              >
                {rows.map((r) => (
                  <MenuItem
                    key={r.field}
                    value={r.field}
                    sx={{ whiteSpace: "normal", overflowWrap: "anywhere" }}
                  >
                    {r.field}
                  </MenuItem>
                ))}
              </TextField>
              <HistoryEntries
                entries={selected.history.map((change, i, all) => ({
                  change,
                  label: "Version " + (i + 1),
                  previous: all[i - 1]?.value,
                }))}
              />
            </Stack>
          )}
        </Box>
      </DialogContent>
      <DialogActions sx={{ borderTop: 1, borderColor: "divider" }}>
        <Button onClick={close}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}

export function TopicCardsPanel({
  catalog,
  disabled,
  finish,
}: {
  catalog: Catalog;
  disabled: boolean;
  finish: () => Promise<void>;
}) {
  const headingId = useId();
  const [saving, setSaving] = useState(false),
    [error, setError] = useState("");
  const [search, setSearch] = useState(""),
    [selectedId, setSelectedId] = useState<string>();
  const selected = catalog.cards.find((c) => c.id === selectedId);
  const terms = search.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  const visible = catalog.cards.filter((c) =>
    terms.every((term) =>
      [c.description, ...c.tags].some((t) =>
        t.toLocaleLowerCase().includes(term),
      ),
    ),
  );
  return (
    <Accordion
      component="section"
      aria-label="Topic cards"
      variant="outlined"
      disableGutters
      sx={{ mt: 1.5, minWidth: 0, overflowWrap: "anywhere", "&::before": { display: "none" } }}
    >
      <AccordionSummary
        id={headingId}
        aria-controls={headingId + "-content"}
        expandIcon={<ExpandMore />}
        sx={{ px: 1.5, "& .MuiAccordionSummary-content": { alignItems: "center", gap: 1 } }}
      >
        <Typography variant="h6" component="span">Topic Cards</Typography>
        <Typography variant="body2" color="text.secondary">
          {countLabel(catalog.cards.length, "card")}
        </Typography>
      </AccordionSummary>
      <AccordionDetails sx={{ px: 1.5, pt: 0.5, pb: 1.5 }}>
        <TextField
          fullWidth
          size="small"
          label="Search descriptions and tags"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          slotProps={{
            input: {
              startAdornment: (
                <Search
                  fontSize="small"
                  sx={{ mr: 0.75, color: "text.secondary" }}
                />
              ),
            },
          }}
        />
        <Stack spacing={1} sx={{ mt: 1.5 }}>
          {visible.map((card) => {
            const rows = currentFields(card);
            const count = rows.reduce(
              (total, row) => total + row.history.length,
              0,
            );
            const priority = (field: string) =>
              /^(date|deadline|status|participants|дата|срок|статус|участники)$/iu.test(
                field,
              )
                ? 0
                : 1;
            const preview = [...rows]
              .sort((a, b) => priority(a.field) - priority(b.field))
              .slice(0, 2);
            return (
              <Paper
                key={card.id}
                component="article"
                variant="outlined"
                sx={{ p: 1.5 }}
              >
                <Typography
                  component="h4"
                  variant="subtitle1"
                  sx={{ fontWeight: 700, lineHeight: 1.35, mb: 0.75 }}
                >
                  {card.description}
                </Typography>
                <Tags tags={card.tags.slice(0, 3)} />
                {!!preview.length && (
                  <Box
                    component="dl"
                    sx={{
                      display: "grid",
                      gridTemplateColumns: "minmax(0,1fr) minmax(0,2fr)",
                      gap: 0.5,
                      m: 0,
                      mt: 1,
                    }}
                  >
                    {preview.map(({ field, last }) => (
                      <Box key={field} sx={{ display: "contents" }}>
                        <Typography
                          component="dt"
                          variant="body2"
                          color="text.secondary"
                        >
                          {field}
                        </Typography>
                        <Typography
                          component="dd"
                          variant="body2"
                          sx={{
                            m: 0,
                            display: "-webkit-box",
                            WebkitLineClamp: 2,
                            WebkitBoxOrient: "vertical",
                            overflow: "hidden",
                          }}
                        >
                          {display(last.value)}
                        </Typography>
                      </Box>
                    ))}
                  </Box>
                )}
                <Stack
                  direction="row"
                  alignItems="center"
                  justifyContent="space-between"
                  useFlexGap
                  flexWrap="wrap"
                  gap={0.5}
                  sx={{ mt: 1 }}
                >
                  <Typography variant="caption" color="text.secondary">
                    {countLabel(rows.length, "field")} ·{" "}
                    {countLabel(count, "version")}
                  </Typography>
                  <Button
                    size="small"
                    endIcon={<ArrowForward />}
                    aria-label={"View details for " + card.description}
                    aria-haspopup="dialog"
                    onClick={() => setSelectedId(card.id)}
                  >
                    View details
                  </Button>
                </Stack>
              </Paper>
            );
          })}
        </Stack>
        {!visible.length && (
          <Typography variant="body2" color="text.secondary">
            {terms.length ? "No matching topics." : "No topic cards yet."}
          </Typography>
        )}
        {catalog.active && (
          <Button
            sx={{ mt: 1 }}
            disabled={saving || disabled}
            onClick={async () => {
              setSaving(true);
              setError("");
              try {
                await finish();
              } catch {
                setError("Could not finish the task. Refresh and retry.");
              } finally {
                setSaving(false);
              }
            }}
          >
            Finish active task
          </Button>
        )}
        {selected && (
          <TopicDetails
            card={selected}
            key={selected.id}
            close={() => setSelectedId(undefined)}
          />
        )}
        {error && <Alert severity="error">{error}</Alert>}
      </AccordionDetails>
    </Accordion>
  );
}
