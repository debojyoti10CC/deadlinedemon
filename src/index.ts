import { createServer } from 'node:http';
import { readConfig,normalizeHandle } from './config.js';
import { logger } from './utils/logger.js';
import { safeError } from './utils/errors.js';
import { createPool } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { OpenAIAgent } from './agent/intents.js';
import { Orchestrator } from './agent/orchestrator.js';
import { createGitHubReader } from './github/index.js';
import { createPhotonTransport } from './photon/client.js';
import { persistInbound } from './photon/inbound.js';
import { Worker } from './scheduler/worker.js';
import type { User } from './types.js';

async function main():Promise<void>{
 const config=readConfig();
 const handle=normalizeHandle(config.ADMIN_IMESSAGE_HANDLE);
 const pool=createPool(config.DATABASE_URL);
 let shuttingDown=false;
 let transport:Awaited<ReturnType<typeof createPhotonTransport>>|undefined;
 let worker:Worker|undefined;
 const server=createServer(async(req,res)=>{
  if(req.url!=='/healthz'&&req.url!=='/readyz'){res.writeHead(404).end();return;}
  let database=false; try{await pool.query('SELECT 1');database=true;}catch{}
  const workerFresh=!!worker?.lastTickAt&&Date.now()-worker.lastTickAt.getTime()<Math.max(180000,config.WORKER_INTERVAL_MS*4);
  const ready=!shuttingDown&&database&&!!transport?.isReady()&&workerFresh;
  res.writeHead(ready?200:503,{'content-type':'application/json','cache-control':'no-store'});
  res.end(JSON.stringify({ready,database,photon:!!transport?.isReady(),worker:workerFresh,
   // Consumer startup and outbound delivery do not establish that an inbound
   // message has reached us. Expose safe receipt metadata separately.
   photonDiagnostics:transport?.diagnostics()??null}));
 });
 const shutdown=async()=>{
  if(shuttingDown)return;shuttingDown=true;logger.info('Graceful shutdown started');
  const deadline=setTimeout(()=>process.exit(1),45000);deadline.unref();
  server.close();
  try{await transport?.stop();await worker?.stop();await pool.end();}
  catch(error){logger.error({error:safeError(error)},'Shutdown failed');process.exitCode=1;}
  finally{clearTimeout(deadline);}
 };
 try{
  await migrate(pool);
  const user=(await pool.query<User>(`INSERT INTO users(imessage_handle,timezone) VALUES($1,$2)
   ON CONFLICT(imessage_handle) DO UPDATE SET updated_at=now() RETURNING *`,[handle,config.DEFAULT_TIMEZONE])).rows[0]!;
  const repos=config.GITHUB_ALLOWED_REPOS?.split(',').map(s=>s.trim())??[];
  const github=createGitHubReader(config.GITHUB_TOKEN,repos);
  const ai=new OpenAIAgent(config.OPENAI_API_KEY,config.OPENAI_MODEL);
  const router=new Orchestrator(ai,github,repos);
  transport=await createPhotonTransport({projectId:config.SPECTRUM_PROJECT_ID,projectSecret:config.SPECTRUM_PROJECT_SECRET,ownerHandle:handle,servingPhone:config.SPECTRUM_IMESSAGE_PHONE||undefined},async message=>{
   if(await persistInbound(pool,handle,user.id,message))worker?.wakeNow();
  },logger);
  worker=new Worker(pool,router,github,ai,transport,logger,config.WORKER_INTERVAL_MS,config.GITHUB_POLL_INTERVAL_MS);
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(config.PORT,'0.0.0.0',resolve);});
  process.once('SIGTERM',()=>{void shutdown();});process.once('SIGINT',()=>{void shutdown();});
  const consumer=transport.run(); const jobs=worker.start();
  logger.info({port:config.PORT},'Deadline Demon started; use /readyz for current readiness');
  await Promise.race([consumer,jobs]);
  if(!shuttingDown){logger.error('A persistent runtime loop stopped unexpectedly');process.exitCode=1;await shutdown();}
 }catch(error){logger.error({error:safeError(error)},'Startup or runtime failed; no integration success claimed');process.exitCode=1;await shutdown();}
}
await main();
