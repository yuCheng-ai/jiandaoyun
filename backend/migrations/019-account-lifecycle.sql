ALTER TABLE users ADD COLUMN account_revision integer NOT NULL DEFAULT 1;

CREATE TABLE account_events (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL,
  actor_id uuid NOT NULL REFERENCES users(id),
  account_id uuid NOT NULL REFERENCES users(id),
  revision integer NOT NULL,
  action text NOT NULL CHECK (action IN ('created','updated')),
  detail jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(account_id, revision)
);
CREATE TRIGGER immutable_account_event BEFORE UPDATE OR DELETE ON account_events
FOR EACH ROW EXECUTE FUNCTION immutable_definition_version();
