import React, { useEffect, useState } from "react";
import { Alert, Box, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, Paper, Stack, Tab, Tabs, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TextField, Tooltip, Typography } from "@mui/material";
import Add from "@mui/icons-material/Add";
import DeleteOutline from "@mui/icons-material/DeleteOutline";
import SettingsOutlined from "@mui/icons-material/SettingsOutlined";
import DeleteSweepOutlined from "@mui/icons-material/DeleteSweepOutlined";
import { listSessions } from './week3-session-api';
import { sessionCounts } from './profile-session-utils';
import { listWorkerSessions } from './worker-api';

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
export type DeletionTarget = { kind:'profile'; profile:ContextProfile } | { kind:'clear' };

export function parseHabits(text:string):string[] {
  return text.split(/\r\n|\n|\r/).filter(line=>line.startsWith('* ')).map(line=>line.slice(2));
}

type HabitsMode = 'raw' | 'preview';
export function HabitsEditorView({value,onChange,disabled,mode,onModeChange}:{value:string;onChange:(value:string)=>void;disabled:boolean;mode:HabitsMode;onModeChange:(mode:HabitsMode)=>void}) {
  const habits=parseHabits(value);
  return <Box sx={{display:'grid',gridTemplateColumns:{xs:'minmax(0, 1fr)',md:'minmax(0, 1.2fr) minmax(0, 1fr)'},gap:3}}>
    <Box sx={{minWidth:0}}>
      <Typography variant="subtitle1" fontWeight={700} sx={{mb:1}}>Habits</Typography>
      <Tabs value={mode} onChange={(_event,next:HabitsMode)=>onModeChange(next)} aria-label="Habits mode" sx={{mb:1}}>
        <Tab value="raw" label="Raw" id="habits-tab-raw" aria-controls="habits-panel" />
        <Tab value="preview" label="Preview" id="habits-tab-preview" aria-controls="habits-panel" />
      </Tabs>
      <Box role="tabpanel" id="habits-panel" aria-labelledby={`habits-tab-${mode}`}>
        {mode==='raw' ? <TextField fullWidth label="Habits / preferences" multiline minRows={6} disabled={disabled} value={value} onChange={event=>onChange(event.target.value)} /> : <Box>
          <Typography variant="body2" color="text.secondary">Preview shows lines starting with * followed by a space. All raw text is saved unchanged.</Typography>
          {habits.length ? <Box component="ul" sx={{pl:3,overflowWrap:'anywhere'}}>{habits.map((habit,index)=><li key={index}><Typography component="span" sx={{whiteSpace:'pre-wrap'}}>{habit}</Typography></li>)}</Box> : <Typography color="text.secondary" sx={{mt:1}}>No habits to preview.</Typography>}
        </Box>}
      </Box>
    </Box>
    <Paper variant="outlined" sx={{p:2.5,bgcolor:'background.paper',alignSelf:'start',minWidth:0}}>
      <Typography variant="h6">Example</Typography>
      <Typography variant="body2" color="text.secondary">Write each persistent instruction on a separate line. Start every instruction with an asterisk followed by one space: <Box component="code" sx={{whiteSpace:'pre-wrap'}}>* </Box>.</Typography>
      <Box component="pre" sx={{p:2,borderRadius:1.5,bgcolor:'background.paper',whiteSpace:'pre-wrap',overflowWrap:'anywhere',fontSize:'0.85rem'}}>{'* Always start responses with a greeting.\n* Always provide detailed explanations.\n* Explain technical concepts using examples.'}</Box>
    </Paper>
  </Box>;
}

function HabitsEditor({value,onChange,disabled}:{value:string;onChange:(value:string)=>void;disabled:boolean}) {
  const [mode,setMode]=useState<HabitsMode>('raw');
  return <HabitsEditorView value={value} onChange={onChange} disabled={disabled} mode={mode} onModeChange={setMode} />;
}

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

export function createProfileDeleter(fetcher:typeof fetch, onDeleted:()=>void, onPending:(pending:boolean)=>void) {
  let pending=false;
  return async (target:DeletionTarget):Promise<string | null> => {
    if(pending) return null;
    if(target.kind==='profile' && (target.profile.is_system===1 || target.profile.id==='general')) return 'General cannot be deleted.';
    pending=true; onPending(true);
    try {
      const url=target.kind==='clear' ? '/api/users/general/sessions' : `/api/users/${encodeURIComponent(target.profile.id)}`;
      const response=await fetcher(url,{method:'DELETE'});
      if(response.status===404) return 'This profile no longer exists. Reload the list and try again.';
      if(!response.ok) return 'Could not complete the deletion. Please try again.';
      onDeleted(); return null;
    } catch { return 'Could not confirm the deletion. Reload the list before trying again.'; }
    finally { pending=false; onPending(false); }
  };
}

export function DeletionDialog({target,pending,error,onCancel,onConfirm}:{target:DeletionTarget | null;pending:boolean;error:string;onCancel:()=>void;onConfirm:()=>void}) {
  const close=()=>{if(!pending)onCancel();};
  return <Dialog open={!!target} onClose={close} aria-labelledby="delete-profile-title">
    <DialogTitle id="delete-profile-title">{target?.kind==='clear' ? 'Clear General sessions?' : 'Delete profile?'}</DialogTitle>
    <DialogContent><Stack spacing={2}>
      {error && <Alert severity="error">{error}</Alert>}
      <Typography>{target?.kind==='clear' ? 'All General Chat and Worker sessions, their history, and memory will be permanently deleted. The General profile and shared Worker Templates will remain.' : `The profile ${target?.kind==='profile' ? target.profile.name : ''} and its associated Chat and Worker sessions, history, and memory will be permanently deleted. Shared Worker Templates will remain.`}</Typography>
    </Stack></DialogContent>
    <DialogActions><Button disabled={pending} onClick={close}>Cancel</Button><Button disabled={pending} color="error" onClick={onConfirm}>{target?.kind==='clear' ? 'Clear Sessions' : 'Delete Profile'}</Button></DialogActions>
  </Dialog>;
}

export function UsersView({ state, counts=null, workerCounts=null, onRetry, onAdd = () => {}, onEdit = () => {}, onDelete = () => {}, onClear = () => {} }: { state: ProfilesState; counts?:Record<string,number> | null; workerCounts?:Record<string,number> | null; onRetry: () => void; onAdd?: () => void; onEdit?: (profile:ContextProfile) => void; onDelete?: (profile:ContextProfile) => void; onClear?:()=>void }) {
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
          <TableHead><TableRow><TableCell sx={{width:"20%"}}>Name</TableCell><TableCell sx={{width:"48%"}}>Habits</TableCell><TableCell align="center" sx={{width:"10%",px:0.5}}>Chat Sessions</TableCell><TableCell align="center" sx={{width:"10%",px:0.5}}>Worker Sessions</TableCell><TableCell align="right" sx={{width:"12%",px:1}}>Actions</TableCell></TableRow></TableHead>
          <TableBody>{[...state.profiles].sort((a,b)=>Number(b.id==='general')-Number(a.id==='general')).map(user=><TableRow key={user.id}>
            <TableCell component="th" scope="row"><Stack direction="row" alignItems="center" gap={1}><Typography noWrap>{user.name}</Typography>{user.is_system === 1 && <Chip label="System" size="small" />}</Stack></TableCell>
            <TableCell>{user.habits ? <Tooltip title={user.habits}><Typography tabIndex={0} noWrap color="text.secondary" aria-label={`Habits for ${user.name}: ${user.habits}`}>{user.habits}</Typography></Tooltip> : <Typography color="text.secondary">No habits added.</Typography>}</TableCell>
            <TableCell align="center" sx={{px:0.5}} aria-label={counts===null ? `Session count unavailable for ${user.name}` : `Sessions for ${user.name}`}>{counts===null ? '—' : counts[user.id] ?? 0}</TableCell>
            <TableCell align="center" sx={{px:0.5}} aria-label={workerCounts===null ? `Worker session count unavailable for ${user.name}` : `Worker sessions for ${user.name}`}>{workerCounts===null ? '—' : workerCounts[user.id] ?? 0}</TableCell>
            <TableCell align="right" sx={{px:1}}><Stack direction="row" justifyContent="flex-end" spacing={0.5}>
              {user.is_system === 1 || user.id === 'general' ? <Tooltip title="Clear Sessions"><IconButton size="small" aria-label="Clear Sessions for General" onClick={onClear}><DeleteSweepOutlined fontSize="small" /></IconButton></Tooltip> : <><Tooltip title="Edit User"><IconButton size="small" aria-label={`Edit ${user.name}`} onClick={()=>onEdit(user)}><SettingsOutlined fontSize="small" /></IconButton></Tooltip><Tooltip title="Delete User"><IconButton size="small" color="error" aria-label={`Delete ${user.name}`} onClick={()=>onDelete(user)}><DeleteOutline fontSize="small" /></IconButton></Tooltip></>}
            </Stack></TableCell>
          </TableRow>)}</TableBody>
        </Table>
      </TableContainer>}
  </Stack>;
}

export function UsersPage({sessionsRevision=0,profilesRevision=0,onProfilesChanged,onProfileMutationStart,onProfileMutationSettled}: {sessionsRevision?:number;profilesRevision?:number;onProfilesChanged?:()=>void;onProfileMutationStart?:()=>void;onProfileMutationSettled?:()=>void} = {}) {
  const [state, setState] = useState<ProfilesState>({status:'loading'});
  const [attempt, setAttempt] = useState(0);
  const [draft, setDraft] = useState<ProfileDraft | null>(null);
  const [pending, setPending] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [target, setTarget] = useState<DeletionTarget | null>(null);
  const [deletePending, setDeletePending] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [counts,setCounts]=useState<Record<string,number> | null>(null);
  const [workerCounts,setWorkerCounts]=useState<Record<string,number> | null>(null);
  const [save] = useState(() => createProfileSaver((...args) => fetch(...args), () => { setDraft(null); setAttempt(current=>current+1); onProfilesChanged?.(); }, setPending));
  const [remove] = useState(() => createProfileDeleter((...args)=>fetch(...args), () => { setTarget(null); setAttempt(current=>current+1); }, setDeletePending));
  useEffect(() => {
    const controller = new AbortController();
    setState({status:'loading'});
    loadProfiles(fetch, controller.signal).then(profiles => { if (!controller.signal.aborted) setState({status:'loaded',profiles}); }).catch(() => { if (!controller.signal.aborted) setState({status:'error'}); });
    return () => controller.abort();
  }, [attempt,profilesRevision]);
  useEffect(()=>{
    let active=true;setCounts(null);
    listSessions().then(items=>{if(active)setCounts(sessionCounts(items));}).catch(()=>{if(active)setCounts(null);});
    setWorkerCounts(null);listWorkerSessions().then(items=>{if(active){const result:Record<string,number>={};for(const item of items)result[item.profileId]=(result[item.profileId] ?? 0)+1;setWorkerCounts(result);}}).catch(()=>{if(active)setWorkerCounts(null);});
    return ()=>{active=false;};
  },[sessionsRevision,attempt]);
  const close=()=>{if(!pending){setDraft(null);setSaveError('');}};
  return <>
    <UsersView state={state} counts={counts} workerCounts={workerCounts} onRetry={() => setAttempt(current => current + 1)} onAdd={()=>{setSaveError('');setDraft({name:'',habits:''});}} onEdit={profile=>{if(profile.is_system===0 && profile.id!=='general'){setSaveError('');setDraft({name:profile.name,habits:profile.habits,existing:profile});}}} onDelete={profile=>{if(profile.is_system===0 && profile.id!=='general'){setDeleteError('');setTarget({kind:'profile',profile});}}} onClear={()=>{setDeleteError('');setTarget({kind:'clear'});}} />
    <Dialog open={!!draft} onClose={close} fullWidth maxWidth="md" aria-labelledby="user-form-title">
      <DialogTitle id="user-form-title">{draft?.existing ? 'Edit User' : 'Add User'}</DialogTitle>
      <DialogContent><Stack spacing={2} sx={{pt:1}}>
        {saveError && <Alert severity="error" action={<Button color="inherit" onClick={()=>{setDraft(null);setSaveError('');setAttempt(current=>current+1);}}>Reload profiles</Button>}>{saveError}</Alert>}
        <TextField autoFocus label="Name" required disabled={pending} value={draft?.name ?? ''} onChange={event=>setDraft(current=>current && {...current,name:event.target.value})} />
        <HabitsEditor value={draft?.habits ?? ''} disabled={pending} onChange={habits=>setDraft(current=>current && {...current,habits})} />
      </Stack></DialogContent>
      <DialogActions><Button disabled={pending} onClick={close}>Cancel</Button><Button variant="contained" disabled={pending || !draft?.name.trim()} onClick={async()=>{if(draft){setSaveError('');const error=await save(draft);if(error)setSaveError(error);}}}>Save</Button></DialogActions>
    </Dialog>
    <DeletionDialog target={target} pending={deletePending} error={deleteError} onCancel={()=>{setTarget(null);setDeleteError('');}} onConfirm={async()=>{if(target){setDeleteError('');onProfileMutationStart?.();try{const error=await remove(target);if(error)setDeleteError(error);}finally{onProfileMutationSettled?.();}}}} />
  </>;
}
