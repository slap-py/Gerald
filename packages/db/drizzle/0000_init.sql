CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;

DO $$ BEGIN
  CREATE TYPE security_mode AS ENUM ('NORMAL', 'READ_ONLY', 'LOCKED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE task_state AS ENUM ('ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE memory_kind AS ENUM ('fact', 'episode', 'entity', 'decision', 'relationship');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE channel AS ENUM ('text', 'email', 'voice', 'sms');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE auth_state AS ENUM ('unauthenticated', 'authenticated', 'step_up');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE webhook_state AS ENUM ('ACCEPTED', 'REJECTED', 'PROCESSED', 'FAILED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE notification_state AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), preferred_name text NOT NULL,
  timezone text NOT NULL DEFAULT 'America/Los_Angeles', security_mode security_mode NOT NULL DEFAULT 'NORMAL',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS authorized_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id),
  kind text NOT NULL, normalized_value text NOT NULL, is_active boolean NOT NULL DEFAULT true,
  pin_verifier text, failed_pin_attempts integer NOT NULL DEFAULT 0, locked_until timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(kind, normalized_value)
);
CREATE TABLE IF NOT EXISTS assistant_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id),
  name text NOT NULL DEFAULT 'Gerald', email text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS connected_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id), provider text NOT NULL,
  external_account_id text NOT NULL, encrypted_refresh_token jsonb, scopes text[] NOT NULL DEFAULT '{}', revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id, provider, external_account_id)
);
CREATE TABLE IF NOT EXISTS conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id), channel channel NOT NULL,
  external_thread_id text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id uuid NOT NULL REFERENCES conversations(id), provider_message_id text,
  sender_identity text NOT NULL, user_authored_text text NOT NULL, untrusted_content jsonb NOT NULL DEFAULT '[]', timestamp timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(provider_message_id)
);
CREATE TABLE IF NOT EXISTS attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), message_id uuid NOT NULL REFERENCES messages(id), filename text NOT NULL,
  mime_type text NOT NULL, byte_size integer NOT NULL, sha256 text NOT NULL, storage_ref text, status text NOT NULL,
  extracted_text text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS active_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id), channel channel NOT NULL,
  authentication auth_state NOT NULL DEFAULT 'unauthenticated', raw_turns jsonb NOT NULL DEFAULT '[]', compact_summary text,
  expires_at timestamptz NOT NULL, summary_expires_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id), parent_task_id uuid,
  title text NOT NULL, state task_state NOT NULL DEFAULT 'ACTIVE', required boolean NOT NULL DEFAULT true, goal text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS task_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), task_id uuid NOT NULL REFERENCES tasks(id), trigger_event_id text NOT NULL,
  from_state task_state, to_state task_state NOT NULL, data jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS profile_facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id), fact text NOT NULL,
  confidence real NOT NULL, source_id text NOT NULL, superseded_by uuid, deleted_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS episodes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id), summary text NOT NULL,
  source_id text NOT NULL, occurred_at timestamptz NOT NULL, deleted_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS entities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id), name text NOT NULL,
  entity_type text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS entity_aliases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), entity_id uuid NOT NULL REFERENCES entities(id), alias text NOT NULL
);
CREATE TABLE IF NOT EXISTS decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id), decision text NOT NULL,
  rationale text, source_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS memory_relationships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id), from_memory_id uuid NOT NULL,
  to_memory_id uuid NOT NULL, relationship text NOT NULL
);
CREATE TABLE IF NOT EXISTS documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id), provider text NOT NULL,
  external_id text NOT NULL, title text NOT NULL, source_url text, full_text text, updated_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS document_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), document_id uuid NOT NULL REFERENCES documents(id), ordinal integer NOT NULL,
  text text NOT NULL, search_text text NOT NULL, embedding vector(1536)
);
CREATE TABLE IF NOT EXISTS auth_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id), type text NOT NULL,
  challenge_hash text NOT NULL, expires_at timestamptz NOT NULL, consumed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS recovery_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id), verifier text NOT NULL,
  used_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS policy_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id), rule_id text NOT NULL,
  effect text NOT NULL, condition jsonb NOT NULL, is_active boolean NOT NULL DEFAULT true
);
CREATE TABLE IF NOT EXISTS tool_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), trigger_event_id text NOT NULL, tool_name text NOT NULL,
  input jsonb NOT NULL, output jsonb, status text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_type text NOT NULL, actor text NOT NULL, trigger_event_id text,
  sanitized_data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS action_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), trigger_event_id text NOT NULL, action text NOT NULL, target text NOT NULL,
  sanitized_parameters jsonb NOT NULL, authorization_basis text[] NOT NULL DEFAULT '{}', provider_identifiers text[] NOT NULL DEFAULT '{}',
  outcome text NOT NULL, reversal_metadata jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS notification_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id), kind text NOT NULL,
  trigger_at timestamptz NOT NULL, delivery_channel channel NOT NULL DEFAULT 'email', recipient text NOT NULL,
  quiet_hour_policy text NOT NULL, deduplication_key text NOT NULL, minimal_formatting_data jsonb NOT NULL,
  state notification_state NOT NULL DEFAULT 'PENDING', created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(deduplication_key)
);
CREATE TABLE IF NOT EXISTS webhook_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), provider text NOT NULL, provider_event_id text NOT NULL,
  state webhook_state NOT NULL, payload_hash text NOT NULL, received_at timestamptz NOT NULL DEFAULT now(), UNIQUE(provider, provider_event_id)
);
CREATE TABLE IF NOT EXISTS outbox_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), topic text NOT NULL, message_key text NOT NULL, payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), published_at timestamptz
);

CREATE INDEX IF NOT EXISTS messages_fts_idx ON messages USING gin (to_tsvector('simple', user_authored_text));
CREATE INDEX IF NOT EXISTS document_chunks_fts_idx ON document_chunks USING gin (to_tsvector('simple', search_text));
CREATE INDEX IF NOT EXISTS document_chunks_embedding_idx ON document_chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS audit_events_created_idx ON audit_events(created_at);

CREATE OR REPLACE FUNCTION prevent_audit_mutation() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'audit_events is append-only'; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS audit_events_immutable ON audit_events;
CREATE TRIGGER audit_events_immutable BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION prevent_audit_mutation();
