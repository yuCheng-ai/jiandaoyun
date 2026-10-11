-- Unknown creation departments on existing records must stay unknown.
ALTER TABLE records ADD COLUMN created_department_ids uuid[];
ALTER TABLE records ADD CONSTRAINT records_workspace_identity UNIQUE(workspace_id,id);
CREATE INDEX records_creation_departments ON records USING gin(created_department_ids);
CREATE TABLE record_origins (
  record_id uuid PRIMARY KEY,
  workspace_id text NOT NULL,
  snapshot_id uuid NOT NULL REFERENCES migration_resource_snapshots(id),
  source_form_id text NOT NULL,
  source_record_id text NOT NULL,
  metadata jsonb NOT NULL,
  imported_by uuid NOT NULL REFERENCES users(id),
  imported_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(workspace_id,record_id) REFERENCES records(workspace_id,id)
);
CREATE FUNCTION validate_record_origin() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM migration_resource_snapshots s JOIN migration_batches b ON b.id=s.batch_id
    JOIN migration_resource_keys k ON k.workspace_id=b.workspace_id AND k.source_namespace=b.source_namespace
      AND k.kind='record' AND k.target_id=NEW.record_id
    WHERE s.id=NEW.snapshot_id AND b.workspace_id=NEW.workspace_id
      AND k.source_key=jsonb_build_array(NEW.source_form_id,NEW.source_record_id)::text
  ) THEN
    -- Canonical JSON keys use compact separators; compare as JSON instead.
    IF NOT EXISTS (
      SELECT 1 FROM migration_resource_snapshots s JOIN migration_batches b ON b.id=s.batch_id
      JOIN migration_resource_keys k ON k.workspace_id=b.workspace_id AND k.source_namespace=b.source_namespace
        AND k.kind='record' AND k.target_id=NEW.record_id
      WHERE s.id=NEW.snapshot_id AND b.workspace_id=NEW.workspace_id
        AND k.source_key::jsonb=jsonb_build_array(NEW.source_form_id,NEW.source_record_id)
    ) THEN RAISE EXCEPTION 'Record origin does not match reserved source identity'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER check_record_origin BEFORE INSERT ON record_origins FOR EACH ROW EXECUTE FUNCTION validate_record_origin();
CREATE TRIGGER immutable_record_origin BEFORE UPDATE OR DELETE ON record_origins FOR EACH ROW EXECUTE FUNCTION immutable_definition_version();
