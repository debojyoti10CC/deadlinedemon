-- Stable short references and owner-reported task progress for readable iMessages.
CREATE SEQUENCE contracts_display_id_seq AS integer;
ALTER TABLE contracts ADD COLUMN display_id integer;

WITH numbered AS (
 SELECT id, row_number() OVER (ORDER BY created_at, due_at, id)::integer AS display_id
 FROM contracts
)
UPDATE contracts AS c SET display_id = n.display_id
FROM numbered AS n WHERE c.id = n.id;

SELECT setval('contracts_display_id_seq', COALESCE(max(display_id), 0) + 1, false) FROM contracts;
ALTER TABLE contracts ALTER COLUMN display_id SET DEFAULT nextval('contracts_display_id_seq');
ALTER SEQUENCE contracts_display_id_seq OWNED BY contracts.display_id;
ALTER TABLE contracts ALTER COLUMN display_id SET NOT NULL;
ALTER TABLE contracts ADD CONSTRAINT contracts_display_id_unique UNIQUE (display_id);

ALTER TABLE contracts ADD COLUMN progress_percent integer NOT NULL DEFAULT 0
 CHECK (progress_percent BETWEEN 0 AND 100);
UPDATE contracts SET progress_percent = 100
 WHERE artifact_type = 'task' AND state = 'completed';

ALTER TABLE users ADD COLUMN selected_contract_id uuid REFERENCES contracts(id) ON DELETE SET NULL;
CREATE INDEX contracts_owner_display_id ON contracts (user_id, display_id);
