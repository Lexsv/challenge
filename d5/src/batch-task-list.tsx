import { useState } from "react";
import { Alert, Box, Button, ButtonBase, Card, CardActionArea, CardContent, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, Stack, TextField, Tooltip, Typography } from "@mui/material";
import Add from "@mui/icons-material/Add";
import Close from "@mui/icons-material/Close";
import DeleteOutline from "@mui/icons-material/DeleteOutline";
import PlayArrow from "@mui/icons-material/PlayArrow";
import SettingsOutlined from "@mui/icons-material/SettingsOutlined";
import { saveTask, type BatchTask } from "./batch-tasks";

const clipped = (lines: number) => ({ display: "-webkit-box", WebkitBoxOrient: "vertical" as const, WebkitLineClamp: lines, overflow: "hidden", whiteSpace: "pre-wrap" as const, overflowWrap: "anywhere" as const });

export function BatchTaskList({ tasks, onChange, active, onRunTask, disabledReason }: {
  tasks: BatchTask[];
  onChange: (tasks: BatchTask[]) => void;
  active: boolean;
  onRunTask: (task: BatchTask) => void;
  disabledReason?: string;
}) {
  const [draft, setDraft] = useState<{ id?: string; question: string; reference: string } | null>(null);
  const [preview, setPreview] = useState<BatchTask | null>(null);
  const [error, setError] = useState("");
  const close = () => { setDraft(null); setError(""); };
  return <Stack spacing={1.5}>
    {tasks.length > 0 && disabledReason && <Typography variant="body2" color="text.secondary">{disabledReason}</Typography>}
    <Box sx={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 250px), 1fr))", gap: 2 }}>
      {tasks.map((task, index) => <Card key={task.id} sx={{ display: "flex", flexDirection: "column" }}>
        <CardContent sx={{ flex: 1, display: "flex", flexDirection: "column" }}>
          <Stack direction="row" alignItems="center">
            <Typography variant="h6" sx={{ flex: 1, minWidth: 0 }}>Task {index + 1}</Typography>
            <Tooltip title={`Edit task ${index + 1}`}><span><IconButton disabled={active} aria-label={`Edit task ${index + 1}`} onClick={() => { setError(""); setDraft({ id: task.id, question: task.question, reference: task.reference }); }}><SettingsOutlined fontSize="small" /></IconButton></span></Tooltip>
            <Tooltip title={`Run task ${index + 1}`}><span><IconButton color="success" disabled={active || !!disabledReason} aria-label={`Run task ${index + 1}`} onClick={() => onRunTask(task)}><PlayArrow fontSize="small" /></IconButton></span></Tooltip>
            <Tooltip title={`Delete task ${index + 1}`}><span><IconButton disabled={active} aria-label={`Delete task ${index + 1}`} onClick={() => onChange(tasks.filter((entry) => entry.id !== task.id))}><DeleteOutline fontSize="small" /></IconButton></span></Tooltip>
          </Stack>
          <ButtonBase aria-label={`View task ${index + 1}`} onClick={() => setPreview(task)} sx={{ mt: 2, width: "100%", flex: 1, display: "flex", flexDirection: "column", alignItems: "stretch", justifyContent: "flex-start", textAlign: "left", borderRadius: 1, "&:focus-visible": { outline: "2px solid", outlineColor: "primary.main" } }}>
            <Typography sx={clipped(5)}>{task.question}</Typography>
            {task.reference.trim() && <Typography variant="body2" color="text.secondary" sx={{ mt: 1, ...clipped(2) }}>Expected answer: {task.reference}</Typography>}
          </ButtonBase>
        </CardContent>
      </Card>)}
      <Card variant="outlined" sx={{ border: "1px dashed #A68B38", minHeight: 200, boxShadow: "none" }}>
        <CardActionArea disabled={active} onClick={() => { setError(""); setDraft({ question: "", reference: "" }); }} sx={{ height: "100%", p: 3, textAlign: "center" }}>
          <Add sx={{ fontSize: 44, bgcolor: "secondary.main", borderRadius: "50%", p: 1 }} />
          <Typography variant="h6">Add Task</Typography>
        </CardActionArea>
      </Card>
    </Box>
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
