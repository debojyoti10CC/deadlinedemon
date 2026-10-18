import type { PoolClient } from 'pg';
import type { Agent, Contract, GitHubReader, Intent, User } from '../types.js';
import { contractByReference, contractsFor, historyFor, queueMessage, recordConversation } from '../db/queries.js';
import { cancelContract, confirmContract, createContract, createTaskContract, observe, observeTaskDeadline, reportTaskComplete, reportTaskProgress, reschedulePendingContract, setIntensity } from '../contracts/service.js';
import { taskSummary } from '../contracts/tasks.js';
import { completion } from '../contracts/verifier.js';
import { formatDeadline, parseDeadline } from '../utils/dates.js';
import { parseGitHubUrl } from '../github/parse-url.js';
import { GENERAL_HELP_REPLY } from './help.js';
import { commandTaskReference, parseCommand } from './commands.js';
import { activatedMessage, boardMessage, cancelledMessage, completionMessage, modeMessage, progressMessage, proposalMessage, publicRef, selectedMessage, statusMessage, taskActionUnavailableMessage } from './messages.js';

export class Orchestrator {
 constructor(private ai: Agent, private github: GitHubReader, private allowedRepos: readonly string[]) {}
 async handle(db: PoolClient,user: User,text: string,spaceId: string,messageId: string): Promise<void> {
  const existing = await contractsFor(db,user.id);
  const reference=commandTaskReference(text)??user.selected_contract_id;
  if(reference&&!existing.some(c=>c.id===reference||String(c.display_id)===reference)){
   const target=await contractByReference(db,user.id,reference);
   if(target&&!existing.some(c=>c.id===target.id))existing.push(target);
  }
  const history = await historyFor(db,user.id);
  const now = new Date();
  const command = parseCommand(text,existing,user.selected_contract_id);
  const intent = command ?? await this.ai.parse(text,{ now:now.toISOString(),timezone:user.timezone,intensity:user.intensity,selected_contract_id:user.selected_contract_id,contracts:existing,history });
  await recordConversation(db,user.id,'user',text);
  const reply = async (message: string,contract?:Contract) => {
   await queueMessage(db,{userId:user.id,spaceId,text:message,key:`inbound:${messageId}`,contractId:contract?.id});
  };
  if (intent.needs_clarification) { await reply(intent.clarification ?? 'Tell me the task and its exact deadline with AM/PM. A GitHub link is optional.'); return; }
  if (intent.intent==='pause' || intent.intent==='resume') {
   const paused=intent.intent==='pause';
   await db.query('UPDATE users SET paused=$2,updated_at=now() WHERE id=$1',[user.id,paused]);
   user.paused=paused;
   await reply(paused ? 'Reminders paused, including hourly check-ins.\nYour tasks are saved. RESUME when you’re ready.' : 'Reminders resumed.\nHourly check-ins are active for unfinished tasks.'); return;
  }
  if (intent.intent==='change_intensity' && intent.intensity) {
   await setIntensity(db,user,intent.intensity);
   await reply(modeMessage(intent.intensity)); return;
  }
  if (intent.intent==='list_contracts') {
   const all=await contractsFor(db,user.id,true);
   const stats=(await db.query<{total:string;completed:string;missed:string}>(`SELECT count(*) FILTER(WHERE confirmed_at IS NOT NULL OR state='completed') AS total,
    count(*) FILTER(WHERE state='completed') AS completed,count(*) FILTER(WHERE missed_at IS NOT NULL) AS missed FROM contracts WHERE user_id=$1`,[user.id])).rows[0]!;
   await reply(boardMessage(all,user,stats)); return;
  }
  if (intent.intent==='select_contract') {
   const selected=existing.find(c=>c.id===intent.contract_id);
   if(!command||command.intent!=='select_contract'||!selected){await reply('Send SELECT followed by the task number from LIST, for example SELECT 1.');return;}
   await db.query('UPDATE users SET selected_contract_id=$2,updated_at=now() WHERE id=$1',[user.id,selected.id]);
   user.selected_contract_id=selected.id;
   await reply(selectedMessage(selected,user),selected);return;
  }
  if(intent.intent==='reschedule_contract'){
   const draft=existing.find(c=>c.id===intent.contract_id);
   if(!command||command.intent!=='reschedule_contract'||!draft||!intent.deadline_local){await reply('Use MOVE with a task number and exact date/time: MOVE 1 YYYY-MM-DD HH:mm.');return;}
   if(draft.state!=='pending'){await reply(`${publicRef(draft)} is already ${draft.state}. MOVE edits pending drafts; send LIST to choose one.`);return;}
   let due:Date;
   try{due=parseDeadline(intent.deadline_local,user.timezone,now);}catch{await reply(`Use a future date and 24-hour time in ${user.timezone}: MOVE ${draft.display_id} YYYY-MM-DD HH:mm.`);return;}
   await reschedulePendingContract(db,draft,due,now);
   await db.query('UPDATE users SET selected_contract_id=$2,updated_at=now() WHERE id=$1',[user.id,draft.id]);
   user.selected_contract_id=draft.id;
   await reply(proposalMessage([draft],user),draft);return;
  }
  if (intent.intent==='create_contract') {
   if (!intent.artifact_url) {
    const proposals=intent.milestones ?? (intent.title&&intent.deadline_local?[{title:intent.title,deadline_local:intent.deadline_local}]:[]);
    if (!proposals.length||proposals.length>5||proposals.some(p=>!p.title.trim())) { await reply('Tell me the task and its exact date and time. You can include up to five tasks or milestones.');return; }
    let deadlines:Date[];
    try{deadlines=proposals.map(p=>parseDeadline(p.deadline_local,user.timezone,now));}
    catch{await reply(`Give each task a future, exact date and time in ${user.timezone}. I have not scheduled anything.`);return;}
    const plans=[...new Map(proposals.map((p,i)=>{const title=p.title.trim().slice(0,200);return [`${title.toLowerCase()}:${deadlines[i]!.toISOString()}`,{title,due:deadlines[i]!}];})).values()];
    const matching=(title:string,due:Date)=>existing.find(c=>c.artifact_type==='task'&&c.state==='pending'&&c.title.trim().toLowerCase()===title.toLowerCase()&&c.due_at.getTime()===due.getTime());
    const newCount=plans.filter(p=>!matching(p.title,p.due)).length;
    if(existing.filter(c=>c.state==='active'||c.state==='pending').length+newCount>10){await reply('Your board has 10 pending or active tasks. Finish or cancel one before adding more.');return;}
    const created:Contract[]=[];
    for(const plan of plans)created.push(matching(plan.title,plan.due)??await createTaskContract(db,user,plan.title,plan.due,intent.intensity??user.intensity));
    user.selected_contract_id=created.length===1?created[0]!.id:null;
    await db.query('UPDATE users SET selected_contract_id=$2,updated_at=now() WHERE id=$1',[user.id,user.selected_contract_id]);
    await reply(proposalMessage(created,user),created.length===1?created[0]:undefined);return;
   }
   if(intent.milestones?.length){await reply('Use one deadline per GitHub target, or send ordinary tasks with separate deadlines.');return;}
   if (!intent.artifact_url || !intent.deadline_local || !intent.title) { await reply('Send the GitHub PR/issue URL and exact deadline, including AM/PM.');return; }
   const source = [text,...history.filter(h=>h.role==='user').map(h=>h.content)].join('\n');
   const suppliedUrls=(source.match(/https?:\/\/[^\s<>]+/g)??[]).map(url=>url.replace(/[.,)\]}]+$/g,''));
   if (!suppliedUrls.includes(intent.artifact_url)) { await reply('Paste the exact GitHub PR or issue URL to authorize a contract.');return; }
   if (!this.allowedRepos.length) { await reply('GitHub verification is not configured. Ordinary tasks work without it; add a read-only token and exact repository allowlist to enable GitHub commitments.');return; }
   if (existing.filter(c=>c.state==='active'||c.state==='pending').length>=10) { await reply('You have 10 pending or active contracts. Complete or cancel one before adding another.');return; }
   let ref; let due;
   try { ref=parseGitHubUrl(intent.artifact_url,this.allowedRepos); due=parseDeadline(intent.deadline_local,user.timezone,now); }
   catch { await reply('I need an allowed GitHub PR/issue URL and a future, unambiguous deadline in your stored timezone. Send YYYY-MM-DD HH:mm or a time with AM/PM.'); return; }
   const evidence=await this.github.inspect(ref);
   const proof=completion(evidence);
   if (proof.complete) { await reply(`${proof.description}. This artifact is already complete; send a different commitment.\n${ref.artifact_url}`);return; }
   const c=await createContract(db,user,ref,intent.title.slice(0,200),due,intent.intensity??user.intensity,evidence);
   await db.query('UPDATE users SET selected_contract_id=$2,updated_at=now() WHERE id=$1',[user.id,c.id]);
   user.selected_contract_id=c.id;
   await reply(proposalMessage([c],user),c); return;
  }
  if (intent.intent==='unknown') { await reply(GENERAL_HELP_REPLY);return; }
  const unfinished=existing.filter(c=>['pending','active','missed'].includes(c.state));
  const pending=unfinished.filter(c=>c.state==='pending');
  const candidates=intent.intent==='confirm_contract'&&pending.length?pending:unfinished;
  if(intent.intent==='confirm_contract'||intent.intent==='cancel_contract'){
   const expected=intent.intent==='confirm_contract'?'CONFIRM':'CANCEL';
   if(!command||command.intent!==intent.intent||command.contract_id!==intent.contract_id){
    await reply(`Send ${expected} followed by the task number, for example ${expected} 1.`);return;
   }
  }
  const targetId=intent.contract_id??user.selected_contract_id;
  const c=targetId?existing.find(task=>task.id===targetId):selectContract(candidates,intent);
  if (!c) {
   if(targetId){await reply('I couldn’t find that task. Send LIST to see your task numbers.');return;}
   const action=intent.intent==='confirm_contract'?'CONFIRM':intent.intent==='cancel_contract'?'CANCEL':intent.intent==='report_progress'?'PROGRESS':intent.intent==='verify_completion'?'DONE':intent.intent==='request_rescue'?'RESCUE':'STATUS';
   await reply(candidates.length ? `Which task?\n${candidates.map(task=>`${publicRef(task)} · ${task.title.slice(0,70)}`).join('\n')}\n\nReply ${action} ${candidates[0]!.display_id}${action==='PROGRESS'?' 50%':''}.` : 'No unfinished tasks for that command. Send LIST to view your board.');return;
  }
  if(c.state==='completed'||c.state==='cancelled'){
   const done=command?.intent==='verify_completion'&&/^DONE(?:\s|$)/i.test(text.trim());
   await reply(done&&c.state==='completed'&&c.artifact_type==='task'?completionMessage(c,user,true)
    : intent.intent==='get_status'?statusMessage(c,user):taskActionUnavailableMessage(c,user,text.trim().split(/\s/)[0]!.toUpperCase()),c);return;
  }
  if (intent.intent==='cancel_contract') {
   await cancelContract(db,c);
   if(user.selected_contract_id===c.id){await db.query('UPDATE users SET selected_contract_id=NULL,updated_at=now() WHERE id=$1',[user.id]);user.selected_contract_id=null;}
   await reply(cancelledMessage(c,user),c);return;
  }
  if (intent.intent==='confirm_contract') {
   if(c.state!=='pending'){await reply(taskActionUnavailableMessage(c,user,'CONFIRM'),c);return;}
   if(c.due_at.getTime()<=now.getTime()){await reply(`${publicRef(c)}'s deadline has passed. Update it with MOVE ${c.display_id} YYYY-MM-DD HH:mm in ${user.timezone}, then CONFIRM ${c.display_id}.`);return;}
   if(c.artifact_type!=='task'){
    const e=await this.github.inspect(c);
    if(completion(e).complete){await reply(`${completion(e).description}. I will not activate an already completed target.`,c);return;}
   }
   if(c.due_at.getTime()<=Date.now()){await reply(`That deadline passed while checking GitHub.\nUpdate this draft with MOVE ${c.display_id} YYYY-MM-DD HH:mm in ${user.timezone}, then CONFIRM ${c.display_id}.`);return;}
   await confirmContract(db,c,new Date());
   await reply(activatedMessage(c,user),c);return;
  }
  if(intent.intent==='report_progress'){
   if(!command||command.intent!=='report_progress'||command.progress_percent!==intent.progress_percent||!Number.isInteger(intent.progress_percent)){await reply('Send PROGRESS with the task number and a whole percentage, for example PROGRESS 1 40.');return;}
   if(c.artifact_type!=='task'){await reply('HP tracks progress you report for ordinary tasks. This target uses GitHub verification.');return;}
   await reportTaskProgress(db,c,intent.progress_percent!,now);
   await reply(intent.progress_percent===100?completionMessage(c,user):progressMessage(c,user),c);return;
  }
  if(c.artifact_type==='task'){
   if(intent.intent==='verify_completion'){
    if(command?.intent==='verify_completion'&&/^DONE(?:\s|$)/i.test(text.trim())){
     await reportTaskComplete(db,c,now);await reply(completionMessage(c,user),c);return;
    }
   }
   await observeTaskDeadline(db,c,now);
   const summary=taskSummary(c,user.timezone);
   if(intent.intent==='request_rescue'){
    const advice=await this.ai.generate('task_rescue',{contract:c,tracking:'owner_reported',userText:text,now:now.toISOString(),timezone:user.timezone},c.intensity);
    await reply(`${advice}\n${summary}`,c);
   }else await reply(statusMessage(c,user),c);
   return;
  }
  if(c.state==='pending'&&intent.intent==='verify_completion'){
   await reply(taskActionUnavailableMessage(c,user,'DONE'),c);return;
  }
  const detailed=intent.intent==='request_rescue';
  const evidence=await this.github.inspect(c,detailed);
  const observed=await observe(db,c,evidence,now);
  const event=observed.completed?'victory':detailed?'rescue':intent.intent==='verify_completion'?'proof_rejected':observed.missed?'missed':'status';
  const generated=await this.ai.generate(event,{contract:c,evidence,now:now.toISOString(),timezone:user.timezone,userText:text,deadline:formatDeadline(c.due_at,user.timezone),late:observed.missed},c.intensity);
  await reply(`${generated}\n${evidenceSummary(evidence)}\n${c.artifact_url}`,c);
 }
}
export function selectContract(contracts: Contract[],intent: Pick<Intent,'intent'|'contract_id'>,selectedId?:string|null): Contract|undefined {
 if(intent.contract_id)return contracts.find(c=>c.id===intent.contract_id);
 if(selectedId)return contracts.find(c=>c.id===selectedId);
 if(intent.intent==='request_rescue')return [...contracts].sort((a,b)=>a.due_at.getTime()-b.due_at.getTime())[0];
 return contracts.length===1?contracts[0]:undefined;
}
export function summaries(contracts:Contract[],user:User):string { return boardMessage(contracts,user); }
export function evidenceSummary(e: import('../types.js').Evidence):string {
 const proof=completion(e);
 const failed=e.checks.filter(c=>['failure','timed_out','cancelled','action_required','startup_failure','stale'].includes(c.conclusion??''));
 return `${proof.description}. Observed ${e.observedAt}.${failed.length?` Failing checks: ${failed.map(c=>`${c.name}${c.url?` (${c.url})`:''}`).join(', ')}.`:''}${e.limitations.length?` Limits: ${e.limitations.join('; ')}`:''}`;
}
