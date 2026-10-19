# Product changes worth making next

Planning notes · 19 October 2026 · Asia/Kolkata

## Available now

Stable task numbers, saved task selection, self-reported HP meters, ordinary-task completion, optional GitHub evidence, three intensity choices, hourly combined summaries, and individual 2h/1h/30m/15m deadline alerts are implemented. `PAUSE` and `RESUME` control proactive messages. `MOVE` changes a pending draft's deadline. Completed and cancelled tasks leave hourly summaries and deadline alerts. Expired alert checkpoints are skipped after downtime.

Explicit `DELETE <task number>` now removes one task from the board while preserving its record and audit history. It stops reminders and suppresses queued snapshots involving that task. Native tap buttons and an in-chat restore command remain future work.

The proposals below are future work. Every example marked **proposed** describes a command to design and implement; it is not available today. Full phone acceptance and always-on operation remain separate readiness gates.

## Priorities

| Priority | Proposed change | User benefit | Integration cost | Acceptance trigger |
| --- | --- | --- | --- | --- |
| 1 | **Reminder preferences:** quiet hours, personal summary cadence, and timed snooze | Keep hourly accountability useful through sleep, meetings, and focused work. | **Medium:** saved preferences, local-time scheduling, delivery checks, and settings replies. | An overnight quiet window survives restart; messages queued before it are checked again at delivery. `PAUSE` overrides every preference. At quiet-window or snooze end, send at most one fresh summary, without replaying missed check-ins. DST and cross-midnight windows have explicit tests. |
| 2 | **Bundle overlapping reminders** | Avoid an hourly board and a task milestone arriving almost together. | **Medium:** owner-level scheduling coordination and refreshed delivery content. | A summary and milestone within a short configured window produce one combined message containing the deadline warning and current HP. Different tasks stay visible. A completed task cannot reappear from an older queued message. Timeouts retain the documented possibility of provider duplicates. |
| 3 | **Safe rescheduling for active and overdue tasks** | Recover from a slipped plan without cancelling and recreating work. | **Medium:** a proposed-change step, transactional schedule replacement, and audit history. | Show the old and new deadline before applying. An explicit confirmation replaces jobs and suppresses obsolete queued reminders atomically. Repeated confirmation is harmless. Preserve the original deadline and missed history; distinguish the revised plan in later reviews. Reject past or ambiguous replacement times. |
| 4 | **Undo accidental ordinary-task completion** | Recover from a mistaken `DONE` or 100% report. | **Medium:** reversible event data, guarded state restoration, and schedule rebuilding. | Allow a short, visible undo window for the latest owner-reported completion. Restore its previous HP and state, accounting for time elapsed; a former draft stays a draft. Reject stale undo after another change. Keep both completion and undo in the audit. GitHub evidence cannot be undone by owner report. |
| 5 | **One next action on the selected task** | Turn a large deadline into an immediate, concrete step. | **Small–medium:** one optional saved field and native editing commands. | Existing selected-task behavior remains intact. A next action survives restart and appears once in that task's details/check-in. Editing it changes neither HP nor deadline. Clear it explicitly or when the task finishes. |
| 6 | **Opt-in weekly review** | See completed work, slipped plans, and repeated blockers without another daily notification stream. | **Medium:** one durable weekly slot and deterministic aggregation over audit history. | One review per chosen local week, including after downtime. Separate self-reported completion from GitHub observations, and original deadlines from revisions. Zero tasks produces no unsolicited review. Turning it off suppresses queued reviews. |

Cost describes implementation scope, not service pricing. These changes can use local commands and deterministic messages; no new external integration is required.

## Proposed command examples

- **Proposed:** `QUIET 23:00–08:00` → “Quiet hours saved: 11 PM–8 AM, Asia/Kolkata. Proactive messages wait until morning. Deadlines stay the same.” An explicit optional exception for deadline alerts would need its own setting; the default should respect quiet hours.
- **Proposed:** `CHECKINS EVERY 2 HOURS` → “Check-ins every 2 hours. Your next one is at 4 PM.” Show the actual next eligible local time after quiet hours and snooze are applied.
- **Proposed:** `SNOOZE 60 MIN` → “Reminders snoozed until 3 PM. Your tasks and deadlines are saved.” Incoming commands continue to receive replies.
- **Proposed:** `MOVE 3 tomorrow 10 AM` → “Move #3 from today 9 AM to tomorrow 10 AM? Reply APPLY MOVE 3.” The saved deadline changes only after that confirmation.
- **Proposed:** `UNDO DONE 3` → “Completion undone for #3. HP restored to 27%. Deadline passed; choose a revised plan when ready.” The actual response must reflect the restored task's state and current time.
- **Proposed:** `NEXT 3 export the rough cut` → “Next step saved for #3: export the rough cut.”
- **Proposed:** `REVIEW SUNDAY 6 PM` → “Weekly review on Sundays at 6 PM, Asia/Kolkata. REVIEW OFF to stop.”

## Suggested release order

Start with reminder preferences and overlap bundling, then safe rescheduling. These address the largest remaining daily-use friction: notification volume and plans that change. Add undo before expanding natural-language mutation shortcuts. Next actions and weekly reviews can follow after the core phone journeys have passed acceptance.

For every addition, keep explicit task references authoritative, preserve existing task numbers and audit records, refresh queued content at delivery, and prove the exact conversation with a real database test. Use one targeted phone check for each new delivery behavior; broad automated coverage should use mocked providers.
