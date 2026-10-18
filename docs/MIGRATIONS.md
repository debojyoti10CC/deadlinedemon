# Database migration and rollback

Migration `002_general_tasks.sql` permits ordinary task commitments alongside complete GitHub PR/issue references. Migration `003_task_experience.sql` adds stable numeric references, owner-reported task progress, and the owner's selected contract. Migration `004_hourly_summaries.sql` adds a durable owner-level hourly summary schedule and permits the aggregate `summary` outbox kind. Migration `005_deadline_alerts.sql` backfills the new two-hour and thirty-minute checkpoints for existing active, confirmed tasks. These migrations preserve contracts, audit history, reminders, messages, conversations, and existing contract UUIDs.

## Upgrade

1. Stop the application and other database writers. Run only one migration process.
2. Make and verify a database backup with the provider's backup tool. A PostgreSQL custom-format `pg_dump` is suitable. Keep the backup outside the source tree and restrict access because it contains owner messages and contract history.
3. Record contract IDs and states, plus row counts for users, contracts, contract events, scheduled jobs, inbound messages, outbox, and conversation messages.
4. Run `npm run db:migrate` or start the new application. The migration runner holds an advisory lock and commits schema changes and their `schema_migrations` tracking rows in one transaction. A failure rolls back that transaction; a retry skips migrations already recorded as applied.
5. Confirm all migration names appear in `schema_migrations`, compare the recorded IDs, states, and counts, and check `/readyz` after startup.

Migration 003 assigns existing contracts numeric `display_id` values in `(created_at, due_at, id)` order. These references are unique across owners. A sequence supplies references for later inserts, including inserts from the previous runtime. Cancellation, selection, restarts, and migration retries do not renumber contracts. Gaps are expected after rolled-back inserts or deleted contracts; do not reset the sequence or reuse a reference.

`progress_percent` is an integer from 0 through 100, defaulting to 0. Existing completed ordinary tasks receive 100; all other existing rows retain their state and start at 0. New task completion reports record 100 with the completion event. Intermediate progress is explicitly owner-reported and does not establish GitHub completion evidence.

`users.selected_contract_id` starts null and references a contract UUID. Deleting that contract clears the selection. The application checks that the selected contract belongs to the requesting owner; the foreign key checks existence only.

Migration 004 gives existing owners with unfinished tasks an `hourly_summary_due_at` one hour after upgrade. Empty owners remain unscheduled. Creating the first task arms a schedule, adding tasks preserves it, and finishing/cancelling the last unfinished task clears it. Scheduling uses the existing owner advisory lock before row locks, and one unique outbox event key per stored slot. It queues no messages during migration and does not activate any draft. Summary delivery re-reads current unfinished work and honors PAUSE.

To roll back the hourly runtime, stop writers and run the previous task-experience runtime while retaining migration 004 and its tracking row. Its original reads/writes remain compatible with the added nullable column and expanded kind constraint. It will not schedule hourly summaries, and its outbox guards suppress aggregate summaries that have no contract. Stop or suppress any pending `summary` rows when rolling back; preserve them as audit records. Re-enabling the hourly runtime resumes the stored schedule with at most one current check-in after downtime. No schema removal or data restoration is needed for this runtime rollback.

Useful read-only checks after migration:

```sql
SELECT name FROM schema_migrations ORDER BY name;
SELECT count(*) AS contracts, count(DISTINCT display_id) AS unique_references,
       count(*) FILTER (WHERE display_id IS NULL) AS missing_references
FROM contracts;
SELECT count(*) AS invalid_progress FROM contracts
WHERE progress_percent NOT BETWEEN 0 AND 100;
SELECT count(*) AS invalid_selections FROM users AS u
JOIN contracts AS c ON c.id = u.selected_contract_id
WHERE c.user_id <> u.id;
```

## Deadline alerts upgrade and rollback

Migration 005 adds only future `before_120` and `before_30` jobs for active tasks confirmed before those checkpoints. It does not activate drafts, revive completed/cancelled work, replay elapsed checkpoints, or change deadlines, HP, confirmation times, existing jobs, messages, or audit history. The existing unique `(contract_id, job_type)` key makes the backfill idempotent. Newly confirmed tasks get all eligible 120/60/30/15-minute checkpoints through the runtime scheduler.

The worker and outbox both check checkpoint relevance. A two-hour alert expires at one hour remaining; a one-hour alert expires at thirty minutes; a thirty-minute alert expires at fifteen minutes. The fifteen-minute alert expires at the deadline. Delivery uses the current task snapshot and actual remaining time, so retries cannot send obsolete progress or a fixed countdown from the original queue time.

For a runtime rollback, stop writers and retain migration 005, its tracking row, and all task data. The previous runtime accepts generic `before_` jobs, but lacks the narrower expiry windows. If the new cadence must also be disabled, mark only pending/failed new `before_120` and `before_30` jobs done and suppress unsent outbox rows for those exact milestone keys; preserve them as audit records. Do not delete contracts or restore an old backup merely to revert reminder cadence. Re-enabling these checkpoints later requires an explicit future-only backfill because the migration is recorded as applied.

## Rollback of the task experience runtime

Stop writers and deploy the previous ordinary-task-capable runtime while retaining migration 003, its tracking row, all additive columns, and the sequence. That runtime can continue reading its original columns and inserting contracts with default numeric references and progress. Retain every contract, state, audit event, and message; no down migration or deletion is needed.

The previous runtime ignores progress and selection. If it accepts task completions during the rollback window, it does not set their progress to 100. Before resuming the new runtime, reconcile progress to 100 for rows already recorded as completed ordinary tasks, preserving their completion timestamps and audit history. Do not infer completion for active or missed tasks.

The older GitHub-only runtime predating migration 002 cannot handle ordinary task rows. If any task rows exist, resolve issues forward or use the ordinary-task-capable runtime. Do not delete tasks or remove migration columns to force that runtime to start.

Restoring a verified backup is a separate whole-database recovery action when reverting data writes is intended. It loses writes made after the backup and requires explicit authorization and a stopped application. A runtime rollback alone does not require backup restoration.
