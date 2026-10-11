ALTER TABLE definitions ADD COLUMN model_draft jsonb;
CREATE TABLE data_object_versions (
  definition_id uuid NOT NULL,
  version integer NOT NULL,
  model jsonb NOT NULL,
  PRIMARY KEY (definition_id,version),
  FOREIGN KEY (definition_id,version) REFERENCES definition_versions(definition_id,version)
);
CREATE TRIGGER immutable_data_model BEFORE UPDATE OR DELETE ON data_object_versions
FOR EACH ROW EXECUTE FUNCTION immutable_definition_version();
CREATE TABLE pages (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL,
  definition_id uuid NOT NULL REFERENCES definitions(id),
  definition_version integer NOT NULL,
  title text NOT NULL,
  draft jsonb NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  latest_version integer NOT NULL DEFAULT 0,
  legacy_default boolean NOT NULL DEFAULT false,
  managed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX default_page_per_definition ON pages(definition_id) WHERE legacy_default;
CREATE INDEX pages_by_workspace ON pages(workspace_id,definition_id);
CREATE TABLE page_versions (
  page_id uuid NOT NULL REFERENCES pages(id),
  version integer NOT NULL,
  title text NOT NULL,
  definition_id uuid NOT NULL,
  definition_version integer NOT NULL,
  schema jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (page_id,version),
  FOREIGN KEY (definition_id,definition_version) REFERENCES data_object_versions(definition_id,version)
);
CREATE TRIGGER immutable_page_version BEFORE UPDATE OR DELETE ON page_versions
FOR EACH ROW EXECUTE FUNCTION immutable_definition_version();
