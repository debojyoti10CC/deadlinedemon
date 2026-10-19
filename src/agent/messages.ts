import type { Contract, Intensity, User } from '../types.js';
import { taskActions, taskCard } from '../contracts/tasks.js';
import { deadlineText, displayTitle, hpLine, publicRef, remainingTime, taskState } from './presentation.js';

export { publicRef } from './presentation.js';

function paragraphs(...parts:Array<string|undefined>):string { return parts.filter(Boolean).join('\n\n'); }
function unfinished(c:Contract):boolean { return !c.deleted_at&&['pending','active','missed'].includes(c.state); }
function paused(user:User):string { return user.paused?'Reminders paused · RESUME to restart.':''; }
function githubTarget(c:Contract):string {
 return c.artifact_type==='task'?'':`GitHub ${c.artifact_type==='pull_request'?'PR':'issue'} ${c.repo_owner}/${c.repo_name}#${c.artifact_number}`;
}
function cachedObservation(c:Contract,user:User):string {
 if(c.artifact_type==='task')return '';
 const evidence=c.last_observed_state;
 if(!evidence)return 'GitHub evidence: not checked yet';
 const observed=new Date(evidence.observedAt);
 const timestamp=Number.isFinite(observed.getTime())?`\nObserved ${deadlineText(observed,user.timezone)}`:'';
 return `Last GitHub observation: ${evidence.state}${timestamp}`;
}
function card(c:Contract,user:User,now:Date,includeReference=true):string {
 if(c.artifact_type==='task')return taskCard(c,user.timezone,now,includeReference);
 if(c.deleted_at)return [includeReference?`${publicRef(c)} · ${displayTitle(c,100)}`:displayTitle(c,100),taskState(c,now),'Task reminders stopped.'].join('\n');
 return [includeReference?`${publicRef(c)} · ${displayTitle(c,100)}`:displayTitle(c,100),
  taskState(c,now),`Due: ${deadlineText(c.due_at,user.timezone)} (${user.timezone})`,
  unfinished(c)?remainingTime(c.due_at,now):'',githubTarget(c),cachedObservation(c,user),c.artifact_url].filter(Boolean).join('\n');
}
function nextStep(c:Contract,now:Date):string {
 if(c.deleted_at)return 'LIST to see your remaining tasks.';
 if(c.artifact_type==='task')return unfinished(c)?taskActions(c,now):['LIST to see your other tasks.',taskActions(c,now)].filter(Boolean).join('\n');
 if(!unfinished(c))return `LIST to see your other tasks.\nRemove from board: DELETE ${c.display_id}`;
 if(c.state==='pending')return c.due_at.getTime()<=now.getTime()
  ? `New deadline: MOVE ${c.display_id} YYYY-MM-DD HH:mm\nThen CONFIRM ${c.display_id} to start checks · DELETE ${c.display_id} to remove`
  : `CONFIRM ${c.display_id} to start checks.\nRemove from board: DELETE ${c.display_id}`;
 return `STATUS ${c.display_id} · RESCUE ${c.display_id}\nRemove from board: DELETE ${c.display_id}`;
}
function compactCard(c:Contract,user:User,now:Date,selected=false):string {
 let state=taskState(c,now);
 if(c.state==='active'&&c.due_at.getTime()>now.getTime())state+=` · ${remainingTime(c.due_at,now)}`;
 return [`${publicRef(c)} · ${displayTitle(c,62)}${selected?' [selected]':''}`,state,
  `Due: ${deadlineText(c.due_at,user.timezone)}`,
  c.artifact_type==='task'?hpLine(c,true):githubTarget(c)].join('\n');
}
function hpMeaning(contracts:Contract[]):string {
 return contracts.some(c=>c.artifact_type==='task')?'HP = progress you report.':'';
}

export function proposalMessage(contracts:Contract[],user:User,now=new Date()):string {
 contracts=contracts.filter(c=>!c.deleted_at);
 if(!contracts.length)return 'Send a task and an exact deadline to get started.';
 const shown=contracts.slice(0,5);
 const cards=shown.map(c=>[`${publicRef(c)} · ${displayTitle(c,62)}`,
  `Due: ${deadlineText(c.due_at,user.timezone)} · ${c.intensity.toUpperCase()}`,
  c.artifact_type==='task'?hpLine(c,true):githubTarget(c),
  c.due_at.getTime()<=now.getTime()?`Deadline passed · STATUS ${c.display_id} for options`:`Reply CONFIRM ${c.display_id} · DELETE ${c.display_id} to remove`].join('\n'));
 const ordinary=shown.find(c=>c.artifact_type==='task');
 const guidance=ordinary?`Already finished? DONE ${ordinary.display_id}`:'';
 return paragraphs(`Saved as ${shown.length===1?'a draft':'drafts'}\nDeadlines in ${user.timezone}`,
  cards.join('\n\n'),['Reminders start after confirmation.',hpMeaning(shown),guidance].filter(Boolean).join('\n'),paused(user));
}

export function selectedMessage(c:Contract,user:User,now=new Date()):string {
 if(c.deleted_at)return deletedMessage(c,user,true,now);
 const guidance=nextStep(c,now)||'LIST to see your other tasks.';
 return paragraphs(`Selected ${publicRef(c)}`,card(c,user,now,false),guidance,paused(user));
}

/** Viewing task details never changes numberless command selection. */
export function statusMessage(c:Contract,user:User,now=new Date()):string {
 if(c.deleted_at)return deletedMessage(c,user,true,now);
 return paragraphs('Task details',card(c,user,now),nextStep(c,now)||'LIST to see your other tasks.',paused(user));
}

export function activatedMessage(c:Contract,user:User,now=new Date()):string {
 if(c.deleted_at)return deletedMessage(c,user,true,now);
 const active={...c,state:'active' as const};
 return paragraphs(`Task activated · ${c.intensity.toUpperCase()}`,card(active,user,now),
  c.artifact_type==='task'?nextStep(active,now):`GitHub evidence checks scheduled.\nSTATUS ${c.display_id} · RESCUE ${c.display_id} · DELETE ${c.display_id}`,paused(user));
}

export function boardMessage(contracts:Contract[],user:User,stats?:{total:string;completed:string;missed:string},now=new Date()):string {
 contracts=contracts.filter(c=>!c.deleted_at);
 const heat=`Mode: ${user.intensity.toUpperCase()}`;
 const current=contracts.filter(unfinished);
 const history=contracts.filter(c=>!unfinished(c)).slice().sort((a,b)=>(b.completed_at??b.created_at).getTime()-(a.completed_at??a.created_at).getTime());
 const heading=`Task overview${user.paused?' · PAUSED':''}\n${heat} · ${user.timezone}\n${current.length} unfinished`;
 if(!contracts.length)return paragraphs(heading,'No tasks yet. Send any task and an exact deadline.',paused(user));
 const rows=current.map(c=>compactCard(c,user,now,c.id===user.selected_contract_id));
 const recent=history.slice(0,3).map(c=>`${publicRef(c)} · ${displayTitle(c,56)}${c.id===user.selected_contract_id?' [selected]':''}\n${taskState(c,now)}`).join('\n\n');
 const historyText=recent?`Recent history\n${recent}${history.length>3?`\n+ ${history.length-3} older tasks in history`:''}`:'';
 const totals=stats?`History: ${stats.completed}/${stats.total} completed · ${stats.missed} deadlines passed`:'';
 const focus=current.find(c=>c.id===user.selected_contract_id)??current[0];
 const selected=contracts.find(c=>c.id===user.selected_contract_id);
 const guidance=focus?selected&&!unfinished(selected)
  ? `Selected ${publicRef(selected)} is ${selected.state}. SELECT ${focus.display_id} to switch.`
  : `Details: STATUS ${focus.display_id} · HELP for commands.`
  : 'Send a new task + deadline whenever you’re ready.';
 return paragraphs(heading,rows.join('\n\n'),historyText,[totals,hpMeaning(current)].filter(Boolean).join('\n'),
  guidance,paused(user));
}

/** Snapshot only: reported HP and timestamped cached GitHub facts. No integration calls. */
export function hourlySummaryMessage(contracts:Contract[],user:User,now=new Date()):string {
 const current=contracts.filter(unfinished).slice().sort((a,b)=>a.display_id-b.display_id);
 const voice={mild:'Review your progress and choose the next manageable step.',savage:'Review outstanding work and record a progress update.',nuclear:'Deadline review: update the status of each outstanding task.'}[user.intensity];
 const heading=`Hourly check-in · ${user.intensity.toUpperCase()}\n${voice}\n${current.length} unfinished · ${user.timezone}`;
 if(!current.length)return paragraphs(heading,'No unfinished tasks.');
 const cards=current.map(c=>[compactCard(c,user,now),c.artifact_type!=='task'?cachedObservation(c,user):''].filter(Boolean).join('\n'));
 const focus=current.find(c=>c.id===user.selected_contract_id&&c.artifact_type==='task')
  ??current.find(c=>c.artifact_type==='task'&&c.state!=='pending')??current.find(c=>c.artifact_type==='task');
 const draft=current.find(c=>c.state==='pending'&&c.due_at.getTime()>now.getTime());
 const expired=current.find(c=>c.state==='pending'&&c.due_at.getTime()<=now.getTime());
 const guidance=[focus?`Update: PROGRESS ${focus.display_id} 50 · DONE ${focus.display_id}`:'',
  draft?`Start a draft: CONFIRM ${draft.display_id}`:expired?`Update an expired draft: MOVE ${expired.display_id} YYYY-MM-DD HH:mm`:''].filter(Boolean).join('\n');
 return paragraphs(heading,cards.join('\n\n'),hpMeaning(current),guidance,paused(user));
}

export function modeMessage(intensity:Intensity):string {
 const modes={mild:['MILD selected','Supportive guidance and manageable next steps.','“Review your progress and choose one practical next step.”'],
  savage:['SAVAGE selected','Direct accountability and concise progress checks.','“Review the outstanding work and record your next action.”'],
  nuclear:['NUCLEAR selected','Firm deadline focus and explicit priorities.','“Prioritize the nearest deadline and update its status.”']} as const;
 const [heading,description,preview]=modes[intensity];
 return paragraphs(`${heading}\n${description}`,`Voice preview\n${preview}`,'Applies to current and new tasks.\nMILD · SAVAGE · NUCLEAR');
}

export function progressMessage(c:Contract,user:User,now=new Date()):string {
 if(c.deleted_at)return deletedMessage(c,user,true,now);
 if(c.artifact_type!=='task')return paragraphs(`${publicRef(c)} uses GitHub evidence.`,
  `HP is only for self-reported tasks.\nSTATUS ${c.display_id} to check it.`);
 if(c.state==='completed')return completionMessage(c,user,false,now);
 const next=c.state==='pending'?c.due_at.getTime()>now.getTime()
  ? `CONFIRM ${c.display_id} to start reminders.\nAlready finished? DONE ${c.display_id}`
  : `Already finished? DONE ${c.display_id}\nNew deadline: MOVE ${c.display_id} YYYY-MM-DD HH:mm`
  : `Completion: DONE ${c.display_id} · Recovery plan: RESCUE ${c.display_id}`;
 return paragraphs(`Progress recorded · ${publicRef(c)}`,card(c,user,now,false),next,paused(user));
}

export function completionMessage(c:Contract,user:User,already=false,now=new Date()):string {
 if(c.deleted_at)return deletedMessage(c,user,true,now);
 const voice={mild:'Thank you for the update.',savage:'Proceed to your next priority.',nuclear:'Review your remaining commitments.'}[c.intensity];
 return paragraphs(`${already?'Already completed':'Completion recorded'} · ${publicRef(c)}`,card(c,user,now,false),
  already?'LIST to see your remaining tasks.':`No more reminders for this task.\n${voice}`);
}

/** Explain that exact target's state without redirecting the requested action. */
export function taskActionUnavailableMessage(c:Contract,user:User,action:string,now=new Date()):string {
 if(c.deleted_at)return deletedMessage(c,user,true,now);
 if(c.state==='completed')return completionMessage(c,user,true,now);
 if(c.state==='cancelled')return paragraphs(`${publicRef(c)} is cancelled`,card(c,user,now,false),'Send a new task + deadline to track it again.');
 if(c.artifact_type!=='task'&&c.state==='pending')return paragraphs(`${publicRef(c)} is still a draft`,
  /progress/i.test(action)?'HP updates are for ordinary tasks. This one follows GitHub evidence.':'This GitHub draft hasn’t started monitoring.',
  card(c,user,now,false),nextStep(c,now),paused(user));
 if(c.artifact_type!=='task'&&/progress/i.test(action))return progressMessage(c,user,now);
 const reason=/confirm|activat/i.test(action)?`${publicRef(c)} has already been confirmed.`
  :/move|reschedul/i.test(action)?'A deadline can only be changed while the task is a draft.'
  : 'That action isn’t available for this task’s current state.';
 return paragraphs(reason,card(c,user,now,false),nextStep(c,now),paused(user));
}

export function cancelledMessage(c:Contract,user:User,now=new Date()):string {
 if(c.deleted_at)return deletedMessage(c,user,true,now);
 return paragraphs(`Cancelled ${publicRef(c)}`,card({...c,state:'cancelled'},user,now,false),'Future reminders stopped.\nLIST to see your board.');
}

/** Removal hides the named task; its saved history remains available to the app. */
export function deletedMessage(c:Contract,_user:User,already=false,_now=new Date()):string {
 return paragraphs(`${publicRef(c)} ${already?'already removed':'removed'}\n${displayTitle(c,120)}`,
  'Task reminders stopped.\nRemoved from your board; saved history retained.',
  'LIST to see your remaining tasks.');
}

export function scheduledProblemMessage(number:number,github:boolean):string {
 return github?`GitHub check delayed · #${number}\n\nI couldn’t refresh the evidence. Completion is still unverified.\nI’ll retry automatically.`
  : `Reminder delayed · #${number}\n\nI couldn’t prepare this reminder. Your task is saved.\nI’ll retry automatically.`;
}
