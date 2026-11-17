import React, { useEffect, useState } from "react";
import { Alert, Button, Dialog, DialogActions, DialogContent, DialogTitle, MenuItem, Stack, TextField } from "@mui/material";
type UserChoice = {id:string;name:string};

export const canCreateSession = (name:string,userId:string,users:readonly UserChoice[],pending:boolean) => !pending && !!name.trim() && users.some(user=>user.id===userId);

export function NewSessionFields({name,userId,users,onNameChange,onUserChange,persisted=false}: {name:string;userId:string;users:readonly UserChoice[];onNameChange:(value:string)=>void;onUserChange:(value:string)=>void;persisted?:boolean}) {
  return <Stack spacing={2} sx={{pt:1}}>
    <TextField autoFocus label="Session Name" required value={name} slotProps={{htmlInput:{maxLength:200}}} onChange={event=>onNameChange(event.target.value)} />
    <TextField select label="User" required value={userId} onChange={event=>onUserChange(event.target.value)}>
      {users.map(user=><MenuItem key={user.id} value={user.id}>{user.name}</MenuItem>)}
    </TextField>
    <Alert severity="info">{persisted ? 'The selected user is saved with the session and cannot be changed.' : 'User selection is shown only during this visit and is not saved with the session.'}</Alert>
  </Stack>;
}

export function NewSessionDialog({open,users,pending,error,onClose,onCreate,persisted=false,profilesError=false,onRetryProfiles}: {open:boolean;users:readonly UserChoice[];pending:boolean;error:string;onClose:()=>void;onCreate:(name:string,userId:string)=>void;persisted?:boolean;profilesError?:boolean;onRetryProfiles?:()=>void}) {
  const [name,setName]=useState("");
  const [userId,setUserId]=useState("general");
  useEffect(()=>{if(open){setName("");setUserId("general");}},[open]);
  const valid=canCreateSession(name,userId,users,pending);
  return <Dialog open={open} onClose={pending ? undefined : onClose} fullWidth maxWidth="sm" aria-labelledby="new-session-title">
    <form onSubmit={event=>{event.preventDefault();if(valid)onCreate(name.trim(),userId);}}>
      <DialogTitle id="new-session-title">New Session</DialogTitle>
      <DialogContent><NewSessionFields name={name} userId={userId} users={users} onNameChange={setName} onUserChange={setUserId} persisted={persisted}/>{profilesError && <Alert severity="error" action={<Button onClick={onRetryProfiles}>Retry</Button>}>Could not load profiles.</Alert>}{error && <Alert severity="error" sx={{mt:2}}>{error}</Alert>}</DialogContent>
      <DialogActions><Button onClick={onClose} disabled={pending}>Cancel</Button><Button type="submit" variant="contained" disabled={!valid}>Create Session</Button></DialogActions>
    </form>
  </Dialog>;
}
