import { completeInstructionTurn, prepareInstructionTurn, PersonalizationError, type InstructionTurnOutcome, type PersonalizationSnapshot, type TurnIdentifiers } from './week3-session-api';

export type InstructionTurnPreparation = {snapshot:PersonalizationSnapshot;ids?:TurnIdentifiers;token?:string;notice?:string};

/** Preparation failure never substitutes a different profile or prevents an otherwise valid answer. */
export async function prepareProfileTurn(snapshot:PersonalizationSnapshot, turnIds?:TurnIdentifiers):Promise<InstructionTurnPreparation> {
  if(snapshot.profileId==='general')return {snapshot};
  const ids=turnIds ?? {runId:crypto.randomUUID(),messageId:crypto.randomUUID()};
  let context;
  try {
    context=await prepareInstructionTurn(snapshot.sessionId,ids);
  } catch {return {snapshot,ids,notice:'Profile instruction processing could not be prepared for this turn.'};}
  if(context.snapshot.profileId!==snapshot.profileId)throw new PersonalizationError('invalid_association');
  return {snapshot:context.snapshot,ids,token:context.token};
}

export function instructionOutcomeNotice(outcome:InstructionTurnOutcome):string|undefined {
  switch(outcome.status){
    case 'applied':case 'unchanged':case 'general_skipped':return undefined;
    case 'conflict':return 'Profile instructions changed during this turn; the detected update was not saved.';
    case 'clarification_required':return 'This instruction may conflict with an existing profile instruction. Please clarify or edit your profile; no change was saved.';
    case 'unknown_commit':return 'The profile instruction save could not be confirmed. Check the profile before making changes.';
    case 'invalid_token':return 'Profile instruction processing expired or was already used. Check the profile before making changes.';
    case 'detector_failure':return 'Profile instruction detection was unavailable; no instruction update was saved.';
    case 'persistence_failure':return 'Profile instructions could not be saved.';
    default:return 'Profile instruction processing could not be completed for this turn.';
  }
}

export async function finishProfileTurn(prepared:InstructionTurnPreparation):Promise<{applied:boolean;notice?:string;proposal?:Extract<InstructionTurnOutcome,{status:'confirmation_required'}>}> {
  if(!prepared.ids || !prepared.token)return {applied:false,...(prepared.notice?{notice:prepared.notice}:{})};
  try {const outcome=await completeInstructionTurn(prepared.snapshot.sessionId,prepared.ids,prepared.token);if(outcome.status==='confirmation_required')return {applied:false,proposal:outcome};const notice=instructionOutcomeNotice(outcome);return {applied:outcome.status==='applied',...(notice?{notice}:{})};}
  catch {return {applied:false,notice:'The profile instruction save could not be confirmed. Check the profile before making changes.'};}
}
