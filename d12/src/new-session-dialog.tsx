import React, { useEffect, useState } from "react";
import { Alert, Button, Dialog, DialogActions, DialogContent, DialogTitle, MenuItem, Stack, TextField } from "@mui/material";
import type { MockUser } from "./users-page";

export const canCreateSession = (name:string,userId:string,users:readonly MockUser[],pending:boolean) => !pending && !!name.trim() && users.some(user=>user.id===userId);

export function NewSessionFields({name,userId,users,onNameChange,onUserChange}: {name:string;userId:string;users:readonly MockUser[];onNameChange:(value:string)=>void;onUserChange:(value:string)=>void}) {
  return <Stack spacing={2} sx={{pt:1}}>
    <TextField autoFocus label="Session Name" required value={name} slotProps={{htmlInput:{maxLength:200}}} onChange={event=>onNameChange(event.target.value)} />
    <TextField select label="User" required value={userId} onChange={event=>onUserChange(event.target.value)}>
      {users.map(user=><MenuItem key={user.id} value={user.id}>{user.name}</MenuItem>)}
    </TextField>
    <Alert severity="info">User selection is shown only during this visit and is not saved with the session.</Alert>
  </Stack>;
}

export function NewSessionDialog({open,users,pending,error,onClose,onCreate}: {open:boolean;users:readonly MockUser[];pending:boolean;error:string;onClose:()=>void;onCreate:(name:string,owner:string)=>void}) {
  const [name,setName]=useState("");
  const [userId,setUserId]=useState("general");
  useEffect(()=>{if(open){setName("");setUserId("general");}},[open]);
  const valid=canCreateSession(name,userId,users,pending);
  return <Dialog open={open} onClose={pending ? undefined : onClose} fullWidth maxWidth="sm" aria-labelledby="new-session-title">
    <form onSubmit={event=>{event.preventDefault();const user=users.find(item=>item.id===userId);if(valid && user)onCreate(name.trim(),user.name);}}>
      <DialogTitle id="new-session-title">New Session</DialogTitle>
      <DialogContent><NewSessionFields name={name} userId={userId} users={users} onNameChange={setName} onUserChange={setUserId}/>{error && <Alert severity="error" sx={{mt:2}}>{error}</Alert>}</DialogContent>
      <DialogActions><Button onClick={onClose} disabled={pending}>Cancel</Button><Button type="submit" variant="contained" disabled={!valid}>Create Session</Button></DialogActions>
    </form>
  </Dialog>;
}
