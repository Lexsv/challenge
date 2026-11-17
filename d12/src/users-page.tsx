import React, { useEffect, useState } from "react";
import { Alert, Box, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, Paper, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TextField, Tooltip, Typography } from "@mui/material";
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
export type ProfileDraft = { name: string; habits: string; existing?: ContextProfile };

export async function loadProfiles(fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<ContextProfile[]> {
  const response = await fetcher('/api/users', { signal });
  if (!response.ok) throw new Error('Unable to load profiles.');
  const data: unknown = await response.json();
  if (!Array.isArray(data) || data.some(item => !item || typeof item.id !== 'string' || typeof item.name !== 'string' || typeof item.habits !== 'string' || (item.is_system !== 0 && item.is_system !== 1) || !Number.isSafeInteger(item.revision))) throw new Error('Invalid profile response.');
  return data as ContextProfile[];
}

export function createProfileSaver(fetcher: typeof fetch, onSaved: () => void, onPending: (pending:boolean) => void) {
  let pending = false;
  return async (draft: ProfileDraft): Promise<string | null> => {
    if (pending) return null;
    if (draft.existing?.is_system === 1 || draft.existing?.id === 'general') return 'General cannot be edited.';
    const name=draft.name.trim();
    if (!name || name.length>200 || name.toLowerCase()==='general' || draft.habits.length>50000) return 'Enter a valid name and habits.';
    pending=true; onPending(true);
    try {
      const existing=draft.existing;
      const response=await fetcher(existing ? `/api/users/${encodeURIComponent(existing.id)}` : '/api/users', {
        method:existing ? 'PATCH' : 'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({name,habits:draft.habits,...(existing ? {expectedRevision:existing.revision} : {})}),
      });
      if (response.status===400) return 'Enter a valid name and habits.';
      if (response.status===404) return 'This profile no longer exists. Reload the list and try again.';
      if (response.status===409) return 'This profile changed elsewhere. Reload the list and try again.';
      if (!response.ok) return 'Could not save the profile. Please try again.';
      onSaved(); return null;
    } catch { return 'Could not save the profile. Please try again.'; }
    finally { pending=false; onPending(false); }
  };
}

export function UsersView({ state, onRetry, onAdd = () => {}, onEdit = () => {} }: { state: ProfilesState; onRetry: () => void; onAdd?: () => void; onEdit?: (profile:ContextProfile) => void }) {
  return <Stack spacing={2}>
    <Stack direction={{ xs: "column", sm: "row" }} justifyContent="space-between" alignItems={{ sm: "center" }} gap={1}>
      <Box><Typography variant="h4" component="h2">Users</Typography><Typography color="text.secondary">Manage profiles and their preferences.</Typography></Box>
      <Button variant="contained" startIcon={<Add />} onClick={onAdd}>Add User</Button>
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
              {user.is_system === 1 || user.id === 'general' ? <Tooltip title="Clear Sessions"><span><IconButton disabled size="small" aria-label="Clear Sessions for General"><DeleteSweepOutlined fontSize="small" /></IconButton></span></Tooltip> : <><Tooltip title="Edit User"><IconButton size="small" aria-label={`Edit ${user.name}`} onClick={()=>onEdit(user)}><SettingsOutlined fontSize="small" /></IconButton></Tooltip><Tooltip title="Delete User"><span><IconButton disabled size="small" color="error" aria-label={`Delete ${user.name}`}><DeleteOutline fontSize="small" /></IconButton></span></Tooltip></>}
            </Stack></TableCell>
          </TableRow>)}</TableBody>
        </Table>
      </TableContainer>}
  </Stack>;
}

export function UsersPage() {
  const [state, setState] = useState<ProfilesState>({status:'loading'});
  const [attempt, setAttempt] = useState(0);
  const [draft, setDraft] = useState<ProfileDraft | null>(null);
  const [pending, setPending] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [save] = useState(() => createProfileSaver((...args) => fetch(...args), () => { setDraft(null); setAttempt(current=>current+1); }, setPending));
  useEffect(() => {
    const controller = new AbortController();
    setState({status:'loading'});
    loadProfiles(fetch, controller.signal).then(profiles => { if (!controller.signal.aborted) setState({status:'loaded',profiles}); }).catch(() => { if (!controller.signal.aborted) setState({status:'error'}); });
    return () => controller.abort();
  }, [attempt]);
  const close=()=>{if(!pending){setDraft(null);setSaveError('');}};
  return <>
    <UsersView state={state} onRetry={() => setAttempt(current => current + 1)} onAdd={()=>{setSaveError('');setDraft({name:'',habits:''});}} onEdit={profile=>{if(profile.is_system===0 && profile.id!=='general'){setSaveError('');setDraft({name:profile.name,habits:profile.habits,existing:profile});}}} />
    <Dialog open={!!draft} onClose={close} fullWidth maxWidth="sm" aria-labelledby="user-form-title">
      <DialogTitle id="user-form-title">{draft?.existing ? 'Edit User' : 'Add User'}</DialogTitle>
      <DialogContent><Stack spacing={2} sx={{pt:1}}>
        {saveError && <Alert severity="error" action={<Button color="inherit" onClick={()=>{setDraft(null);setSaveError('');setAttempt(current=>current+1);}}>Reload profiles</Button>}>{saveError}</Alert>}
        <TextField autoFocus label="Name" required disabled={pending} value={draft?.name ?? ''} onChange={event=>setDraft(current=>current && {...current,name:event.target.value})} />
        <TextField label="Habits / preferences" multiline minRows={3} disabled={pending} value={draft?.habits ?? ''} onChange={event=>setDraft(current=>current && {...current,habits:event.target.value})} />
      </Stack></DialogContent>
      <DialogActions><Button disabled={pending} onClick={close}>Cancel</Button><Button variant="contained" disabled={pending || !draft?.name.trim()} onClick={async()=>{if(draft){setSaveError('');const error=await save(draft);if(error)setSaveError(error);}}}>Save</Button></DialogActions>
    </Dialog>
  </>;
}
