import type { PoolClient } from 'pg';
import type { ArtifactRef, Contract, Evidence, GitHubContract, TaskContract, Intensity, User } from '../types.js';
import { assertTransition } from './state-machine.js';
import { completion } from './verifier.js';
import { reminderSchedule } from './reminders.js';
import { ensureHourlySummary, stopHourlySummaryIfEmpty } from '../scheduler/summaries.js';

export async function createContract(db: PoolClient, user: User, ref: ArtifactRef, title: string, due: Date, intensity: Intensity, evidence: Evidence): Promise<GitHubContract> {
 assertEvidence(ref,evidence);
 if (completion(evidence).complete) throw new Error('Artifact is already complete');
 const c = (await db.query<GitHubContract>(`INSERT INTO contracts(user_id,title,repo_owner,repo_name,artifact_type,artifact_number,artifact_url,due_at,intensity,last_checked_at,last_observed_state)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now(),$10) RETURNING *`,
 [user.id,title,ref.repo_owner,ref.repo_name,ref.artifact_type,ref.artifact_number,ref.artifact_url,due,intensity,JSON.stringify(evidence)])).rows[0]!;
 await event(db,c,'created',evidence);
 await ensureHourlySummary(db,user.id); return c;
}
export async function createTaskContract(db: PoolClient,user: User,title: string,due: Date,intensity: Intensity):Promise<TaskContract> {
 if(!title.trim()||!Number.isFinite(due.getTime()))throw new Error('A task needs a title and valid deadline');
 const c=(await db.query<TaskContract>(`INSERT INTO contracts(user_id,title,artifact_type,due_at,intensity)
 VALUES($1,$2,'task',$3,$4) RETURNING *`,[user.id,title,due,intensity])).rows[0]!;
 await event(db,c,'created',{tracking:'owner_reported',dueAt:due.toISOString()});
 await ensureHourlySummary(db,user.id);return c;
}
export async function confirmContract(db: PoolClient, c: Contract, now: Date): Promise<void> {
 assertTransition(c.state,'active');
 const schedule = reminderSchedule(now,c.due_at);
 await db.query("UPDATE contracts SET state='active',confirmed_at=$2,version=version+1 WHERE id=$1",[c.id,now]);
 for (const m of schedule) await db.query(`INSERT INTO scheduled_jobs(contract_id,job_type,run_at) VALUES($1,$2,$3) ON CONFLICT(contract_id,job_type) DO NOTHING`,[c.id,m.job_type,m.run_at]);
 // Low-frequency proof monitoring detects merges/blockers between deadline milestones.
 if(c.artifact_type!=='task')await db.query(`INSERT INTO scheduled_jobs(contract_id,job_type,run_at) VALUES($1,'monitor',$2) ON CONFLICT DO NOTHING`,[c.id,new Date(Math.min(now.getTime()+300000,c.due_at.getTime()))]);
 await event(db,c,'confirmed',{dueAt:c.due_at.toISOString()});
 c.state='active';c.confirmed_at=now;c.version+=1;
}
export async function cancelContract(db: PoolClient,c: Contract): Promise<void> {
 assertTransition(c.state,'cancelled');
 await db.query("UPDATE contracts SET state='cancelled',version=version+1 WHERE id=$1",[c.id]);
 await stopJobs(db,c.id); await event(db,c,'cancelled',{});
 c.state='cancelled';c.version+=1;
}
export async function reschedulePendingContract(db:PoolClient,c:Contract,due:Date,now=new Date()):Promise<void>{
 if(c.state!=='pending')throw new Error('Only a pending task deadline can be moved');
 if(!Number.isFinite(due.getTime())||due.getTime()<=now.getTime())throw new Error('The new deadline must be in the future');
 const previous=c.due_at;
 await db.query("UPDATE contracts SET due_at=$2,version=version+1 WHERE id=$1 AND state='pending'",[c.id,due]);
 await event(db,c,'deadline_changed',{from:previous.toISOString(),to:due.toISOString(),source:'owner_command'});
 c.due_at=due;c.version+=1;
}
export async function observe(db: PoolClient,c: Contract,e: Evidence,now=new Date()): Promise<{ completed: boolean; newlyCompleted: boolean; missed: boolean }> {
 if(c.artifact_type==='task')throw new Error('Ordinary tasks do not have GitHub evidence');
 assertEvidence(c,e);
 const proof = completion(e);
 await db.query(`UPDATE contracts SET last_checked_at=$2,last_observed_state=$3,
 version=version+CASE WHEN (last_observed_state - 'observedAt') IS DISTINCT FROM ($3::jsonb - 'observedAt') THEN 1 ELSE 0 END WHERE id=$1`,[c.id,new Date(e.observedAt),JSON.stringify(e)]);
 await event(db,c,'observed',e);
 if (!['active','missed'].includes(c.state)) return {completed:c.state==='completed',newlyCompleted:false,missed:!!c.missed_at};
 if (proof.complete && proof.at) {
   assertTransition(c.state,'completed');
   const late = proof.at.getTime()>c.due_at.getTime();
   await db.query(`UPDATE contracts SET state='completed',completed_at=$2,missed_at=CASE WHEN $3 THEN due_at ELSE NULL END,version=version+1 WHERE id=$1`,[c.id,proof.at,late]);
   await stopJobs(db,c.id); await event(db,c,'completed',e);
   c.state='completed'; c.completed_at=proof.at; c.missed_at=late?c.due_at:null;
   return {completed:true,newlyCompleted:true,missed:!!c.missed_at};
 }
 if (now.getTime()>=c.due_at.getTime() && c.state==='active') {
   assertTransition(c.state,'missed');
   await db.query("UPDATE contracts SET state='missed',missed_at=due_at,version=version+1 WHERE id=$1",[c.id]);
   await event(db,c,'missed',e); c.state='missed'; c.missed_at=c.due_at;
 }
 return {completed:false,newlyCompleted:false,missed:!!c.missed_at};
}
export async function reportTaskComplete(db:PoolClient,c:TaskContract,now=new Date()):Promise<void>{
 if(c.artifact_type!=='task')throw new Error('Only ordinary tasks can be completed by owner report');
 if(c.state==='completed')return;
 // A draft is already owner-authored work: reporting it done does not activate reminders.
 if(c.state!=='pending')assertTransition(c.state,'completed');
 const late=now.getTime()>c.due_at.getTime();
 await db.query("UPDATE contracts SET state='completed',progress_percent=100,completed_at=$2,missed_at=CASE WHEN $3 THEN due_at ELSE NULL END,version=version+1 WHERE id=$1",[c.id,now,late]);
 await stopJobs(db,c.id);
 await event(db,c,'completed_self_reported',{source:'owner_reported',reportedAt:now.toISOString(),late});
 c.state='completed';c.progress_percent=100;c.completed_at=now;c.missed_at=late?c.due_at:null;c.version+=1;
}
export async function reportTaskProgress(db:PoolClient,c:TaskContract,percent:number,now=new Date()):Promise<void>{
 if(!Number.isInteger(percent)||percent<0||percent>100)throw new Error('Task progress must be a whole number from 0 to 100');
 if(c.artifact_type!=='task'||!['pending','active','missed'].includes(c.state))throw new Error('Progress can only be reported for a pending, active or missed ordinary task');
 if(percent===100){await reportTaskComplete(db,c,now);return;}
 const previousPercent=c.progress_percent;
 await db.query('UPDATE contracts SET progress_percent=$2,version=version+1 WHERE id=$1',[c.id,percent]);
 await event(db,c,'progress_self_reported',{source:'owner_reported',previousPercent,progressPercent:percent,reportedAt:now.toISOString()});
 c.progress_percent=percent;c.version+=1;
}
export async function setIntensity(db:PoolClient,user:User,intensity:Intensity):Promise<void>{
 if(!['mild','savage','nuclear'].includes(intensity))throw new Error('Invalid intensity');
 await db.query('UPDATE users SET intensity=$2,updated_at=now() WHERE id=$1',[user.id,intensity]);
 const changed=(await db.query<Contract&{previous_intensity:Intensity}>(`WITH previous AS (
 SELECT id,intensity FROM contracts WHERE user_id=$1 AND state IN ('pending','active','missed') AND intensity<>$2 FOR UPDATE
 ) UPDATE contracts AS c SET intensity=$2,version=c.version+1 FROM previous WHERE c.id=previous.id
 RETURNING c.*,previous.intensity AS previous_intensity`,[user.id,intensity])).rows;
 for(const c of changed)await event(db,c,'intensity_changed',{from:c.previous_intensity,to:intensity});
 user.intensity=intensity;
}
export async function observeTaskDeadline(db:PoolClient,c:TaskContract,now=new Date()):Promise<void>{
 if(c.state!=='active'||now.getTime()<c.due_at.getTime())return;
 await db.query("UPDATE contracts SET state='missed',missed_at=due_at,version=version+1 WHERE id=$1",[c.id]);
 await event(db,c,'deadline_unconfirmed',{source:'owner_reported',observedAt:now.toISOString()});
 c.state='missed';c.missed_at=c.due_at;
}
async function stopJobs(db: PoolClient,id:string): Promise<void> {
 await db.query("UPDATE scheduled_jobs SET status='done',locked_until=NULL WHERE contract_id=$1 AND status IN ('pending','processing')",[id]);
 await db.query("UPDATE outbox SET status='suppressed',locked_until=NULL WHERE contract_id=$1 AND kind IN ('reminder','verdict','error') AND status IN ('pending','processing')",[id]);
 const owner=(await db.query<{user_id:string}>('SELECT user_id FROM contracts WHERE id=$1',[id])).rows[0];
 if(owner)await stopHourlySummaryIfEmpty(db,owner.user_id);
}
export async function event(db: PoolClient,c:Contract,type:string,e:unknown):Promise<void> {
 await db.query('INSERT INTO contract_events(contract_id,event_type,evidence_url,evidence) VALUES($1,$2,$3,$4)',[c.id,type,c.artifact_url,JSON.stringify(e)]);
}
function assertEvidence(ref:ArtifactRef,e:Evidence):void {
 if(ref.repo_owner.toLowerCase()!==e.artifact.repo_owner.toLowerCase()||ref.repo_name.toLowerCase()!==e.artifact.repo_name.toLowerCase()||ref.artifact_type!==e.artifact.artifact_type||ref.artifact_number!==e.artifact.artifact_number||ref.artifact_url.toLowerCase()!==e.artifact.artifact_url.toLowerCase())throw new Error('GitHub evidence does not match contract target');
}
