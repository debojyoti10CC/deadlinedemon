import type pg from 'pg';
import type { InboundEnvelope, User } from '../types.js';
import { normalizeHandle } from '../config.js';
import { transaction } from '../db/pool.js';
export async function persistInbound(pool:pg.Pool,ownerHandle:string,userId:string,message:InboundEnvelope):Promise<boolean> {
 let sender:string;try{sender=normalizeHandle(message.senderHandle);}catch{return false;}
 if(sender!==normalizeHandle(ownerHandle))return false;
 if(!message.text.trim()||message.text.length>8000||!message.providerMessageId||!message.spaceId)return false;
 return transaction(pool,async db=>{
  const rate=await db.query<{count:string}>("SELECT count(*) FROM inbound_messages WHERE user_id=$1 AND received_at>now()-interval '1 minute'",[userId]);
  if(Number(rate.rows[0]?.count)>20)return false;
  const inserted=await db.query(`INSERT INTO inbound_messages(provider_message_id,user_id,space_id,message_text,received_at)
   VALUES($1,$2,$3,$4,$5) ON CONFLICT(provider_message_id) DO NOTHING RETURNING id`,[message.providerMessageId,userId,message.spaceId,message.text,message.receivedAt]);
  if(inserted.rowCount)await db.query('UPDATE users SET space_id=$2,updated_at=now() WHERE id=$1',[userId,message.spaceId]);
  return !!inserted.rowCount;
 });
}
