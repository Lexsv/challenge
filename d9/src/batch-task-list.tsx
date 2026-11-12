import { useState } from "react";
import { Alert, Box, Button, ButtonBase, Checkbox, Paper, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, Stack, TextField, Tooltip, Typography } from "@mui/material";
import Add from "@mui/icons-material/Add";
import Close from "@mui/icons-material/Close";
import DeleteOutline from "@mui/icons-material/DeleteOutline";
import PlayArrow from "@mui/icons-material/PlayArrow";
import DescriptionOutlined from "@mui/icons-material/DescriptionOutlined";
import SettingsOutlined from "@mui/icons-material/SettingsOutlined";
import { saveTask, type BatchTask } from "./batch-tasks";

const clipped = (lines: number) => ({ display: "-webkit-box", WebkitBoxOrient: "vertical" as const, WebkitLineClamp: lines, overflow: "hidden", whiteSpace: "pre-wrap" as const, overflowWrap: "anywhere" as const });

export function BatchTaskList({ tasks, onChange, active, onRunTask, disabledReason, selection }: {
  tasks: BatchTask[];
  onChange: (tasks: BatchTask[]) => void;
  active: boolean;
  onRunTask: (task: BatchTask) => void;
  disabledReason?: string;
  selection?: { excludedIds: readonly string[]; onToggle: (id: string) => void };
}) {
  const [draft, setDraft] = useState<{ id?: string; question: string; reference: string } | null>(null);
  const [preview, setPreview] = useState<BatchTask | null>(null);
  const [error, setError] = useState("");
  const close = () => { setDraft(null); setError(""); };
  return <Stack spacing={1.5}>
    <Box><Button variant="outlined" startIcon={<Add />} disabled={active} onClick={() => { setError(""); setDraft({ question: "", reference: "" }); }}>Add Task</Button></Box>
    {!tasks.length && <Typography variant="body2" color="text.secondary">Add a task to start an experiment.</Typography>}
    <Stack spacing={0.75}>
      {tasks.map((task, index) => {
        const selected = selection && !selection.excludedIds.includes(task.id);
        return (
          <Paper key={task.id} variant="outlined" sx={{ p: 0.75, bgcolor: selected ? "secondary.main" : "background.paper" }}>
            <Stack direction="row" alignItems="flex-start" gap={0.75}>
              {selection && <Checkbox size="small" checked={!!selected} disabled={active} onChange={() => selection.onToggle(task.id)} inputProps={{ "aria-label": `Select task ${index + 1}` }} />}
              <DescriptionOutlined color="primary" fontSize="small" sx={{ mt: 0.75 }} />
              <ButtonBase aria-label={`View task ${index + 1}`} onClick={() => setPreview(task)} sx={{ p: 0.5, minWidth: 0, flex: 1, display: "block", textAlign: "left", borderRadius: 1, "&:focus-visible": { outline: "2px solid", outlineColor: "primary.main" } }}>
                <Typography variant="subtitle2" sx={clipped(5)}>{task.question}</Typography>
                {task.reference.trim() && <Typography variant="caption" color="text.secondary" sx={clipped(2)}>Expected answer: {task.reference}</Typography>}
              </ButtonBase>
            </Stack>
            <Stack direction="row" justifyContent="flex-end">
              <Tooltip title={`Edit task ${index + 1}`}><span><IconButton size="small" disabled={active} aria-label={`Edit task ${index + 1}`} onClick={() => { setError(""); setDraft({ id: task.id, question: task.question, reference: task.reference }); }}><SettingsOutlined fontSize="small" /></IconButton></span></Tooltip>
              <Tooltip title={disabledReason || `Run task ${index + 1}`}><span><IconButton size="small" color="primary" disabled={active || !!disabledReason} aria-label={`Run task ${index + 1}`} onClick={() => onRunTask(task)}><PlayArrow fontSize="small" /></IconButton></span></Tooltip>
              <Tooltip title={`Delete task ${index + 1}`}><span><IconButton size="small" disabled={active} aria-label={`Delete task ${index + 1}`} onClick={() => onChange(tasks.filter((entry) => entry.id !== task.id))}><DeleteOutline fontSize="small" /></IconButton></span></Tooltip>
            </Stack>
          </Paper>
        );
      })}
    </Stack>
    <Dialog open={draft !== null} onClose={close} fullWidth maxWidth="sm" aria-labelledby="batch-task-title">
      <DialogTitle id="batch-task-title">{draft?.id ? "Edit Task" : "Add Task"}</DialogTitle>
      <DialogContent><Stack spacing={2} sx={{ pt: 1 }}>
        <TextField autoFocus required label="Question" multiline minRows={3} value={draft?.question ?? ""} onChange={(event) => setDraft((value) => value && ({ ...value, question: event.target.value }))} />
        <TextField label="Expected Answer (optional)" multiline minRows={2} value={draft?.reference ?? ""} onChange={(event) => setDraft((value) => value && ({ ...value, reference: event.target.value }))} />
        {error && <Alert severity="error">{error}</Alert>}
      </Stack></DialogContent>
      <DialogActions><Button onClick={close}>Cancel</Button><Button variant="contained" disabled={active || !draft?.question.trim()} onClick={() => { if (!draft) return; try { onChange(saveTask(tasks, draft)); close(); } catch { setError("Enter a task."); } }}>Save</Button></DialogActions>
    </Dialog>
    <Dialog open={preview !== null} onClose={() => setPreview(null)} fullWidth maxWidth="sm" aria-labelledby="task-preview-title">
      <DialogTitle id="task-preview-title" sx={{ pr: 7 }}>Task details<IconButton aria-label="Close task details" onClick={() => setPreview(null)} sx={{ position: "absolute", right: 8, top: 8 }}><Close /></IconButton></DialogTitle>
      <DialogContent dividers>
        <Typography variant="subtitle2">Question</Typography>
        <Typography sx={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{preview?.question}</Typography>
        {preview?.reference.trim() && <><Typography variant="subtitle2" sx={{ mt: 2 }}>Expected Answer</Typography><Typography sx={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{preview.reference}</Typography></>}
      </DialogContent>
    </Dialog>
  </Stack>;
}
