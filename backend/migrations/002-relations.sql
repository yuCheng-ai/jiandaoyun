ALTER TABLE records ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS subform_id text;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS row_id uuid;

CREATE TABLE relation_definitions (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL,
  source_definition_id uuid NOT NULL REFERENCES definitions(id),
  target_definition_id uuid NOT NULL REFERENCES definitions(id),
  draft jsonb NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  latest_version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX relation_definitions_source ON relation_definitions(workspace_id,source_definition_id);
CREATE INDEX relation_definitions_target ON relation_definitions(workspace_id,target_definition_id);
CREATE TABLE relation_versions (
  relation_id uuid NOT NULL REFERENCES relation_definitions(id),
  version integer NOT NULL,
  spec jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(relation_id,version)
);
CREATE TRIGGER immutable_relation_version BEFORE UPDATE OR DELETE ON relation_versions
FOR EACH ROW EXECUTE FUNCTION immutable_definition_version();

CREATE TABLE record_links (
  id uuid PRIMARY KEY,
  relation_id uuid NOT NULL,
  relation_version integer NOT NULL,
  source_record_id uuid NOT NULL REFERENCES records(id),
  target_record_id uuid NOT NULL REFERENCES records(id),
  source_row_id uuid,
  target_definition_version integer NOT NULL,
  snapshot jsonb NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(relation_id,relation_version) REFERENCES relation_versions(relation_id,version),
  UNIQUE NULLS NOT DISTINCT(relation_id,source_record_id,source_row_id,target_record_id)
);
CREATE INDEX record_links_target ON record_links(target_record_id);
CREATE INDEX record_links_source ON record_links(source_record_id,source_row_id);
CREATE TABLE relation_events (
  id uuid PRIMARY KEY,
  relation_id uuid NOT NULL REFERENCES relation_definitions(id),
  source_record_id uuid NOT NULL REFERENCES records(id),
  target_record_id uuid NOT NULL REFERENCES records(id),
  source_row_id uuid,
  actor_id uuid NOT NULL REFERENCES users(id),
  action text NOT NULL CHECK(action IN ('link','unlink')),
  created_at timestamptz NOT NULL DEFAULT now()
);
