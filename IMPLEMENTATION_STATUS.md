# Implementation status

Updated 19 October 2026 · Asia/Kolkata

## Available

Deadline Demon runs as a persistent owner-only iMessage agent using Photon Spectrum, PostgreSQL, and bounded OpenAI interpretation. Ordinary tasks support native date parsing, multiple milestones, stable task numbers, saved selection, self-reported HP, completion, and three professional reminder intensities. Optional GitHub PR/issue evidence uses a repository allowlist and read-only application access.

Durable workers handle inbound messages, individual task reminders, hourly combined check-ins, and outbound delivery. Confirmed tasks receive eligible 2-hour, 1-hour, 30-minute, and 15-minute deadline alerts, a deadline check, and a follow-up. Short commitments retain their two-minute warning/follow-up. Both scheduling and delivery suppress expired checkpoints. Completed/cancelled work stops receiving alerts; PAUSE preserves deadlines and silences proactive messages.

Messages use clear headings, exact local deadlines, actual time remaining, concise actions, and truthful progress labels. Ordinary-task alerts and hourly summaries make no OpenAI or GitHub calls. The [message gallery](docs/message-gallery.html) uses fictional data and the actual formatters; regenerate it with `npm run docs:gallery`.

Explicit `DELETE <task number>` removes one task from the board, summaries and statistics, and stops its queued work. The saved record and audit history remain recoverable. Repeated deletion is idempotent; bare or bulk commands never borrow a selected task. Native replies and HELP show the action. The current integration uses text commands; tappable mini-app controls are not implemented.

## Verification

Type checking and the production build passed. **611 tests across 16 files passed with zero skips**, including **81 real PostgreSQL integration tests**. Tests use mock service clients and made no live OpenAI, GitHub, or Photon calls. Database suites use a separate `TEST_DATABASE_URL`, create unique schemas, and clean them up.

Migration tests preserve existing task IDs, state, deadlines, progress, owner settings, messages, and history. Migration 005 adds only future new alert checkpoints to active confirmed tasks and is idempotent. The local upgrade uses a verified PostgreSQL backup and before/after data comparisons. [Migration and rollback procedures](docs/MIGRATIONS.md).

Migration 005 was applied locally after a verified custom-format backup. Every existing task, owner setting, message, event, and existing job remained unchanged. Two future checkpoint jobs were added to the existing active task. The new runtime is running. The gallery now contains all four alert types and was refreshed and checked in the browser.

Migration 006 was applied locally after another verified backup and a zero-backlog check for legacy unbound replies. All existing fields were compared and preserved: four tasks, six jobs, seven events, thirty inbound messages and thirty-eight outbox rows. The new nullable markers are null on every existing record; no live task was removed. Database, Photon and worker readiness passed after restart. Deletion was exercised in isolated PostgreSQL command journeys and delivery tests; actual owner-initiated deletion on the phone remains a live check.

Inbound verification (19 October 2026): after safe receive/rejection diagnostics and plain-text inline reply support were installed, a real ordinary-task message was accepted at 06:06:31 IST and persisted as a new draft. A fresh owner LIST was received at 06:40:35 IST, processed on its first attempt at 06:40:36 IST, and its reply was acknowledged by Photon in that same second. The board includes the new draft. Both observed frames were accepted, none rejected, and no inbox work was pending or failed. Existing tasks were not renamed or rescheduled. This establishes current receipt, persistence, processing and provider reply acceptance; physical receipt of these replies still needs the owner's confirmation. The original missing-message interval's root cause remains unproven. Readiness exposes receipt counters separately because consumer startup alone cannot establish delivery.

Device evidence already established: the owner received a real LIST response on the iPhone, and real conversations created task drafts. One prior OpenAI diagnostic passed; authenticated GitHub repository metadata was readable. Photon acknowledged earlier corrected task replies and an hourly preview. A provider acknowledgement does not establish physical device receipt.

The complete current confirmed-task → automatic deadline alert → progress/completion phone journey, authenticated PR/issue evidence checks, and continuous cloud operation remain live acceptance gates. [Acceptance checklist](docs/ACCEPTANCE.md).

## Operation and limits

- Local PostgreSQL, application configuration, and the agent are provisioned on the current Windows computer. `START.cmd` starts that installation. A new checkout follows the Docker/managed database instructions in [README.md](README.md).
- The local computer and app must remain running for reminders. Cloud deployment has not been completed; Docker image execution remains unverified because the local Docker engine was unavailable.
- Photon delivery is at least once. A timeout/crash after provider acceptance can duplicate a retry; the SDK offers no stable application send key or durable inbound acknowledgement cursor.
- Five actual failures park a job. Correct the cause before explicitly retrying. Paused work consumes no failure attempts. GitHub monitoring stops 24 hours after a missed deadline; owner-triggered checks remain available.
- HP and ordinary completion are self-reported. Linked PR completion requires a real merge timestamp; issue closure is an observation, not proof of shipped code. Missing checks remain unknown.
- Credentials, database files, backups, local runtime binaries, installed dependencies, and build output are excluded from Git. The application itself reads GitHub only; publishing this source repository is a separate developer action.
