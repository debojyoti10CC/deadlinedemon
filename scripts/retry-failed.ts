import 'dotenv/config';
import {createPool,transaction} from '../src/db/pool.js';
if(!process.argv.includes('--retry'))throw new Error('Fix integration credentials/access first, then pass --retry. Retried messages may consume quota.');
if(!process.env.DATABASE_URL)throw new Error('DATABASE_URL is required');
const pool=createPool(process.env.DATABASE_URL);
try{await transaction(pool,async db=>{
 for(const table of ['inbound_messages','scheduled_jobs','outbox']){
  const result=await db.query(`UPDATE ${table} SET status='pending',attempts=0,run_at=now(),locked_until=NULL WHERE status='failed'`);
  console.log(`${table}: ${result.rowCount} failed records requeued.`);
 }
});}finally{await pool.end();}
