import type { PoolClient } from 'pg';
import type { Contract, User } from '../types.js';
export async function getUser(db: PoolClient, id: string): Promise<User> {
 const row = (await db.query<User>('SELECT * FROM users WHERE id=$1 FOR UPDATE',[id])).rows[0];
 if (!row) throw new Error('User missing'); return row;
}
export async function contractsFor(db: PoolClient, userId: string, includeHistory=false): Promise<Contract[]> {
 return (await db.query<Contract>(`SELECT * FROM contracts WHERE user_id=$1 ${includeHistory ? '' : "AND state IN ('pending','active','missed')"}
 ORDER BY CASE WHEN state IN ('pending','active','missed') THEN 0 ELSE 1 END,
 CASE WHEN state IN ('pending','active','missed') THEN display_id END ASC, display_id DESC`,[userId])).rows;
}
/** Explicit commands must still reach finished tasks outside the current board. */
export async function contractByReference(db:PoolClient,userId:string,reference:string):Promise<Contract|undefined>{
 const normalized=reference.replace(/^#/,'').toLowerCase();
 if(/^[1-9]\d*$/.test(normalized)){
  const number=Number(normalized);
  if(!Number.isSafeInteger(number)||number>2147483647)return undefined;
  return (await db.query<Contract>('SELECT * FROM contracts WHERE user_id=$1 AND display_id=$2',[userId,number])).rows[0];
 }
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(normalized))return undefined;
 return (await db.query<Contract>('SELECT * FROM contracts WHERE user_id=$1 AND id=$2',[userId,normalized])).rows[0];
}
export async function queueMessage(db: PoolClient, input: {
 userId: string; spaceId: string; text: string; key: string;
 contractId?: string; kind?: 'reply'|'reminder'|'verdict'|'victory'|'error'|'summary';
}): Promise<void> {
 await db.query(`INSERT INTO outbox(user_id,space_id,message_text,event_key,contract_id,kind,contract_version)
 VALUES($1,$2,$3,$4,$5,$6,(SELECT version FROM contracts WHERE id=$5)) ON CONFLICT(event_key) DO NOTHING`,
 [input.userId,input.spaceId,input.text,input.key,input.contractId ?? null,input.kind ?? 'reply']);
}
export async function historyFor(db: PoolClient, userId: string): Promise<Array<{role:'user'|'assistant';content:string;created_at?:Date}>> {
 return (await db.query<{role:'user'|'assistant';content:string;created_at?:Date}>(`SELECT role,content,created_at FROM
 (SELECT id,role,left(content,2000) AS content,created_at FROM conversation_messages WHERE user_id=$1 ORDER BY id DESC LIMIT 12) t ORDER BY id`,[userId])).rows;
}
export async function recordConversation(db: PoolClient, userId: string, role: string, content: string): Promise<void> {
 await db.query('INSERT INTO conversation_messages(user_id,role,content) VALUES($1,$2,$3)',[userId,role,content.slice(0,4000)]);
 // Keep enough context to clarify pending contracts, without unbounded private chat storage.
 await db.query(`DELETE FROM conversation_messages WHERE user_id=$1 AND id NOT IN
 (SELECT id FROM conversation_messages WHERE user_id=$1 ORDER BY id DESC LIMIT 40)`,[userId]);
}
