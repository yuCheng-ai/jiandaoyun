CREATE TABLE configuration_events (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL,
  actor_id uuid NOT NULL REFERENCES users(id),
  resource_kind text NOT NULL CHECK(resource_kind IN ('data_object','page')),
  resource_id uuid NOT NULL,
  action text NOT NULL CHECK(action IN ('publish','discard_draft','archive','restore')),
  revision integer NOT NULL,
  detail jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX configuration_events_resource ON configuration_events(workspace_id,resource_kind,resource_id,created_at);
CREATE TRIGGER immutable_configuration_event BEFORE UPDATE OR DELETE ON configuration_events
FOR EACH ROW EXECUTE FUNCTION immutable_definition_version();
