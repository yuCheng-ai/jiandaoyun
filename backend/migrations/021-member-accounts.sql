CREATE TABLE member_accounts (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL,
  source_namespace uuid NOT NULL,
  member_id text NOT NULL,
  member_name text NOT NULL,
  member_number text NOT NULL,
  account_id uuid NOT NULL REFERENCES users(id),
  revision integer NOT NULL DEFAULT 1,
  UNIQUE(workspace_id, source_namespace, member_id),
  UNIQUE(workspace_id, source_namespace, account_id)
);

CREATE TABLE member_account_events (
  id uuid PRIMARY KEY,
  link_id uuid NOT NULL REFERENCES member_accounts(id),
  actor_id uuid NOT NULL REFERENCES users(id),
  revision integer NOT NULL,
  detail jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(link_id, revision)
);
CREATE TRIGGER immutable_member_account_event BEFORE UPDATE OR DELETE ON member_account_events
FOR EACH ROW EXECUTE FUNCTION immutable_definition_version();
