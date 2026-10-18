-- One durable owner-level hourly summary, independent of per-task activation.
ALTER TABLE users ADD COLUMN hourly_summary_due_at timestamptz;
UPDATE users AS u SET hourly_summary_due_at=now()+interval '1 hour'
 WHERE EXISTS (SELECT 1 FROM contracts c WHERE c.user_id=u.id AND c.state IN ('pending','active','missed'));
CREATE INDEX users_hourly_summary_due ON users(hourly_summary_due_at) WHERE hourly_summary_due_at IS NOT NULL;

ALTER TABLE outbox DROP CONSTRAINT outbox_kind_check;
ALTER TABLE outbox ADD CONSTRAINT outbox_kind_check
 CHECK(kind IN ('reply','reminder','verdict','victory','error','summary'));
