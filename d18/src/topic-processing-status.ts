/** Isolated status presentation contract; not connected to the production UI. */
export type TopicProcessingStatus='completed'|'alreadyCompleted'|'unresolved'|'rejected'|'stale'|'failed'|'disabled'|'unknown';
export type TopicProcessingNotice={severity:'success'|'warning'|'error';message:string}|null;
export function topicProcessingNotice(status:TopicProcessingStatus):TopicProcessingNotice {
  switch(status){
    case 'completed':return {severity:'success',message:'Memory was saved.'};
    case 'alreadyCompleted':case 'disabled':return null;
    case 'unresolved':return {severity:'warning',message:'Memory needs clarification before it can be saved.'};
    case 'rejected':return {severity:'warning',message:'Memory could not be verified and was not saved.'};
    case 'stale':return {severity:'warning',message:'Memory changed during processing. Process it again.'};
    case 'failed':return {severity:'error',message:'Memory processing failed; no save was confirmed.'};
    case 'unknown':return {severity:'warning',message:'Memory save could not be confirmed. Check its status before retrying.'};
  }
}
