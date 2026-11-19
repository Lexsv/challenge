import { Box, Button, Paper, Stack, Typography } from '@mui/material';
import { decideInstructionProposal, type InstructionDecisionOutcome, type InstructionTurnOutcome } from './week3-session-api';

export type HabitsProposal = Extract<InstructionTurnOutcome,{status:'confirmation_required'}>;
export function scheduleProposalExpiry(deadline:number,onExpire:()=>void):()=>void {
  const timer=setTimeout(onExpire,Math.max(0,deadline-performance.now()));
  return ()=>clearTimeout(timer);
}
export function proposalIsActionable(active:boolean,deadline:number):boolean {
  return active && performance.now()<deadline;
}

/** Each controller is bound to the session and prevents simultaneous decisions. */
export function createHabitsDecision(sessionId:string, decide=decideInstructionProposal) {
  let pending=false;
  return async (proposalId:string,decision:'accept'|'reject'):Promise<InstructionDecisionOutcome|{status:'unknown'}|null>=>{
    if(pending)return null;
    pending=true;
    try{return await decide(sessionId,proposalId,decision);}catch{return {status:'unknown'};}finally{pending=false;}
  };
}

export function decisionNotice(status:InstructionDecisionOutcome['status']|'unknown'):string {
  switch(status){
    case 'applied':return 'Profile instructions saved.';
    case 'rejected':return '';
    case 'unchanged':return 'No profile change was needed.';
    case 'conflict':return 'Profile changed. Review its instructions before trying again.';
    case 'expired_proposal':case 'invalid_proposal':return 'This proposal expired or is no longer available.';
    case 'clarification_required':return 'This change needs clarification. No update was saved.';
    case 'persistence_failure':return 'Profile instructions could not be saved.';
    default:return 'The result could not be confirmed. Check the profile before making changes.';
  }
}

export function HabitsConfirmationCard({proposal,pending,onDecision}:{proposal:HabitsProposal;pending:boolean;onDecision:(decision:'accept'|'reject')=>void}) {
  return <Paper component="section" variant="outlined" aria-label="Profile instruction confirmation" sx={{p:1.25,mb:1,bgcolor:'background.paper'}}>
    <Stack spacing={0.5}>
      <Typography variant="body2" fontWeight={600}>Apply this profile change?</Typography>
      <Box component="ul" sx={{m:0,pl:2.5,maxHeight:112,overflowY:'auto',overflowWrap:'anywhere'}}>
        {proposal.changes.map((change,index)=><Typography component="li" variant="body2" key={index}>
          {change.action==='ADD' ? <>Add: {change.after}</> : change.action==='REMOVE' ? <>Remove: {change.before}</> : <>Replace: {change.before} → {change.after}</>}
        </Typography>)}
      </Box>
      <Stack direction="row" justifyContent="flex-end" spacing={0.5}>
        <Button size="small" disabled={pending} onClick={()=>onDecision('reject')}>Discard</Button>
        <Button size="small" variant="contained" disabled={pending} onClick={()=>onDecision('accept')}>Apply</Button>
      </Stack>
    </Stack>
  </Paper>;
}
