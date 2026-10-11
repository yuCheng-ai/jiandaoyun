CREATE TABLE historical_identities (
  id uuid PRIMARY KEY REFERENCES migration_identity_keys(historical_id),
  workspace_id text NOT NULL,
  source_namespace uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN ('member','department','role')),
  source_id text NOT NULL,
  name text NOT NULL,
  first_batch_id uuid NOT NULL REFERENCES migration_batches(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,source_namespace,kind,source_id),
  UNIQUE(id,workspace_id,kind),
  FOREIGN KEY(workspace_id,source_namespace,kind,source_id)
    REFERENCES migration_identity_keys(workspace_id,source_namespace,kind,source_id)
);

-- Creator identities have no authentication or authorization attributes.
CREATE TABLE record_principals (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL,
  user_id uuid REFERENCES users(id),
  historical_id uuid,
  kind text NOT NULL DEFAULT 'member' CHECK(kind='member'),
  CHECK ((user_id IS NOT NULL AND user_id=id AND historical_id IS NULL)
    OR (historical_id IS NOT NULL AND historical_id=id AND user_id IS NULL)),
  UNIQUE(workspace_id,id),
  FOREIGN KEY(historical_id,workspace_id,kind) REFERENCES historical_identities(id,workspace_id,kind)
);
INSERT INTO record_principals(id,workspace_id,user_id) SELECT id,workspace_id,id FROM users;

CREATE FUNCTION register_user_record_principal() RETURNS trigger AS $$
BEGIN
  INSERT INTO record_principals(id,workspace_id,user_id) VALUES(NEW.id,NEW.workspace_id,NEW.id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER user_record_principal AFTER INSERT ON users
FOR EACH ROW EXECUTE FUNCTION register_user_record_principal();

CREATE FUNCTION register_historical_record_principal() RETURNS trigger AS $$
BEGIN
  IF NEW.kind='member' THEN
    INSERT INTO record_principals(id,workspace_id,historical_id) VALUES(NEW.id,NEW.workspace_id,NEW.id);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER historical_record_principal AFTER INSERT ON historical_identities
FOR EACH ROW EXECUTE FUNCTION register_historical_record_principal();

-- Earlier confirmed preparations also have a durable historical name; no users are created.
INSERT INTO historical_identities(id,workspace_id,source_namespace,kind,source_id,name,first_batch_id,created_at)
SELECT DISTINCT ON (k.historical_id) k.historical_id,b.workspace_id,b.source_namespace,k.kind,k.source_id,
  i->>'name',b.id,COALESCE(b.confirmed_at,b.created_at)
FROM migration_batches b
CROSS JOIN LATERAL jsonb_array_elements(b.choices) c
CROSS JOIN LATERAL jsonb_array_elements(b.source->'identities') i
JOIN migration_identity_keys k ON k.kind=i->>'kind' AND k.source_id=i->>'sourceId'
WHERE b.state='identities_confirmed' AND c->>'mode'='historical'
  AND c->>'kind'=i->>'kind' AND c->>'sourceId'=i->>'sourceId'
  AND c->>'targetId'=k.historical_id::text
  AND k.workspace_id=b.workspace_id AND k.source_namespace=b.source_namespace
ORDER BY k.historical_id,b.confirmed_at,b.id;

ALTER TABLE records DROP CONSTRAINT records_created_by_fkey;
ALTER TABLE records ADD CONSTRAINT records_creator_principal_fkey
  FOREIGN KEY(workspace_id,created_by) REFERENCES record_principals(workspace_id,id);

CREATE TRIGGER immutable_historical_identity BEFORE UPDATE OR DELETE ON historical_identities
FOR EACH ROW EXECUTE FUNCTION immutable_definition_version();
CREATE TRIGGER immutable_record_principal BEFORE UPDATE OR DELETE ON record_principals
FOR EACH ROW EXECUTE FUNCTION immutable_definition_version();
