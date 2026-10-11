-- Version zero is an unpublished model, not an immutable data version.
-- Retain its actual baseline with the page before a sibling or the data editor publishes.
ALTER TABLE pages ADD COLUMN initial_model jsonb;
ALTER TABLE pages ADD COLUMN initial_model_revision integer;
UPDATE pages p SET initial_model=d.model_draft,initial_model_revision=d.revision
FROM definitions d WHERE p.definition_id=d.id AND p.definition_version=0
  AND d.latest_version=0 AND d.model_draft IS NOT NULL;
-- Do not infer a missing historical baseline from a later published model.
ALTER TABLE pages ADD CONSTRAINT page_initial_model_pair
CHECK ((initial_model IS NULL AND initial_model_revision IS NULL)
  OR (jsonb_typeof(initial_model)='object' AND initial_model_revision>0));
