CREATE TABLE collection_rules (
  definition_id uuid PRIMARY KEY REFERENCES definitions(id),
  revision integer NOT NULL CHECK (revision > 0),
  rules jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE collection_rule_events (
  id uuid PRIMARY KEY,
  definition_id uuid NOT NULL REFERENCES definitions(id),
  actor_id uuid NOT NULL REFERENCES users(id),
  revision integer NOT NULL,
  rules jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (definition_id, revision)
);
CREATE TRIGGER immutable_collection_rule_event BEFORE UPDATE OR DELETE ON collection_rule_events
FOR EACH ROW EXECUTE FUNCTION immutable_definition_version();
CREATE INDEX records_collection_count ON records (definition_id, created_by)
WHERE state='active' AND archived_at IS NULL;
