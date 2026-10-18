-- Existing commitments gain the two new checkpoints only when still in the future.
-- Preserve every existing job, confirmation, task state, and event verbatim.
INSERT INTO scheduled_jobs (contract_id, job_type, run_at)
SELECT c.id, checkpoint.job_type, c.due_at - checkpoint.minutes * interval '1 minute'
FROM contracts c
CROSS JOIN (VALUES ('before_120', 120), ('before_30', 30)) AS checkpoint(job_type, minutes)
WHERE c.state = 'active'
  AND c.confirmed_at IS NOT NULL
  AND c.due_at - checkpoint.minutes * interval '1 minute' > c.confirmed_at
  AND c.due_at - checkpoint.minutes * interval '1 minute' > now()
ON CONFLICT (contract_id, job_type) DO NOTHING;
