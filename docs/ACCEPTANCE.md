# Live acceptance record

Do not mark a feature working solely because a build or mocked test passes. Record each completed live check below with the time, contract UUID where applicable, observed GitHub URL/state, and safe logs or screenshots. Exclude tokens, connection strings, and full private conversations.

| Gate | Required evidence | Current status |
| --- | --- | --- |
| Local validation | Typecheck, automated tests, production build | Passed 2026-10-19: 547 tests, zero skips, including 66 PostgreSQL integration tests in the separate test database; typecheck/build passed |
| Photon round trip | Owner command reaches the running application; real reply appears on device | Passed 2026-10-18: owner confirmed the LIST reply appeared on the iPhone. Application records show 4 inbound messages processed and 4 outbound messages sent, with zero contracts; latest inbound at 15:09:47 UTC. Readiness remains healthy. The earlier standalone challenge diagnostic was not completed. |
| Database persistence | Migrations applied; contract/history survive process restart | Upgrade 001→002 applied after verified backup; five inbound and five sent-message records remained unchanged; 21 integration tests passed, including pool restart; app restarted with healthy readiness; no contract rows existed to migrate |
| Authenticated GitHub | Read selected allowed real PR; exact state/merge timestamp/check limitations | One authenticated repository metadata GET returned HTTP 200; actual PR proof/check permissions remain unverified |
| OpenAI | One real schema-validated request on configured model | Passed previously: one gpt-6-luna request; SDK retries disabled |
| Ordinary task workflow | Send task(s) with exact separate deadlines → confirm → receive scheduled reminder → report DONE | Real phone conversation created two pending ordinary tasks. New numeric controls, persisted selection, HP, modes and draft edits pass offline/database checks. Redesigned device confirmation/reminder/completion workflow remains pending. |
| Message experience | Compact cards, stable numbers, truthful HP, distinct modes | Implemented and locally rendered; all tests pass. Migration 003 preserved both pending tasks and every existing row count. Device display awaits LIST from owner. |
| Date clarification recovery | Exact screenshot inputs use the owner's date and retain task context | Actual stored exchange replayed with network disabled: “9 am 19th october” resolves to October 19, 09:00 Asia/Kolkata. Recovered pending task #3 and queued one corrected card; Photon acknowledged it at 2026-10-18 18:59:22 UTC. Physical receipt and confirmation remain pending. |
| Hourly task summaries | One combined unfinished-task message with fresh meters; durable cadence and safe suppression | 17 new PostgreSQL tests passed for scheduling/delivery lifecycle. Migration 004 preserved all existing rows/fields. Normal running worker sent one preview; Photon acknowledged at 2026-10-18 19:29:16 UTC on first attempt. Next stored slot October 19, 01:59 IST. Physical receipt and one-hour recurrence remain pending. No OpenAI/GitHub request used. |
| Draft completion and reply audit | Explicit draft DONE, terminal commands, repeat controls, task isolation, current HP | Real orchestrator/database journeys passed for screenshot sequence and boundary states. Owner's earlier DONE 1 recovered: #1 completed100%, unconfirmed; #3 retained active27%. Corrected reply acknowledged by Photon 2026-10-18 20:41:58 UTC. Physical receipt pending. [Case evidence](EDGE_CASES.md). |
| Message presentation | Consistent facts, compact meters, contextual actions, useful mode voices | Shared formatter tests passed; 13 gallery message types checked at phone width with no horizontal overflow, and all three tone controls exercised. Running build updated with task/preferences hashes unchanged. New native iPhone rendering remains a device check; no extra service request used. [Formats](MESSAGE_FORMATS.md). |
| Full GitHub workflow | Confirmed PR/issue → worker evidence refresh → proactive iPhone verdict without inbound trigger | Pending live verification |
| Individual deadline alerts | Task-specific 2h/1h/30m/15m alerts, fresh progress/countdowns, no stale burst after pause | Scheduler, outbox, migration, and paused-worker regressions passed. Future checkpoints installed locally with all existing data preserved; actual scheduled device delivery remains pending. |
| Current inbound reception | A fresh normal owner message is persisted and answered after the latest restart | Recent owner messages were absent from the inbox while outbound hourly messages worked. Receive/rejection diagnostics and inline-text reply support are installed; recovery requires a new real round trip. |
| Hosted operation | Running persistent host, healthy process, restart recovery | Local application ready: database/Photon/worker healthy; continuous cloud deployment pending |

## Minimal real demo

1. Start the installed app and verify `/readyz`; the Photon LIST round trip already passed on the real iPhone.
2. Send an ordinary task with a clear future date and time, such as “Finish the front end tomorrow at 5 AM.” Confirm its pending number with `CONFIRM 1`, or select it then send `CONFIRM`.
3. Send a second ordinary task with a different exact time, such as “Ship tomorrow at 10 AM.” Confirm that task separately and verify `LIST` shows both deadlines.
4. Send `PROGRESS 1 40` and verify the HP bar says 40% self-reported. Allow a scheduled reminder without another inbound message, then send `DONE 1`; completion must be labelled self-reported and HP become 100%. This path should make no GitHub request.
5. To demonstrate optional GitHub verification, use an open real PR you control, confirm it, and allow an independent GitHub observation. Merge it normally and verify the real `merged_at` timestamp drives the completion verdict.

Run only the scenarios needed for acceptance. These operations consume real service quota. Keep manual test contracts limited and cancel remaining demo contracts.

## Focused resilience and authorization checks

- `PAUSE` suppresses monitoring/proactive sends while preserving contracts. `RESUME` refreshes current evidence. `CANCEL <UUID>` prevents future reminders.
- An unauthorized sender, group, outbound echo, attachment, or unallowlisted repository cannot create a contract or receive a response.
- Replaying the same provider message ID does not create a second logical contract/response. Use an isolated test database for injected replay tests; never simulate provider traffic in production.
- A closed unmerged PR remains incomplete. A closed issue is described only as issue closure. Absent/unreadable checks are marked unknown.
- A GitHub/LLM outage or expired key produces a failed/retrying job, not fabricated evidence or a success verdict. Correct credentials and verify bounded retries/recovery.
- Restart with due jobs/outbound work present: verify durable processing resumes. Photon send acknowledgement/crash can still duplicate a message; acceptance is at-least-once delivery, not exactly once.

Record any unexecuted gate as pending. A Photon-only round trip does not establish the full product workflow, and a running local process does not establish continuous hosted availability.
