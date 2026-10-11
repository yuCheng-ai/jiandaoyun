CREATE TABLE applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL,
  title text NOT NULL,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX one_default_application ON applications(workspace_id) WHERE is_default;
INSERT INTO applications(workspace_id,title,is_default)
SELECT workspace_id,'协作应用',true FROM (SELECT workspace_id FROM users UNION SELECT workspace_id FROM definitions) existing;
ALTER TABLE definitions ADD COLUMN application_id uuid REFERENCES applications(id);
UPDATE definitions d SET application_id=a.id FROM applications a WHERE a.workspace_id=d.workspace_id AND a.is_default;
ALTER TABLE definitions ALTER COLUMN application_id SET NOT NULL;
CREATE INDEX definitions_by_application ON definitions(application_id);
