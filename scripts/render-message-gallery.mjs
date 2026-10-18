import {writeFile} from 'node:fs/promises';
import {activatedMessage,boardMessage,cancelledMessage,completionMessage,hourlySummaryMessage,progressMessage,proposalMessage,scheduledProblemMessage,selectedMessage,statusMessage,taskActionUnavailableMessage} from '../dist/src/agent/messages.js';
import {WELCOME_REPLY} from '../dist/src/agent/help.js';
import {taskReminder} from '../dist/src/contracts/tasks.js';

// Documentation samples only. No database, credentials, integrations, or runtime state.
const now=new Date('2026-10-18T21:00:00Z');
const original={id:'11111111-1111-4111-8111-111111111111',user_id:'sample',display_id:3,title:'Edit the launch video',artifact_type:'task',repo_owner:null,repo_name:null,artifact_number:null,artifact_url:null,
 due_at:new Date('2026-10-19T03:30:00Z'),state:'active',intensity:'savage',progress_percent:27,created_at:new Date('2026-10-18T15:00:00Z'),confirmed_at:new Date('2026-10-18T16:00:00Z'),completed_at:null,missed_at:null,last_checked_at:null,last_observed_state:null,version:2};
const payload={};
for(const mode of ['mild','savage','nuclear']){
 const user={id:'sample',imessage_handle:'sample',timezone:'Asia/Kolkata',intensity:mode,paused:false,space_id:'sample',selected_contract_id:original.id};
 const active={...original,intensity:mode};
 const draft={...active,id:'22222222-2222-4222-8222-222222222222',display_id:2,title:'Publish the homepage',progress_percent:0,state:'pending',confirmed_at:null,due_at:new Date('2026-10-19T04:30:00Z')};
 const completed={...active,id:'33333333-3333-4333-8333-333333333333',display_id:1,title:'Finish the design',state:'completed',progress_percent:100,due_at:new Date('2026-10-18T18:30:00Z'),completed_at:now,missed_at:new Date('2026-10-18T18:30:00Z')};
 const cancelled={...draft,display_id:5,state:'cancelled',title:'Draft the old announcement'};
 const github={...active,id:'44444444-4444-4444-8444-444444444444',display_id:4,title:'Merge the launch changes',artifact_type:'pull_request',repo_owner:'example',repo_name:'launch',artifact_number:24,artifact_url:'https://github.com/example/launch/pull/24',last_checked_at:new Date('2026-10-18T20:45:00Z')};
 github.last_observed_state={artifact:github,title:github.title,observedAt:'2026-10-18T20:45:00Z',state:'open',mergedAt:null,closedAt:null,headSha:null,mergeable:null,draft:null,checks:[],reviews:[],files:[],limitations:[]};
 // Drop the circular sample reference before data serialization (messages use only strings).
 github.last_observed_state.artifact={repo_owner:github.repo_owner,repo_name:github.repo_name,artifact_type:github.artifact_type,artifact_number:github.artifact_number,artifact_url:github.artifact_url};
 const rows=[
  ['Welcome','A short greeting; the full command reference stays in HELP.',WELCOME_REPLY],
  ['Draft saved','One task, one explicit confirmation command.',proposalMessage([draft],user,now)],
  ['Reminders started','Clear acknowledgement with exact task facts.',activatedMessage(active,user,now)],
  ['Progress saved','The exact report is 27%; time never fills the meter.',progressMessage(active,user,now)],
  ['Hourly check-in','Every unfinished task. One reporting note.',hourlySummaryMessage([draft,active,completed],user,now)],
  ['Your board','Current work first, recent results beneath.',boardMessage([completed,draft,active],user,{total:'2',completed:'1',missed:'1'},now)],
  ['Task selected','The selected number appears once.',selectedMessage(active,user,now)],
  ['Completion recorded','A late report stays honest; no more commands for this task.',completionMessage(completed,user,false,now)],
  ['Already completed','A repeat command changes nothing.',completionMessage(completed,user,true,now)],
  ['Cancelled task','State-specific help keeps the command on the named task.',taskActionUnavailableMessage(cancelled,user,'DONE',now)],
  ['GitHub snapshot','An observation time distinguishes stored evidence from a new check.',statusMessage(github,user,now)],
  ...[120,60,30,15].map(minutes=>[
   `${minutes===120?'2-hour':minutes===60?'1-hour':`${minutes}-minute`} deadline alert`,
   'One task, its current HP, and actual time remaining. Expired checkpoints are skipped.',
   taskReminder(active,user.timezone,new Date(active.due_at.getTime()-minutes*60_000),false,`before_${minutes}`),
  ]),
  ['Temporary problem','A useful retry acknowledgement without database identifiers.',scheduledProblemMessage(3,false)],
 ];
 payload[mode]=rows.map(([title,note,text])=>({title,note,text}));
}
const data=JSON.stringify(payload).replace(/</g,'\\u003c');
const html=`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Deadline Demon — Message formats</title>
<style>
:root{color-scheme:light;--ink:#172332;--muted:#566474;--paper:#f5f7fa;--line:#dce2e9;--accent:#294e79}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}header{max-width:1160px;margin:auto;padding:48px 24px 24px}.eyebrow{font-size:12px;letter-spacing:.06em;font-weight:600;color:var(--muted)}.brand{display:flex;align-items:center;gap:12px}.mark{display:grid;place-items:center;width:36px;height:36px;border:1px solid var(--line);border-radius:6px;background:white;color:var(--ink);font-size:12px;font-weight:750;letter-spacing:.03em}h1{font-size:clamp(32px,4vw,46px);font-weight:650;line-height:1.15;letter-spacing:-.035em;margin:30px 0 14px;max-width:750px}.intro{max-width:750px;font-size:15px;line-height:1.7;color:var(--muted)}.toolbar{display:flex;align-items:center;justify-content:space-between;gap:20px;flex-wrap:wrap;border-top:1px solid var(--line);border-bottom:1px solid var(--line);padding:16px 0;margin-top:28px}.modes{display:flex;gap:6px}.modes button{cursor:pointer;padding:9px 16px;border:1px solid var(--line);border-radius:6px;background:white;color:var(--ink);font-weight:600;font-size:13px}.modes button[aria-pressed=true]{background:var(--ink);color:white;border-color:var(--ink)}.snapshot{font-size:12px;color:var(--muted)}main{max-width:1160px;margin:auto;padding:0 24px 48px;display:grid;grid-template-columns:repeat(auto-fit,minmax(min(310px,100%),1fr));gap:20px}.example{min-width:0;padding:20px;background:white;border:1px solid var(--line);border-radius:8px}.label{display:flex;justify-content:space-between;align-items:center;gap:12px;margin:0 0 8px;font-size:14px;font-weight:650}.number{font-size:11px;color:var(--muted);font-variant-numeric:tabular-nums;letter-spacing:.05em}.note{min-height:38px;font-size:12px;line-height:1.6;color:var(--muted);margin:0 0 16px}.message{background:#f5f7fa;border:1px solid #e5e9ef;border-radius:6px;padding:16px;margin:0;font-size:16px;line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere;min-width:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-variant-numeric:tabular-nums}.foot{max-width:1112px;margin:0 auto 40px;padding:20px 0;border-top:1px solid var(--line);font-size:12px;color:var(--muted);line-height:1.8}.foot a{color:var(--accent);text-underline-offset:3px}button:focus-visible,a:focus-visible{outline:3px solid #7799bd;outline-offset:3px}@media(max-width:600px){header{padding-top:28px}main{gap:16px}.example{padding:16px}.note{min-height:0}.snapshot{font-size:11px}.foot{margin:0 24px 32px}}@media(prefers-reduced-motion:no-preference){.modes button{transition:background .16s,color .16s}}
</style><header><div class="brand"><span class="mark">DD</span><div class="eyebrow">Deadline Demon / Message guide</div></div><h1>Message formats</h1><p class="intro">Consistent task details, clear progress, and a relevant next action. Compare the app’s message formats across three reminder intensities. Examples use the actual formatters with sample data; the final font and message bubbles are controlled by Messages.</p><div class="toolbar"><div class="modes" role="group" aria-label="Message intensity"><button data-mode="mild" aria-pressed="false">Mild</button><button data-mode="savage" aria-pressed="true">Savage</button><button data-mode="nuclear" aria-pressed="false">Nuclear</button></div><div class="snapshot">Sample snapshot · 19 Oct 2026, 2:30 AM IST</div></div></header><main id="examples"></main><footer class="foot">Preview data is fictional and isolated from the running agent. All task numbers, percentages, and times shown here belong to these examples. Production messages use saved owner data.<br>Next product proposals: <a href="PRODUCT_NEXT.md">quiet hours, reminder bundling, and safer rescheduling</a>.</footer><script>
const payload=${data};const list=document.getElementById('examples');function render(mode){list.replaceChildren(...payload[mode].map((sample,index)=>{const article=document.createElement('article');article.className='example';const label=document.createElement('div');label.className='label';const name=document.createElement('span');name.textContent=sample.title;const n=document.createElement('span');n.className='number';n.textContent=String(index+1).padStart(2,'0');label.append(name,n);const note=document.createElement('p');note.className='note';note.textContent=sample.note;const message=document.createElement('pre');message.className='message';message.textContent=sample.text;article.append(label,note,message);return article;}));document.querySelectorAll('[data-mode]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.mode===mode)));}document.querySelectorAll('[data-mode]').forEach(button=>button.addEventListener('click',()=>render(button.dataset.mode)));render('savage');
</script></html>`;
await writeFile(new URL('../docs/message-gallery.html',import.meta.url),html);
console.log('Generated docs/message-gallery.html: 16 message types × 3 intensities; no integrations called.');
