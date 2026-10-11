CREATE TABLE record_permission_groups (
  definition_id uuid PRIMARY KEY REFERENCES definitions(id),
  revision integer NOT NULL CHECK (revision > 0),
  config jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE record_permission_group_events (
  id uuid PRIMARY KEY,
  definition_id uuid NOT NULL REFERENCES definitions(id),
  actor_id uuid NOT NULL REFERENCES users(id),
  revision integer NOT NULL,
  config jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (definition_id, revision)
);
CREATE TRIGGER immutable_record_permission_group_event BEFORE UPDATE OR DELETE ON record_permission_group_events
FOR EACH ROW EXECUTE FUNCTION immutable_definition_version();
