# Message experience

Implemented 19 October 2026. Open [the interactive gallery](message-gallery.html) to compare 17 message types across MILD, SAVAGE, and NUCLEAR. Its sample tasks are fictional and rendered by the application's actual formatting functions; it sends nothing and changes no saved data. Rebuild it with `npm run docs:gallery`.

Current presentation preference: professional plain text, restrained headings, explicit field labels, and no decorative emojis, jokes, or theatrical language. The existing mode commands remain compatible: MILD uses supportive guidance, SAVAGE uses direct accountability, and NUCLEAR uses firm deadline focus. HP meter glyphs remain functional indicators. User-authored task titles are preserved.

## Format contract

Single-task replies have three parts: the outcome, a factual task card, and a useful next step. An acknowledgement names the task once. Viewing details uses a neutral heading and does not claim to change selection. A terminal task receives no activation, progress, or DONE prompt.

The task card shows its title, current state, exact reported HP, full local deadline, and a concise countdown where relevant. Ordinary HP uses ten fixed-width progress glyphs; filled cells round down while the exact percentage remains visible. Reporting provenance gets its own short line so “self-reported” does not split across the meter line. Completed ordinary tasks retain the self-reported completion label. Elapsed time never fills HP.

Boards and hourly summaries use compact meters and explain owner reporting once for the whole message. The timezone appears once; every task keeps its own exact date and time. All unfinished tasks remain visible, recent history is compact, and a completed saved selection is explained rather than silently moved to another task.

GitHub targets show their target and cached observation time, with no invented HP. An observation is labelled as an observation; formatting it does not perform a new GitHub check. An issue closure is not a claim of shipped code. Missing evidence stays unknown.

All views share title truncation, state, deadline, countdown, and meter helpers. Titles collapse embedded whitespace and truncate complete graphemes, preserving emoji and combined characters. A supplied snapshot clock is threaded through the whole message, including deadline boundaries. The actual iMessage font, bubble colour, and line wrapping remain controlled by Apple's Messages app.

## Reply types

| Reply | Presentation |
| --- | --- |
| Greeting | Short introduction and deadline example; full command reference stays in HELP |
| Draft saved | Exact task/deadline, one confirmation per draft, optional ordinary DONE example |
| Locked in | Current task facts, countdown, and concise update controls |
| Progress saved | Exact reported percentage; no repeated task number or full menu |
| Selection | Explicit acknowledgement of the saved target and its own next step |
| Status | Neutral details without a selection claim |
| Board | Unfinished work, selected marker, compact recent results, concrete task guidance |
| Hourly check-in | Current unfinished work, one reporting note, mode-specific opening |
| Completion | 100% reported HP, honest late label where applicable, mode-specific celebration |
| Repeated completion | Existing completion acknowledgement; no second celebration or mutation |
| Cancelled target | That task's state and an appropriate new-task suggestion |
| Removed task | Exact number/title, stopped-reminder acknowledgement, saved-history note and LIST; a repeat says already removed |
| Deadline alerts: 2h / 1h / 30m / 15m | A task-specific alert heading with actual time left, current HP/deadline, a professional nudge, and at most two action lines |
| Integration problem | Public task number, honest temporary failure, automatic retry information |

Existing task numbers, commands, confirmation rules, state transitions, and stored preferences are preserved. Confirmed tasks now receive future eligible 120/60/30/15-minute alert checkpoints. Older checkpoints expire as the next one becomes current, including when work waits in the outbox. Completion/cancellation suppresses delivery. Short tasks retain their two-minute warning; hourly combined check-ins remain separate. No reminder preferences or other proposed commands are introduced.

## Verification

611 tests across 16 files passed with zero skips, including 81 real PostgreSQL tests. Type checking and the production build passed. The initial 13-card professional gallery was checked at a 390 × 844 viewport with zero horizontal overflow. The updated 17-card gallery was refreshed in the browser and verified to include actual 2h/1h/30m/15m alert headings with no horizontal overflow at the current desktop viewport. These checks cover the preview; native iPhone rendering remains a device check.

The running app was restarted. A before/after hash comparison confirmed every saved task field, selected target, mode, pause setting, and hourly schedule stayed unchanged. Readiness reports database, Photon, and worker healthy. No extra iMessage, OpenAI, or GitHub request was used to test these formats.

Larger product changes are listed separately in [PRODUCT_NEXT.md](PRODUCT_NEXT.md).
