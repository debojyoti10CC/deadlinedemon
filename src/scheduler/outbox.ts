import type { PoolClient } from 'pg';
import type { Agent,Contract,Evidence,GitHubReader,Transport } from '../types.js';
import { getUser,queueMessage,recordConversation } from '../db/queries.js';
import { observe,observeTaskDeadline } from '../contracts/service.js';
import { githubDeadlineAlert,taskReminder } from '../contracts/tasks.js';
import { reminderRelevant } from '../contracts/reminders.js';
import { evidenceSummary } from '../agent/orchestrator.js';
import { hourlySummaryMessage } from '../agent/messages.js';
import { HOUR_MS, unfinishedForSummary } from './summaries.js';
export interface OutboxRow {id:string;user_id:string;contract_id:string|null;contract_version:number|null;referenced_contract_ids?:string[]|null;space_id:string;event_key:string;message_text:string;kind:'reply'|'reminder'|'verdict'|'victory'|'error'|'summary';attempts:number;created_at?:Date}
export async function victory(db:PoolClient,c:Contract,e:Evidence,spaceId:string,ai:Agent):Promise<void>{
 if(c.deleted_at)return;
 const text=await ai.generate('victory',{contract:c,evidence:e,late:!!c.missed_at},c.intensity);
 await queueMessage(db,{userId:c.user_id,spaceId,contractId:c.id,key:`completed:${c.id}`,kind:'victory',text:`${text}\n${evidenceSummary(e)}\n${c.artifact_url}`});
}
export async function deliverOutbox(db:PoolClient,row:OutboxRow,github:GitHubReader,ai:Agent,transport:Transport):Promise<void>{
 const user=await getUser(db,row.user_id);
 if(!user.space_id || user.space_id!==row.space_id){await suppress(db,row.id);return;}
 if(row.referenced_contract_ids?.length){
  const removed=(await db.query('SELECT 1 FROM contracts WHERE user_id=$1 AND id=ANY($2::uuid[]) AND deleted_at IS NOT NULL LIMIT 1',[user.id,row.referenced_contract_ids])).rows[0];
  if(removed){await suppress(db,row.id);return;}
 }
 // Deletion is independent of state/version and applies to every kind of queued snapshot.
 const current=row.contract_id?(await db.query<Contract>('SELECT * FROM contracts WHERE id=$1 AND user_id=$2 FOR UPDATE',[row.contract_id,user.id])).rows[0]:undefined;
 if(row.contract_id&&(!current||current.deleted_at)){await suppress(db,row.id);return;}
 if(row.kind==='summary'){
  const now=new Date();
  if(user.paused||!row.created_at||now.getTime()-row.created_at.getTime()>=HOUR_MS){await suppress(db,row.id);return;}
  const contracts=await unfinishedForSummary(db,user.id);
  if(!contracts.length){await suppress(db,row.id);return;}
  row.message_text=hourlySummaryMessage(contracts,user,now);
  await db.query('UPDATE outbox SET message_text=$2 WHERE id=$1',[row.id,row.message_text]);
 }
 if(row.kind==='reply'&&row.contract_id&&row.contract_version!==null){
  if(!current||current.version!==row.contract_version){await suppress(db,row.id);return;}
 }
 if(row.kind!=='reply'&&row.kind!=='summary'){
  if(user.paused){await db.query("UPDATE outbox SET status='pending',run_at=now()+interval '1 minute',locked_until=NULL,attempts=0 WHERE id=$1",[row.id]);return;}
  const c=current;
  if(!c||c.state==='cancelled'||(c.state==='completed'&&row.kind!=='victory')){await suppress(db,row.id);return;}
  if(row.kind==='reminder'||row.kind==='verdict'){
   // A retry/resume must not release checkpoints whose time window has passed.
   // Only scheduled milestone keys participate; blocker and manual replies keep their own rules.
   const prefix=`milestone:${c.id}:`;
   const milestone=row.event_key.startsWith(prefix)?row.event_key.slice(prefix.length):undefined;
   const expired=()=>milestone!==undefined&&!reminderRelevant(milestone,c.due_at,new Date());
   if(expired()){await suppress(db,row.id);return;}
   if(c.artifact_type==='task'){
    if(row.kind==='reminder'&&c.due_at.getTime()<=Date.now()){await suppress(db,row.id);return;}
    await observeTaskDeadline(db,c);
    if(expired()){await suppress(db,row.id);return;}
    row.message_text=taskReminder(c,user.timezone,new Date(),milestone==='followup',milestone);
    await db.query('UPDATE outbox SET message_text=$2 WHERE id=$1',[row.id,row.message_text]);
   }else{
   const e=await github.inspect(c);
   const result=await observe(db,c,e);
   if(result.completed){await suppress(db,row.id);if(result.newlyCompleted)await victory(db,c,e,row.space_id,ai);return;}
   if(expired()){await suppress(db,row.id);return;}
   if(row.kind==='reminder'&&c.due_at.getTime()<=Date.now()) {await suppress(db,row.id);return;}
   if(milestone?.startsWith('before_')){
    // Never reuse generated checkpoint countdowns after a pause or transport retry.
    row.message_text=githubDeadlineAlert(c,user.timezone,new Date(),evidenceSummary(e));
    await db.query('UPDATE outbox SET message_text=$2 WHERE id=$1',[row.id,row.message_text]);
   // Other message kinds retain their existing evidence- and setting-driven copy refresh.
   }else if(row.contract_version!==c.version||evidenceFingerprint(c.last_observed_state)!==evidenceFingerprint(e)){
    row.message_text=`${await ai.generate(row.kind==='verdict'?'missed':milestone==='followup'?'recovery':'reminder',{contract:c,evidence:e,now:new Date().toISOString(),timezone:user.timezone,milestone},c.intensity)}\n${evidenceSummary(e)}\n${c.artifact_url}`;
    if(expired()){await suppress(db,row.id);return;}
    await db.query('UPDATE outbox SET message_text=$2 WHERE id=$1',[row.id,row.message_text]);
   }
   }
  }
 }
 await transport.responding(row.space_id,async()=>{await transport.send(row.space_id,row.message_text);});
 await db.query("UPDATE outbox SET status='sent',sent_at=now(),locked_until=NULL,last_error=NULL WHERE id=$1",[row.id]);
 if(row.kind==='reply')await recordConversation(db,row.user_id,'assistant',row.message_text);
}
async function suppress(db:PoolClient,id:string):Promise<void>{await db.query("UPDATE outbox SET status='suppressed',locked_until=NULL WHERE id=$1",[id]);}
function evidenceFingerprint(e:Evidence|null):string {
 if(!e)return '';
 const {observedAt,...facts}=e; return JSON.stringify(facts);
}
