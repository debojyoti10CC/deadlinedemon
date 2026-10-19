import type pg from 'pg';
import type { PoolClient } from 'pg';
import type { Agent,Contract,Evidence,GitHubReader,Transport } from '../types.js';
import { transaction,lockUser } from '../db/pool.js';
import { getUser,queueMessage } from '../db/queries.js';
import { Orchestrator,evidenceSummary } from '../agent/orchestrator.js';
import { observe,observeTaskDeadline } from '../contracts/service.js';
import { githubDeadlineAlert,taskReminder } from '../contracts/tasks.js';
import { reminderRelevant } from '../contracts/reminders.js';
import { deliverOutbox,victory,type OutboxRow } from './outbox.js';
import { safeError } from '../utils/errors.js';
import type { Logger } from 'pino';
import {createHash} from 'node:crypto';
import { queueDueSummary } from './summaries.js';
import { scheduledProblemMessage } from '../agent/messages.js';
type QueueTable='inbound_messages'|'scheduled_jobs'|'outbox';
export async function claim(db:PoolClient,table:QueueTable):Promise<Record<string,unknown>|undefined>{
 // Table name is an internal closed union; all external values are parameters.
 const row=(await db.query(`UPDATE ${table} SET status='processing',attempts=attempts+1,locked_until=now()+interval '5 minutes'
  WHERE id=(SELECT id FROM ${table} WHERE (status='pending' OR (status='processing' AND locked_until<now()))
  AND run_at<=now() ORDER BY run_at,id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`)).rows[0];
 return row;
}
export class Worker {
 private stopped=false; private running:Promise<void>|undefined; private wake:(()=>void)|undefined;
 lastTickAt:Date|null=null; lastSuccessAt:Date|null=null;
 constructor(private pool:pg.Pool,private router:Orchestrator,private github:GitHubReader,private ai:Agent,private transport:Transport,private logger:Logger,private intervalMs=30000,private monitorMs=300000){}
 start():Promise<void>{this.running??=this.loop();return this.running;}
 wakeNow():void {this.wake?.();}
 async stop():Promise<void>{this.stopped=true;this.wake?.();await this.running;}
 async tick():Promise<void>{
  this.lastTickAt=new Date();
  if(!this.stopped)await queueDueSummary(this.pool);
  for(const table of ['inbound_messages','scheduled_jobs','outbox'] as const){
   if(this.stopped)break;
   const row=await transaction(this.pool,db=>claim(db,table));
   if(!row)continue;
   try{
    await transaction(this.pool,async db=>{
     const userId=table==='scheduled_jobs'?(await db.query<{user_id:string}>('SELECT user_id FROM contracts WHERE id=$1',[row.contract_id])).rows[0]?.user_id:String(row.user_id);
     if(!userId)throw new Error('Queue owner missing');
     await lockUser(db,userId);
     const current=(await db.query(`SELECT * FROM ${table} WHERE id=$1 FOR UPDATE`,[row.id])).rows[0];
     if(!current||current.status!=='processing')return;
     if(table==='inbound_messages'){
      const user=await getUser(db,userId);
      await this.router.handle(db,user,current.message_text,current.space_id,current.provider_message_id);
      await db.query("UPDATE inbound_messages SET status='done',processed_at=now(),locked_until=NULL,last_error=NULL WHERE id=$1",[row.id]);
     }else if(table==='scheduled_jobs')await this.processJob(db,current);
     else await deliverOutbox(db,current as OutboxRow,this.github,this.ai,this.transport);
    });
    this.lastSuccessAt=new Date();
   }catch(error){
    this.logger.error({queue:table,eventId:row.id,error:safeError(error)},'Queue operation failed');
    await this.retry(table,row,error);
   }
  }
 }
 private async loop():Promise<void>{
  while(!this.stopped){
   try{await this.tick();}catch(error){this.logger.error({error:safeError(error)},'Worker tick failed');}
   if(this.stopped)break;
   await new Promise<void>(resolve=>{const timer=setTimeout(()=>{this.wake=undefined;resolve();},this.intervalMs);this.wake=()=>{clearTimeout(timer);this.wake=undefined;resolve();};});
  }
 }
 private async processJob(db:PoolClient,job:Record<string,any>):Promise<void>{
  const c=(await db.query<Contract>('SELECT * FROM contracts WHERE id=$1 FOR UPDATE',[job.contract_id])).rows[0]!;
  const done=()=>db.query("UPDATE scheduled_jobs SET status='done',locked_until=NULL,last_error=NULL WHERE id=$1",[job.id]);
  if(!c||c.deleted_at||!['active','missed'].includes(c.state)){await done();return;}
  const user=await getUser(db,c.user_id); const now=new Date();
  if(user.paused||!user.space_id){await db.query("UPDATE scheduled_jobs SET status='pending',locked_until=NULL,run_at=now()+interval '1 minute',attempts=0 WHERE id=$1",[job.id]);return;}
  if(!reminderRelevant(job.job_type,c.due_at,now)){await done();return;}
  if(c.artifact_type==='task'){
   if(job.job_type==='monitor'){await done();return;}
   await observeTaskDeadline(db,c,now);
   await queueMessage(db,{userId:user.id,spaceId:user.space_id,contractId:c.id,key:`milestone:${c.id}:${job.job_type}`,
    kind:now.getTime()>=c.due_at.getTime()?'verdict':'reminder',text:taskReminder(c,user.timezone,now,job.job_type==='followup',job.job_type)});
   await done();return;
  }
  const previous=c.last_observed_state;
  const evidence=await this.github.inspect(c);
  const result=await observe(db,c,evidence,now);
  if(result.completed){if(result.newlyCompleted)await victory(db,c,evidence,user.space_id,this.ai);await done();return;}
  // GitHub inspection can cross into the next checkpoint; obsolete alerts should stay quiet.
  const inspectedAt=new Date();
  if(!reminderRelevant(job.job_type,c.due_at,inspectedAt)){await done();return;}
  if(job.job_type.startsWith('before_')){
   await queueMessage(db,{userId:user.id,spaceId:user.space_id,contractId:c.id,key:`milestone:${c.id}:${job.job_type}`,
    kind:'reminder',text:githubDeadlineAlert(c,user.timezone,inspectedAt,evidenceSummary(evidence))});
   await done();return;
  }
  if(job.job_type==='monitor'){
   const changed=blockerFingerprint(previous)!==blockerFingerprint(evidence);
   const failures=evidence.checks.filter(k=>['failure','timed_out','action_required'].includes(k.conclusion??''));
   if(changed&&failures.length&&c.state==='active'){
    const text=await this.ai.generate('blocker',{contract:c,evidence,now:now.toISOString()},c.intensity);
    const digest=createHash('sha256').update(blockerFingerprint(evidence)).digest('hex');
    await queueMessage(db,{userId:user.id,spaceId:user.space_id,contractId:c.id,kind:'reminder',key:`blocker:${c.id}:${evidence.headSha}:${digest}`,text:`${text}\n${evidenceSummary(evidence)}\n${c.artifact_url}`});
   }
   if(now.getTime()<c.due_at.getTime()+86400000){
    await db.query("UPDATE scheduled_jobs SET status='pending',locked_until=NULL,attempts=0,run_at=$2 WHERE id=$1",[job.id,new Date(now.getTime()+this.monitorMs)]);
   }else await done();
   return;
  }
  // A missed notification can be recovered after downtime, but predeadline nags expire.
  const kind=now.getTime()>=c.due_at.getTime()?'verdict':'reminder';
  const text=await this.ai.generate(kind==='verdict'?'missed':job.job_type==='followup'?'recovery':'reminder',{contract:c,evidence,now:now.toISOString(),timezone:user.timezone,milestone:job.job_type},c.intensity);
  await queueMessage(db,{userId:user.id,spaceId:user.space_id,contractId:c.id,key:`milestone:${c.id}:${job.job_type}`,kind,text:`${text}\n${evidenceSummary(evidence)}\n${c.artifact_url}`});
  await done();
 }
 private async retry(table:QueueTable,row:Record<string,unknown>,error:unknown):Promise<void>{
  const attempts=Number(row.attempts); const failed=attempts>=5;
  const status=failed?'failed':'pending';
  const name=safeError(error).name;
  const retryAt=(error as {retryAt?:Date|string}|null)?.retryAt;
  const delay=Math.min(900000,15000*2**Math.min(attempts,6));
  const reset=retryAt?new Date(retryAt).getTime():0;
  const next=new Date(Math.max(Date.now()+delay,Number.isFinite(reset)?reset:0));
  await transaction(this.pool,async db=>{
   await db.query(`UPDATE ${table} SET status=$2,locked_until=NULL,run_at=$3,last_error=$4 WHERE id=$1 AND status='processing'`,[row.id,status,next,name]);
   if(attempts===1&&table==='inbound_messages')await queueMessage(db,{userId:String(row.user_id),spaceId:String(row.space_id),key:`error:${row.id}`,text:'That request didn’t finish.\nNo new action was confirmed. I’ll retry automatically.'});
   if(attempts===1&&table==='scheduled_jobs'){
    const owner=(await db.query<{user_id:string;space_id:string|null;display_id:number;artifact_type:Contract['artifact_type']}>(`SELECT c.user_id,u.space_id,c.display_id,c.artifact_type FROM contracts c JOIN users u ON u.id=c.user_id WHERE c.id=$1 AND c.deleted_at IS NULL`,[row.contract_id])).rows[0];
    if(owner?.space_id)await queueMessage(db,{userId:owner.user_id,spaceId:owner.space_id,contractId:String(row.contract_id),kind:'error',key:`error:${row.id}`,text:scheduledProblemMessage(owner.display_id,owner.artifact_type!=='task')});
   }
   if(failed&&table==='inbound_messages'){
    await queueMessage(db,{userId:String(row.user_id),spaceId:String(row.space_id),key:`failed:${row.id}`,text:'This request still couldn’t be processed after retries.\nNo success is being claimed. Send HELP for commands, or try the request again.'});
   }
  });
 }
}
function blockerFingerprint(e:Evidence|null):string{
 return JSON.stringify(e?.checks.map(k=>[k.name,k.status,k.conclusion]).sort()??[]);
}
