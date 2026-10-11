-- Keep edits to existing fields in the owning form's draft until atomic publication.
-- Published models, records and legacy shared-page drafts remain unchanged.
ALTER TABLE pages ADD COLUMN form_model jsonb;
ALTER TABLE pages ADD CONSTRAINT page_form_model_object
CHECK (form_model IS NULL OR jsonb_typeof(form_model) = 'object');
