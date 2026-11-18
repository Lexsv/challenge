import { createTopicLifecycle } from '../src/topic-lifecycle.ts';

/** Explicit synthetic QA fixture; never used by the ordinary backend. */
export async function processMockTopic(repository,sessionId,runId) {
  const assess=async events=>events.flatMap(event=>{
    if(event.type!=='message' || event.payload.role!=='user' || !event.payload.text.startsWith('QA_TOPIC: '))return [];
    const text=event.payload.text;const value=text.slice('QA_TOPIC: '.length).trim();if(!value)return [];
    const evidence={messageId:event.payload.id,role:'user',sequence:event.sequence,quote:text,existence:'verified'};
    return [{candidate:{key:'Synthetic QA topic',value,status:'confirmed',sources:[event.payload.id],evidence:[evidence],assessment:{support:'unverified',change:'unverified'}},assessment:{classification:'fact',factSupported:true,changeConfirmed:false,evidence:[{messageId:event.payload.id,quote:text}]}}];
  });
  await createTopicLifecycle(repository,sessionId,assess)([{id:runId,messages:[]}]);
}
