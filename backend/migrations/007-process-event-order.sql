ALTER TABLE process_events ADD COLUMN sequence bigint GENERATED ALWAYS AS IDENTITY;
CREATE UNIQUE INDEX process_event_sequence ON process_events(sequence);
CREATE INDEX process_event_timeline ON process_events(process_id,sequence);
