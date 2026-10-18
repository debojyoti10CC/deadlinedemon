-- Expand the existing target shape without changing any existing GitHub rows.
-- Text avoids PostgreSQL's transaction restriction on newly added enum values.
ALTER TABLE contracts
 ALTER COLUMN artifact_type TYPE text USING artifact_type::text,
 ALTER COLUMN repo_owner DROP NOT NULL,
 ALTER COLUMN repo_name DROP NOT NULL,
 ALTER COLUMN artifact_number DROP NOT NULL,
 ALTER COLUMN artifact_url DROP NOT NULL;

ALTER TABLE contracts ADD CONSTRAINT contracts_target_shape CHECK (
 (artifact_type = 'task' AND repo_owner IS NULL AND repo_name IS NULL
  AND artifact_number IS NULL AND artifact_url IS NULL)
 OR
 (artifact_type IN ('pull_request','issue') AND repo_owner IS NOT NULL
  AND repo_name IS NOT NULL AND artifact_number IS NOT NULL AND artifact_number > 0
  AND artifact_url IS NOT NULL)
);
