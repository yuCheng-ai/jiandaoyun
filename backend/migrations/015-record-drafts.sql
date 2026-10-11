ALTER TABLE records ADD COLUMN state text NOT NULL DEFAULT 'active' CHECK(state IN ('draft','active'));
CREATE INDEX records_by_state ON records(workspace_id,definition_id,state,created_at DESC) WHERE archived_at IS NULL;
