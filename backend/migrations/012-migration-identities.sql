CREATE TABLE migration_batches (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL,
  source_namespace uuid NOT NULL,
  source_application_id text NOT NULL,
  source jsonb NOT NULL,
  choices jsonb NOT NULL DEFAULT '[]',
  revision integer NOT NULL DEFAULT 1,
  state text NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','identities_confirmed')),
  confirmed_token text,
  confirmed_at timestamptz,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,source_namespace,source_application_id)
);
CREATE TABLE migration_identity_keys (
  workspace_id text NOT NULL,
  source_namespace uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN ('member','department','role')),
  source_id text NOT NULL,
  historical_id uuid NOT NULL UNIQUE,
  PRIMARY KEY(workspace_id,source_namespace,kind,source_id)
);
CREATE TABLE migration_batch_events (
  id uuid PRIMARY KEY,
  batch_id uuid NOT NULL REFERENCES migration_batches(id),
  actor_id uuid NOT NULL REFERENCES users(id),
  revision integer NOT NULL,
  action text NOT NULL CHECK(action IN ('create','save','refresh_source','confirm_identities','reopen')),
  detail jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX migration_batches_namespace ON migration_batches(workspace_id,source_namespace);
CREATE TRIGGER immutable_migration_event BEFORE UPDATE OR DELETE ON migration_batch_events
FOR EACH ROW EXECUTE FUNCTION immutable_definition_version();
