CREATE TABLE migration_resource_keys (
  workspace_id text NOT NULL,
  source_namespace uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN ('application','data_object','page','record','row')),
  source_key text NOT NULL,
  target_id uuid NOT NULL UNIQUE,
  PRIMARY KEY(workspace_id,source_namespace,kind,source_key)
);
CREATE TABLE migration_resource_snapshots (
  id uuid PRIMARY KEY,
  batch_id uuid NOT NULL REFERENCES migration_batches(id),
  revision integer NOT NULL,
  batch_revision integer NOT NULL,
  source_fingerprint text NOT NULL,
  source_digest text NOT NULL,
  identity_review_token text NOT NULL,
  payload jsonb NOT NULL,
  projection jsonb NOT NULL,
  plan jsonb NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(batch_id,revision)
);
CREATE TRIGGER immutable_migration_resource_snapshot BEFORE UPDATE OR DELETE ON migration_resource_snapshots
FOR EACH ROW EXECUTE FUNCTION immutable_definition_version();
