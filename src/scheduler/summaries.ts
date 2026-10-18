import type pg from 'pg';
import type { PoolClient } from 'pg';
import type { Contract } from '../types.js';
import { transaction, lockUser } from '../db/pool.js';
import { getUser, queueMessage } from '../db/queries.js';
import { hourlySummaryMessage } from '../agent/messages.js';

export const HOUR_MS=60*60*1000;

/** The first unfinished task starts the clock; more tasks do not postpone it. */
export async function ensureHourlySummary(db:PoolClient,userId:string,now=new Date()):Promise<void>{
 await db.query(`UPDATE users SET hourly_summary_due_at=COALESCE(hourly_summary_due_at,$2) WHERE id=$1`,
  [userId,new Date(now.getTime()+HOUR_MS)]);
}

export async function stopHourlySummaryIfEmpty(db:PoolClient,userId:string):Promise<void>{
 const cleared=await db.query(`UPDATE users SET hourly_summary_due_at=NULL WHERE id=$1
  AND NOT EXISTS (SELECT 1 FROM contracts WHERE user_id=$1 AND state IN ('pending','active','missed')) RETURNING id`,[userId]);
 if(cleared.rowCount)await suppressOlderSummaries(db,userId);
}

/** Summaries include every unfinished task, including explicitly labelled drafts. */
export async function unfinishedForSummary(db:PoolClient,userId:string):Promise<Contract[]>{
 return (await db.query<Contract>(`SELECT * FROM contracts WHERE user_id=$1 AND state IN ('pending','active','missed')
  ORDER BY due_at,display_id`,[userId])).rows;
}

/** One current check-in after downtime; never replay each missed hour. */
export async function queueDueSummary(pool:pg.Pool,now=new Date()):Promise<void>{
 await transaction(pool,async db=>{
  // Keep the existing lock order: advisory owner lock before users/contract rows.
  const candidate=(await db.query<{id:string}>(`SELECT id FROM users WHERE hourly_summary_due_at<=$1
   ORDER BY hourly_summary_due_at,id LIMIT 1`,[now])).rows[0];
  if(!candidate)return;
  await lockUser(db,candidate.id);
  const user=await getUser(db,candidate.id);
  const due=user.hourly_summary_due_at;
  if(!due||due.getTime()>now.getTime())return;
  const contracts=await unfinishedForSummary(db,user.id);
  if(!contracts.length){
   await db.query('UPDATE users SET hourly_summary_due_at=NULL WHERE id=$1',[user.id]);
   await suppressOlderSummaries(db,user.id);
   return;
  }
  await db.query('UPDATE users SET hourly_summary_due_at=$2 WHERE id=$1',[user.id,new Date(now.getTime()+HOUR_MS)]);
  await suppressOlderSummaries(db,user.id);
  if(user.paused||!user.space_id)return;
  await queueMessage(db,{userId:user.id,spaceId:user.space_id,kind:'summary',
   key:`hourly:${user.id}:${due.toISOString()}`,text:hourlySummaryMessage(contracts,user,now)});
 });
}

async function suppressOlderSummaries(db:PoolClient,userId:string):Promise<void>{
 await db.query(`UPDATE outbox SET status='suppressed',locked_until=NULL
  WHERE user_id=$1 AND kind='summary' AND status IN ('pending','processing')`,[userId]);
}
