-- A task can leave the board without erasing its state, evidence or audit trail.
-- Task numbers remain stable and are never reused.
ALTER TABLE contracts ADD COLUMN deleted_at timestamptz;

-- Owner-level boards and multi-task proposals can also contain one removed task.
-- Retain structured references so queued snapshots can be suppressed without
-- interpreting their human-facing message text.
ALTER TABLE outbox ADD COLUMN referenced_contract_ids uuid[];
