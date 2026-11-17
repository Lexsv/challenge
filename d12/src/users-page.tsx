import React, { useEffect, useState } from "react";
import { Alert, Box, Button, Chip, IconButton, Paper, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Tooltip, Typography } from "@mui/material";
import Add from "@mui/icons-material/Add";
import DeleteOutline from "@mui/icons-material/DeleteOutline";
import SettingsOutlined from "@mui/icons-material/SettingsOutlined";
import DeleteSweepOutlined from "@mui/icons-material/DeleteSweepOutlined";

// The New Session dialog still uses temporary choices until its separate integration.
export type MockUser = { id: string; name: string; habits: string; sessions: string[]; system?: boolean };
export const sampleUsers: readonly MockUser[] = [
  { id: "general", name: "General", habits: "", sessions: ["Welcome session"], system: true },
  { id: "alex", name: "Alex", habits: "Prefers detailed technical explanations", sessions: ["Architecture discussion", "Learning TypeScript"] },
  { id: "developer", name: "Developer", habits: "Prefers short answers with code examples", sessions: ["Code review"] },
];
export function updateMockUser(users: readonly MockUser[], draft: MockUser): MockUser[] {
  if (!draft.name.trim() || users.some(user => user.id === draft.id && user.system)) return [...users];
  const clean = { ...draft, name: draft.name.trim(), habits: draft.habits.trim(), system: false };
  return users.some(user => user.id === draft.id) ? users.map(user => user.id === draft.id ? clean : user) : [...users, clean];
}

export type ContextProfile = { id: string; name: string; habits: string; is_system: 0 | 1; revision: number };
export type ProfilesState = { status: 'loading' } | { status: 'error' } | { status: 'loaded'; profiles: ContextProfile[] };

export async function loadProfiles(fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<ContextProfile[]> {
  const response = await fetcher('/api/users', { signal });
  if (!response.ok) throw new Error('Unable to load profiles.');
  const data: unknown = await response.json();
  if (!Array.isArray(data) || data.some(item => !item || typeof item.id !== 'string' || typeof item.name !== 'string' || typeof item.habits !== 'string' || (item.is_system !== 0 && item.is_system !== 1) || !Number.isSafeInteger(item.revision))) throw new Error('Invalid profile response.');
  return data as ContextProfile[];
}

export function UsersView({ state, onRetry }: { state: ProfilesState; onRetry: () => void }) {
  return <Stack spacing={2}>
    <Stack direction={{ xs: "column", sm: "row" }} justifyContent="space-between" alignItems={{ sm: "center" }} gap={1}>
      <Box><Typography variant="h4" component="h2">Users</Typography><Typography color="text.secondary">View profiles and their preferences.</Typography></Box>
      <Button variant="contained" startIcon={<Add />} disabled>Add User</Button>
    </Stack>
    {state.status === 'loading' ? <Typography role="status">Loading profiles…</Typography> : state.status === 'error' ?
      <Alert severity="error" action={<Button color="inherit" onClick={onRetry}>Retry</Button>}>Could not load profiles.</Alert> :
      state.profiles.length === 0 ? <Typography>No profiles available.</Typography> :
      <TableContainer component={Paper} variant="outlined" sx={{maxWidth:"100%"}}>
        <Table size="small" aria-label="Users" sx={{minWidth:800,tableLayout:"fixed"}}>
          <TableHead><TableRow><TableCell sx={{width:"20%"}}>Name</TableCell><TableCell sx={{width:"60%"}}>Habits</TableCell><TableCell align="center" sx={{width:"8%",px:0.5}}>Sessions</TableCell><TableCell align="right" sx={{width:"12%",px:1}}>Actions</TableCell></TableRow></TableHead>
          <TableBody>{[...state.profiles].sort((a,b)=>Number(b.id==='general')-Number(a.id==='general')).map(user=><TableRow key={user.id}>
            <TableCell component="th" scope="row"><Stack direction="row" alignItems="center" gap={1}><Typography noWrap>{user.name}</Typography>{user.is_system === 1 && <Chip label="System" size="small" />}</Stack></TableCell>
            <TableCell>{user.habits ? <Tooltip title={user.habits}><Typography tabIndex={0} noWrap color="text.secondary" aria-label={`Habits for ${user.name}: ${user.habits}`}>{user.habits}</Typography></Tooltip> : <Typography color="text.secondary">No habits added.</Typography>}</TableCell>
            <TableCell align="center" sx={{px:0.5}} aria-label={`Session count unavailable for ${user.name}`}>—</TableCell>
            <TableCell align="right" sx={{px:1}}><Stack direction="row" justifyContent="flex-end" spacing={0.5}>
              {user.is_system === 1 ? <Tooltip title="Clear Sessions"><span><IconButton disabled size="small" aria-label="Clear Sessions for General"><DeleteSweepOutlined fontSize="small" /></IconButton></span></Tooltip> : <><Tooltip title="Edit User"><span><IconButton disabled size="small" aria-label={`Edit ${user.name}`}><SettingsOutlined fontSize="small" /></IconButton></span></Tooltip><Tooltip title="Delete User"><span><IconButton disabled size="small" color="error" aria-label={`Delete ${user.name}`}><DeleteOutline fontSize="small" /></IconButton></span></Tooltip></>}
            </Stack></TableCell>
          </TableRow>)}</TableBody>
        </Table>
      </TableContainer>}
  </Stack>;
}

export function UsersPage() {
  const [state, setState] = useState<ProfilesState>({status:'loading'});
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setState({status:'loading'});
    loadProfiles(fetch, controller.signal).then(profiles => { if (!controller.signal.aborted) setState({status:'loaded',profiles}); }).catch(() => { if (!controller.signal.aborted) setState({status:'error'}); });
    return () => controller.abort();
  }, [attempt]);
  return <UsersView state={state} onRetry={() => setAttempt(current => current + 1)} />;
}
