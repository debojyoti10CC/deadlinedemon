import 'dotenv/config';
import { createPool,transaction } from '../src/db/pool.js';
import { normalizeHandle } from '../src/config.js';
if(!process.argv.includes('--confirm-delete-owner'))throw new Error('Stop the app, then pass --confirm-delete-owner to delete owner contracts, history and evidence permanently.');
if(!process.env.DATABASE_URL||!process.env.ADMIN_IMESSAGE_HANDLE)throw new Error('DATABASE_URL and ADMIN_IMESSAGE_HANDLE are required');
const pool=createPool(process.env.DATABASE_URL);
try{await transaction(pool,async db=>{await db.query('DELETE FROM users WHERE imessage_handle=$1',[normalizeHandle(process.env.ADMIN_IMESSAGE_HANDLE!)]);});console.log('Configured owner data deleted.');}
finally{await pool.end();}
