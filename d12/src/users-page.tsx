import React, { useState, type Dispatch, type SetStateAction } from "react";
import { Alert, Box, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, Paper, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TextField, Tooltip, Typography } from "@mui/material";
import Add from "@mui/icons-material/Add";
import DeleteOutline from "@mui/icons-material/DeleteOutline";
import SettingsOutlined from "@mui/icons-material/SettingsOutlined";
import DeleteSweepOutlined from "@mui/icons-material/DeleteSweepOutlined";

export type MockUser = { id: string; name: string; habits: string; sessions: string[]; system?: boolean };
export const sampleUsers: readonly MockUser[] = [
  { id: "general", name: "General", habits: "", sessions: ["Welcome session"], system: true },
  { id: "alex", name: "Alex", habits: "Prefers detailed technical explanations", sessions: ["Architecture discussion", "Learning TypeScript"] },
  { id: "developer", name: "Developer", habits: "Prefers short answers with code examples", sessions: ["Code review"] },
];

/** These operations change only the in-page sample data. */
export function updateMockUser(users: readonly MockUser[], draft: MockUser): MockUser[] {
  if (!draft.name.trim() || users.some(user => user.id === draft.id && user.system)) return [...users];
  const clean = { ...draft, name: draft.name.trim(), habits: draft.habits.trim(), system: false };
  return users.some(user => user.id === draft.id) ? users.map(user => user.id === draft.id ? clean : user) : [...users, clean];
}
export function deleteMockUser(users: readonly MockUser[], id: string): MockUser[] {
  return users.filter(user => user.id !== id || user.system);
}
export function clearMockSessions(users: readonly MockUser[], id: string): MockUser[] {
  return users.map(user => user.id === id && user.system ? { ...user, sessions: [] } : user);
}

export function UsersPage({ users: suppliedUsers, onUsersChange }: { users?: MockUser[]; onUsersChange?: Dispatch<SetStateAction<MockUser[]>> } = {}) {
  const [localUsers, setLocalUsers] = useState<MockUser[]>(() => sampleUsers.map(user => ({ ...user, sessions: [...user.sessions] })));
  const users = suppliedUsers ?? localUsers;
  const setUsers = onUsersChange ?? setLocalUsers;
  const [draft, setDraft] = useState<MockUser | null>(null);
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState<{ kind: "delete" | "clear"; user: MockUser } | null>(null);
  return <Stack spacing={2}>
    <Stack direction={{ xs: "column", sm: "row" }} justifyContent="space-between" alignItems={{ sm: "center" }} gap={1}>
      <Box><Typography variant="h4" component="h2">Users</Typography><Typography color="text.secondary">Manage sample profiles and their preferences.</Typography></Box>
      <Button variant="contained" startIcon={<Add />} onClick={() => { setEditing(false); setDraft({id:crypto.randomUUID(),name:"",habits:"",sessions:[]}); }}>Add User</Button>
    </Stack>
    <Alert severity="info">Sample data only. Changes on this page are temporary and do not affect real users or sessions.</Alert>
    <TableContainer component={Paper} variant="outlined" sx={{maxWidth:"100%"}}>
      <Table size="small" aria-label="Sample users" sx={{minWidth:800,tableLayout:"fixed"}}>
        <TableHead><TableRow><TableCell sx={{width:"20%"}}>Name</TableCell><TableCell sx={{width:"60%"}}>Habits</TableCell><TableCell align="center" sx={{width:"8%",px:0.5}}>Sessions</TableCell><TableCell align="right" sx={{width:"12%",px:1}}>Actions</TableCell></TableRow></TableHead>
        <TableBody>{[...users.filter(user=>user.system),...users.filter(user=>!user.system)].map(user=><TableRow key={user.id}>
          <TableCell component="th" scope="row"><Stack direction="row" alignItems="center" gap={1}><Typography noWrap>{user.name}</Typography>{user.system && <Chip label="System" size="small" />}</Stack></TableCell>
          <TableCell>{user.habits ? <Tooltip title={user.habits}><Typography tabIndex={0} noWrap color="text.secondary" aria-label={`Habits for ${user.name}: ${user.habits}`}>{user.habits}</Typography></Tooltip> : <Typography color="text.secondary">No habits added.</Typography>}</TableCell>
          <TableCell align="center" sx={{px:0.5}}>{user.sessions.length}</TableCell>
          <TableCell align="right" sx={{px:1}}><Stack direction="row" justifyContent="flex-end" spacing={0.5}>
            {user.system ? <Tooltip title="Clear Sessions"><IconButton size="small" aria-label="Clear Sessions for General" onClick={()=>setConfirm({kind:"clear",user})}><DeleteSweepOutlined fontSize="small" /></IconButton></Tooltip> : <><Tooltip title="Edit User"><IconButton size="small" aria-label={`Edit ${user.name}`} onClick={()=>{setEditing(true);setDraft({...user,sessions:[...user.sessions]});}}><SettingsOutlined fontSize="small" /></IconButton></Tooltip><Tooltip title="Delete User"><IconButton size="small" color="error" aria-label={`Delete ${user.name}`} onClick={()=>setConfirm({kind:"delete",user})}><DeleteOutline fontSize="small" /></IconButton></Tooltip></>}
          </Stack></TableCell>
        </TableRow>)}</TableBody>
      </Table>
    </TableContainer>
    <Dialog open={!!draft} onClose={()=>setDraft(null)} fullWidth maxWidth="sm" aria-labelledby="user-form-title">
      <DialogTitle id="user-form-title">{editing ? "Edit User" : "Add User"}</DialogTitle>
      <DialogContent><Stack spacing={2} sx={{pt:1}}>
        <TextField autoFocus label="Name" required value={draft?.name ?? ""} onChange={event=>setDraft(current=>current && {...current,name:event.target.value})} />
        <TextField label="Habits / preferences" multiline minRows={3} value={draft?.habits ?? ""} onChange={event=>setDraft(current=>current && {...current,habits:event.target.value})} />
      </Stack></DialogContent>
      <DialogActions><Button onClick={()=>setDraft(null)}>Cancel</Button><Button variant="contained" disabled={!draft?.name.trim()} onClick={()=>{if(draft){setUsers(current=>updateMockUser(current,draft));setDraft(null);}}}>Save</Button></DialogActions>
    </Dialog>
    <Dialog open={!!confirm} onClose={()=>setConfirm(null)} aria-labelledby="user-confirm-title">
      <DialogTitle id="user-confirm-title">{confirm?.kind === "clear" ? "Clear sample sessions?" : "Delete sample user?"}</DialogTitle>
      <DialogContent><Typography>This only changes sample data on this page. Real sessions and user data are not affected.</Typography></DialogContent>
      <DialogActions><Button onClick={()=>setConfirm(null)}>Cancel</Button><Button color="error" onClick={()=>{if(confirm)setUsers(current=>confirm.kind === "clear" ? clearMockSessions(current,confirm.user.id) : deleteMockUser(current,confirm.user.id));setConfirm(null);}}>Confirm</Button></DialogActions>
    </Dialog>
  </Stack>;
}
