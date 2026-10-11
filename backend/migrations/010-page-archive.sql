ALTER TABLE pages ADD COLUMN archived_at timestamptz;
ALTER TABLE pages ADD COLUMN archived_by uuid REFERENCES users(id);
CREATE INDEX pages_by_archive ON pages(workspace_id,archived_at);
