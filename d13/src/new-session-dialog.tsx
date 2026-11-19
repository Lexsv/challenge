import React, { useEffect, useState } from "react";
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormLabel,
  IconButton,
  ToggleButton,
  ToggleButtonGroup,
  MenuItem,
  Stack,
  TextField,
} from "@mui/material";
import ChatBubbleOutline from "@mui/icons-material/ChatBubbleOutline";
import LayersOutlined from "@mui/icons-material/LayersOutlined";
import Close from "@mui/icons-material/Close";
import type { WorkerTemplate } from "./worker-ui";
type UserChoice = { id: string; name: string };

export function SessionTypeFields({
  sessionType,
  workerId,
  workers,
  onTypeChange,
  onWorkerChange,
}: {
  sessionType: "chat" | "worker";
  workerId: string;
  workers: readonly WorkerTemplate[];
  onTypeChange: (type: "chat" | "worker") => void;
  onWorkerChange: (id: string) => void;
}) {
  return (
    <Stack spacing={2}>
      <Stack spacing={0.75}>
        <FormLabel required>Session Type</FormLabel>
        <ToggleButtonGroup
          fullWidth
          exclusive
          size="small"
          aria-label="Session Type"
          value={sessionType}
          onChange={(_, value) => {
            if (value === "chat" || value === "worker") onTypeChange(value);
          }}
        >
          <ToggleButton value="chat">
            <ChatBubbleOutline fontSize="small" />
            Chat
          </ToggleButton>
          <ToggleButton value="worker">
            <LayersOutlined fontSize="small" />
            Worker
          </ToggleButton>
        </ToggleButtonGroup>
      </Stack>
      {sessionType === "worker" && (
        <TextField
          select
          required
          label="Worker Template"
          value={workerId}
          onChange={(event) => onWorkerChange(event.target.value)}
        >
          {workers.map((worker) => (
            <MenuItem key={worker.id} value={worker.id}>
              {worker.name}
            </MenuItem>
          ))}
        </TextField>
      )}
    </Stack>
  );
}

export const canCreateSession = (
  name: string,
  userId: string,
  users: readonly UserChoice[],
  pending: boolean,
) => !pending && !!name.trim() && users.some((user) => user.id === userId);

export function NewSessionFields({
  name,
  userId,
  users,
  onNameChange,
  onUserChange,
  persisted = false,
  children,
}: {
  name: string;
  userId: string;
  users: readonly UserChoice[];
  onNameChange: (value: string) => void;
  onUserChange: (value: string) => void;
  persisted?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <Stack spacing={2} sx={{ pt: 1 }}>
      <TextField
        autoFocus
        label="Session Name"
        required
        value={name}
        slotProps={{ htmlInput: { maxLength: 200 } }}
        onChange={(event) => onNameChange(event.target.value)}
      />
      <TextField
        select
        label="User"
        required
        value={userId}
        onChange={(event) => onUserChange(event.target.value)}
      >
        {users.map((user) => (
          <MenuItem key={user.id} value={user.id}>
            {user.name}
          </MenuItem>
        ))}
      </TextField>
      {children}
      <Alert severity="info">
        {persisted
          ? "The selected user is saved with the session and cannot be changed."
          : "User selection is shown only during this visit and is not saved with the session."}
      </Alert>
    </Stack>
  );
}

export function NewSessionDialog({
  open,
  users,
  workerUsers = users,
  pending,
  error,
  onClose,
  onCreate,
  persisted = false,
  profilesError = false,
  onRetryProfiles,
  workers = [],
}: {
  open: boolean;
  users: readonly UserChoice[];
  workerUsers?: readonly UserChoice[];
  pending: boolean;
  error: string;
  onClose: () => void;
  onCreate: (name: string, userId: string, worker?: WorkerTemplate) => void;
  persisted?: boolean;
  profilesError?: boolean;
  onRetryProfiles?: () => void;
  workers?: readonly WorkerTemplate[];
}) {
  const [name, setName] = useState("");
  const [userId, setUserId] = useState("general");
  const [sessionType, setSessionType] = useState<"chat" | "worker">("chat");
  const [workerId, setWorkerId] = useState("");
  useEffect(() => {
    if (open) {
      setName("");
      setUserId("general");
      setSessionType("chat");
      setWorkerId("");
    }
  }, [open]);
  const selectedWorker = workers.find((worker) => worker.id === workerId);
  const choices = sessionType === "worker" ? workerUsers : users;
  const valid =
    canCreateSession(name, userId, choices, pending) &&
    (sessionType === "chat" || !!selectedWorker);
  return (
    <Dialog
      open={open}
      onClose={pending ? undefined : onClose}
      fullWidth
      maxWidth="xs"
      aria-labelledby="new-session-title"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (valid)
            onCreate(
              name.trim(),
              userId,
              sessionType === "worker" ? selectedWorker : undefined,
            );
        }}
      >
        <DialogTitle
          id="new-session-title"
          sx={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          New Session
          <IconButton
            aria-label="Close dialog"
            disabled={pending}
            onClick={onClose}
          >
            <Close fontSize="small" />
          </IconButton>
        </DialogTitle>
        <DialogContent>
          <NewSessionFields
            name={name}
            userId={userId}
            users={choices}
            onNameChange={setName}
            onUserChange={setUserId}
            persisted={sessionType === "worker" || persisted}
          >
            <SessionTypeFields
              sessionType={sessionType}
              workerId={workerId}
              workers={workers}
              onTypeChange={setSessionType}
              onWorkerChange={setWorkerId}
            />
          </NewSessionFields>
          {profilesError && (
            <Alert
              severity="error"
              action={<Button onClick={onRetryProfiles}>Retry</Button>}
            >
              Could not load profiles.
            </Alert>
          )}
          {error && (
            <Alert severity="error" sx={{ mt: 2 }}>
              {error}
            </Alert>
          )}
        </DialogContent>
        <DialogActions
          sx={{ px: 3, py: 2, borderTop: 1, borderColor: "divider" }}
        >
          <Button variant="outlined" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" variant="contained" disabled={!valid}>
            Create Session
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}
