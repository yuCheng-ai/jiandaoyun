CREATE TABLE record_views (
  definition_id uuid PRIMARY KEY REFERENCES definitions(id),
  revision integer NOT NULL,
  settings jsonb NOT NULL
);
CREATE TABLE record_view_events (
  id uuid PRIMARY KEY,
  definition_id uuid NOT NULL REFERENCES definitions(id),
  actor_id uuid NOT NULL REFERENCES users(id),
  revision integer NOT NULL,
  settings jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(definition_id, revision)
);
CREATE TRIGGER immutable_record_view_event BEFORE UPDATE OR DELETE ON record_view_events
FOR EACH ROW EXECUTE FUNCTION immutable_definition_version();
