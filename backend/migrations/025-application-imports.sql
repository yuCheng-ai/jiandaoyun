ALTER TABLE applications ADD COLUMN appearance jsonb NOT NULL DEFAULT '{}';
ALTER TABLE pages ADD COLUMN folder text NOT NULL DEFAULT '';
CREATE TABLE application_imports (
  application_id uuid PRIMARY KEY REFERENCES applications(id),
  workspace_id text NOT NULL,
  batch_id uuid NOT NULL UNIQUE REFERENCES migration_batches(id),
  snapshot_id uuid NOT NULL UNIQUE REFERENCES migration_resource_snapshots(id),
  source_namespace uuid NOT NULL,
  source_application_id text NOT NULL,
  source_digest text NOT NULL,
  imported_by uuid NOT NULL REFERENCES users(id),
  imported_at timestamptz NOT NULL DEFAULT now(),
  counts jsonb NOT NULL,
  UNIQUE(workspace_id,source_namespace,source_application_id)
);
CREATE TRIGGER immutable_application_import BEFORE UPDATE OR DELETE ON application_imports
FOR EACH ROW EXECUTE FUNCTION immutable_definition_version();
