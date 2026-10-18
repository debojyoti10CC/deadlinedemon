CREATE TYPE intensity AS ENUM ('mild','savage','nuclear');
CREATE TYPE artifact_type AS ENUM ('pull_request','issue');
CREATE TYPE contract_state AS ENUM ('pending','active','completed','missed','cancelled');
CREATE TABLE users (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), imessage_handle text NOT NULL UNIQUE,
 timezone text NOT NULL, intensity intensity NOT NULL DEFAULT 'savage', paused boolean NOT NULL DEFAULT false,
 space_id text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE contracts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 title text NOT NULL, repo_owner text NOT NULL, repo_name text NOT NULL, artifact_type artifact_type NOT NULL,
 artifact_number integer NOT NULL CHECK(artifact_number>0), artifact_url text NOT NULL,
 due_at timestamptz NOT NULL, state contract_state NOT NULL DEFAULT 'pending', intensity intensity NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), confirmed_at timestamptz, completed_at timestamptz,
 missed_at timestamptz, last_checked_at timestamptz, last_observed_state jsonb, version integer NOT NULL DEFAULT 1
);
CREATE TABLE inbound_messages (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), provider_message_id text NOT NULL UNIQUE,
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, space_id text NOT NULL,
 message_text text NOT NULL, received_at timestamptz NOT NULL, processed_at timestamptz,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','done','failed')),
 attempts integer NOT NULL DEFAULT 0, run_at timestamptz NOT NULL DEFAULT now(), locked_until timestamptz,
 last_error text
);
CREATE TABLE scheduled_jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contract_id uuid NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
 job_type text NOT NULL, run_at timestamptz NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','done','failed')),
 attempts integer NOT NULL DEFAULT 0, locked_until timestamptz, last_error text,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(contract_id,job_type)
);
CREATE TABLE outbox (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 contract_id uuid REFERENCES contracts(id) ON DELETE CASCADE, space_id text NOT NULL,
 event_key text NOT NULL UNIQUE, message_text text NOT NULL,
 contract_version integer,
 kind text NOT NULL CHECK(kind IN ('reply','reminder','verdict','victory','error')),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','sent','suppressed','failed')),
 attempts integer NOT NULL DEFAULT 0, run_at timestamptz NOT NULL DEFAULT now(), locked_until timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), sent_at timestamptz, last_error text
);
CREATE TABLE contract_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contract_id uuid NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
 event_type text NOT NULL, observed_at timestamptz NOT NULL DEFAULT now(), evidence_url text, evidence jsonb NOT NULL
);
CREATE TABLE conversation_messages (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 role text NOT NULL CHECK(role IN ('user','assistant')), content text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX contracts_user_state ON contracts(user_id,state,due_at);
CREATE INDEX jobs_due ON scheduled_jobs(run_at) WHERE status IN ('pending','processing');
CREATE INDEX inbox_due ON inbound_messages(run_at) WHERE status IN ('pending','processing');
CREATE INDEX outbox_due ON outbox(run_at) WHERE status IN ('pending','processing');
CREATE INDEX events_contract ON contract_events(contract_id,observed_at);
CREATE INDEX conversations_user ON conversation_messages(user_id,id DESC);
