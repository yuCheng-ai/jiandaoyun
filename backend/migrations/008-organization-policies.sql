CREATE TABLE workspace_organizations (
  workspace_id text PRIMARY KEY,
  revision integer NOT NULL DEFAULT 1,
  spec jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE subject_grants (
  definition_id uuid NOT NULL REFERENCES definitions(id),
  subject_kind text NOT NULL CHECK(subject_kind IN ('department','role')),
  subject_id uuid NOT NULL,
  include_children boolean NOT NULL DEFAULT false,
  policy jsonb NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  PRIMARY KEY(definition_id,subject_kind,subject_id)
);
CREATE TABLE organization_events (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL,
  actor_id uuid NOT NULL REFERENCES users(id),
  revision integer NOT NULL,
  spec jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,revision)
);
