CREATE TABLE organization_directories (
  workspace_id text PRIMARY KEY,
  source_namespace uuid NOT NULL,
  revision integer NOT NULL,
  spec jsonb NOT NULL,
  identities jsonb NOT NULL,
  original_spec jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE directory_events (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES organization_directories(workspace_id),
  actor_id uuid NOT NULL REFERENCES users(id),
  revision integer NOT NULL,
  spec jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,revision)
);
CREATE TRIGGER immutable_directory_event BEFORE UPDATE OR DELETE ON directory_events
FOR EACH ROW EXECUTE FUNCTION immutable_definition_version();
