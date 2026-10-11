CREATE TABLE process_templates (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL,
  application_id uuid NOT NULL REFERENCES applications(id),
  draft jsonb NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  latest_version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX process_templates_app ON process_templates(workspace_id,application_id);
CREATE TABLE process_template_versions (
  template_id uuid NOT NULL REFERENCES process_templates(id),
  version integer NOT NULL,
  spec jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(template_id,version)
);
CREATE TRIGGER immutable_process_template_version BEFORE UPDATE OR DELETE ON process_template_versions
FOR EACH ROW EXECUTE FUNCTION immutable_definition_version();
ALTER TABLE processes ADD COLUMN template_id uuid;
ALTER TABLE processes ADD COLUMN template_version integer;
ALTER TABLE processes ADD COLUMN application_id uuid REFERENCES applications(id);
ALTER TABLE processes ADD COLUMN created_by uuid REFERENCES users(id);
ALTER TABLE processes ADD COLUMN checked_at timestamptz;
ALTER TABLE processes ADD COLUMN refresh_error text;
ALTER TABLE processes ADD CONSTRAINT process_template_version_ref FOREIGN KEY(template_id,template_version) REFERENCES process_template_versions(template_id,version);
ALTER TABLE tasks DROP CONSTRAINT tasks_status_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_status_check CHECK(status IN ('waiting','ready','blocked','completed'));
ALTER TABLE tasks ADD COLUMN reason text;
CREATE TABLE process_events (
  id uuid PRIMARY KEY,
  process_id uuid NOT NULL REFERENCES processes(id),
  task_id uuid REFERENCES tasks(id),
  actor_id uuid REFERENCES users(id),
  action text NOT NULL,
  detail text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX process_events_process ON process_events(process_id,created_at);
CREATE INDEX tasks_record_row ON tasks(record_id,row_id);
