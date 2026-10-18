# Conversation and reminder audit

Verified 2026-10-19, Asia/Kolkata. This audit follows the real phone failure where `SELECT 1` selected an expired ordinary draft and `DONE 1` incorrectly returned a chooser for another task.

## Fixes and regression evidence

| Scenario | Expected and verified outcome | Evidence |
| --- | --- | --- |
| DONE on an ordinary draft, future or expired | Record self-reported completion and 100% HP; preserve `confirmed_at=null`; do not activate reminders. Expired reports are late. | Real PostgreSQL service and conversation tests |
| SELECT 1 → DONE 1 while #3 is active at 27% | Complete #1; preserve every field of #3. | Real orchestrator/database journey; production repair comparison |
| Repeated DONE, including bare DONE with completed selection | Acknowledge “Already completed”; preserve timestamp and one completion audit event; never complete another task. | Real orchestrator/database journey |
| Progress on a draft | Accept 0–99% as a draft update; 100% records completion; no implicit confirmation/jobs. | Real PostgreSQL service and journey tests |
| Cancelled task receives DONE, PROGRESS, CONFIRM, STATUS, or SELECT | Explain that exact task's state; do not reopen it or redirect mutations. | Real orchestrator/database journey and response tests |
| Repeated CONFIRM on an active task | Acknowledge the existing confirmation without duplicate jobs/audit or extra GitHub reads. | Real orchestrator/database journey |
| Explicit task differs from selected task | Explicit number wins. A missing or terminal selection never falls through to an unrelated eligible task. | Conversation and database tests |
| Wrong owner, unknown number, invalid/oversized reference | No access or mutation to another owner's task; no integer-cast failure; useful task-number guidance. | Real orchestrator/database journey |
| More than 30 unfinished tasks or an old completed task | Every unfinished task remains reachable; owner-scoped explicit lookup reaches history without relying on the board window. | 31-task database journey |
| STATUS for a completed/cancelled task | Neutral task details; no false “Selected” acknowledgement or selection change. | Rendering and orchestrator tests |
| Only a pending GitHub draft and bare DONE/RECHECK | Explain the draft and confirmation/MOVE next step; do not claim no unfinished tasks or invent completion. | Orchestrator tests; no live GitHub call |
| Deadline passes during a GitHub confirmation check | Preserve the draft; offer MOVE on its actual number and then CONFIRM. | Simulated slow-check test |
| Pause lasts longer than the retry budget | Paused claims consume zero failure attempts; resumed delivery retains five actual transport attempts. | Real PostgreSQL worker tests with failing mock transport |
| Intensity changes while a GitHub reminder is queued | Refresh delayed copy for current settings even when evidence is unchanged. | Red-before/green-after mocked delivery regression |
| Hourly summary waits while task progress/membership changes | Re-read current HP and unfinished tasks at delivery; omit completed/cancelled tasks. | Real PostgreSQL delivery and conversation journeys |
| Concurrent hourly schedulers, restart, downtime | One durable slot; preserved next due time; one current summary after downtime rather than a backlog. | Real PostgreSQL integration tests |
| Paused/empty/wrong-space/expired summary | Suppress delivery; last unfinished task completion/cancellation stops the hourly clock. | Real PostgreSQL integration tests |
| Common tomorrow spelling, day-first dates, Yes after clarification | Parse owner-grounded dates; retain original relative-date timestamp across midnight; do not reuse rejected corrections. | Intent regressions and network-disabled stored-conversation replay |
| Missing AM/PM, vague dates, invalid calendar dates, DST gaps/overlap | Ask for a clear valid future deadline; do not activate a fabricated time. | Date and intent regressions |
| Confirm after a reminder threshold, or exactly on it | Schedule only future checkpoints; do not immediately replay the elapsed threshold. | Scheduler and PostgreSQL confirmation tests |
| Resume at fourteen minutes remaining with old checkpoints queued | Discard 2h/1h/30m jobs and old outbox warnings; send only the current 15m checkpoint. | Real PostgreSQL worker test with mock transport |
| Delay a two-hour alert until ninety minutes remain | Render 1h 30m from the delivery clock for ordinary and GitHub work; no extra model request. | Outbox regressions |
| Complete/cancel or move a deadline while an alert is queued | Suppress terminal tasks and checkpoints outside their current window before paid reads. | Outbox and worker tests |
| Plain-text inline reply from the exact owner | Process only its new text; ignore quoted targets. Groups, other senders and nontext replies remain rejected. | Authorization and transport tests |
| Outgoing sends work while incoming messages stop | Show safe last-frame/accepted/rejected metadata separately; outbound success cannot erase an observed receive failure. Silence remains unverified, not evidence of recovery. | Transport tests; live reception investigation remains open |

## Validation

547 tests across 15 files passed with zero skips, including 66 tests against a separate PostgreSQL test database. TypeScript checking and the production build passed. Test schemas were isolated and removed; test transports, OpenAI, and GitHub clients made no live service calls.

The actual owner's previously processed `DONE 1` was recovered through the normal orchestrator after a verified database backup. Task #1 became completed at 100%, without confirmation. All fields of tasks #2 and #3 were compared before/after and remained unchanged; #3 remains active at 27%. One corrected completion reply was acknowledged by Photon at 2026-10-18 20:41:58 UTC on its first attempt. Readiness reports database, Photon, and worker healthy. Physical receipt of that corrected reply is not established by the send acknowledgement.

## Remaining limits

Tests establish the listed behaviors, not every possible future input or service failure. Live GitHub PR/issue proof and the full confirmed-task → scheduled deadline reminder → completion phone workflow still need real acceptance evidence. The local computer must stay awake. Photon delivery is at least once: an uncertain acknowledgement followed by a retry can duplicate a message; no exactly-once claim is made.
