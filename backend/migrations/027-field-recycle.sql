ALTER TABLE pages ADD COLUMN field_trash jsonb NOT NULL DEFAULT '[]'
  CHECK (jsonb_typeof(field_trash) = 'array');
