import { Button, IconButton, Paper, Stack, Typography } from '@mui/material';
import AddRounded from '@mui/icons-material/AddRounded';

type CreateActionProps = { onCreate: () => void; pending: boolean; disabled: boolean };

export function SessionCreateButton({ compact = false, onCreate, pending, disabled }: CreateActionProps & { compact?: boolean }) {
  if (compact) return <IconButton aria-label="New session" aria-busy={pending} disabled={disabled || pending} onClick={onCreate}
    sx={{ width: 32, height: 32, minWidth: 32, p: 0, flexShrink: 0, borderRadius: '50%',
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      '&:hover': { borderRadius: '50%' },
      '&.Mui-focusVisible': { bgcolor: 'action.focus', borderRadius: '50%', outline: '2px solid', outlineColor: 'primary.main', outlineOffset: 2 },
    }}><AddRounded fontSize="small" /></IconButton>;
  return <Button variant="contained" aria-busy={pending} disabled={disabled || pending} onClick={onCreate}>Start a new session</Button>;
}

export function EmptySessionChat({ showEmptyState, onCreate, pending, disabled }: CreateActionProps & { showEmptyState: boolean }) {
  return <Paper variant="outlined" aria-label="Empty chat" sx={{ minHeight: 500, p: 2 }}>
    <Typography variant="h6" component="h3">Agent Tool Lab</Typography>
    {showEmptyState && <Stack spacing={1.5} alignItems="center" justifyContent="center" sx={{ minHeight: 400, textAlign: 'center' }}>
      <Typography color="text.secondary">No sessions yet. Start a session to begin a conversation.</Typography>
      <SessionCreateButton onCreate={onCreate} pending={pending} disabled={disabled} />
    </Stack>}
  </Paper>;
}
