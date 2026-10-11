CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL,
  username text UNIQUE NOT NULL,
  name text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin','member')),
  password_hash text NOT NULL,
  active boolean NOT NULL DEFAULT true
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS definitions (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL,
  title text NOT NULL,
  draft jsonb NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  latest_version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS definition_versions (
  definition_id uuid NOT NULL REFERENCES definitions(id),
  version integer NOT NULL,
  title text NOT NULL,
  schema jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (definition_id,version)
);
CREATE OR REPLACE FUNCTION immutable_definition_version() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'Published definitions are immutable'; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS immutable_version ON definition_versions;
CREATE TRIGGER immutable_version BEFORE UPDATE OR DELETE ON definition_versions
FOR EACH ROW EXECUTE FUNCTION immutable_definition_version();
CREATE TABLE IF NOT EXISTS grants (
  definition_id uuid NOT NULL REFERENCES definitions(id),
  user_id uuid NOT NULL REFERENCES users(id),
  policy jsonb NOT NULL,
  PRIMARY KEY (definition_id,user_id)
);
CREATE TABLE IF NOT EXISTS records (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL,
  definition_id uuid NOT NULL,
  definition_version integer NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  values jsonb NOT NULL,
  cell_revisions jsonb NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (definition_id,definition_version) REFERENCES definition_versions(definition_id,version)
);
CREATE INDEX IF NOT EXISTS records_definition ON records(workspace_id,definition_id);
CREATE TABLE IF NOT EXISTS commands (
  actor_id uuid NOT NULL REFERENCES users(id),
  request_id uuid NOT NULL,
  request_hash text NOT NULL,
  resource_id uuid NOT NULL,
  PRIMARY KEY (actor_id,request_id)
);
CREATE TABLE IF NOT EXISTS record_events (
  id uuid PRIMARY KEY,
  record_id uuid NOT NULL REFERENCES records(id),
  actor_id uuid NOT NULL REFERENCES users(id),
  revision integer NOT NULL,
  changes jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS processes (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL,
  request_id uuid NOT NULL,
  request_hash text NOT NULL,
  spec jsonb NOT NULL,
  bindings jsonb NOT NULL,
  status text NOT NULL CHECK(status IN ('running','completed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,request_id)
);
CREATE TABLE IF NOT EXISTS tasks (
  id uuid PRIMARY KEY,
  process_id uuid NOT NULL REFERENCES processes(id),
  task_key text NOT NULL,
  assignee_id uuid NOT NULL REFERENCES users(id),
  record_id uuid NOT NULL REFERENCES records(id),
  spec jsonb NOT NULL,
  status text NOT NULL CHECK(status IN ('waiting','ready','completed')),
  completed_at timestamptz,
  UNIQUE(process_id,task_key)
);
