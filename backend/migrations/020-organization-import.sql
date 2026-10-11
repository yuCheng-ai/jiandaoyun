ALTER TABLE migration_batch_events DROP CONSTRAINT migration_batch_events_action_check;
ALTER TABLE migration_batch_events ADD CONSTRAINT migration_batch_events_action_check
CHECK(action IN ('create','save','refresh_source','confirm_identities','reopen','import_organization'));
