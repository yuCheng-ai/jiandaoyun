ALTER TABLE pages ADD COLUMN additions jsonb NOT NULL DEFAULT '[]';
ALTER TABLE pages ADD COLUMN base_definition_revision integer;
