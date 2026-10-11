import { randomUUID } from "node:crypto";
import { separateFormSchema, type FormSchema } from "@platform/contracts";
import type { Database, Transaction } from "./database";

export async function storeModelDraft(tx: Transaction, definition: { id: string; workspace_id: string; title: string }, schema: FormSchema, managePage: boolean) {
  const { model, page } = separateFormSchema(schema);
  await tx.query("UPDATE definitions SET model_draft=$2 WHERE id=$1", [definition.id, model]);
  if (!managePage) return;
  const revision = (await tx.query("SELECT revision FROM definitions WHERE id=$1", [definition.id])).rows[0].revision;
  const old = (await tx.query("SELECT * FROM pages WHERE definition_id=$1 AND legacy_default FOR UPDATE", [definition.id])).rows[0];
  if (!old) await tx.query("INSERT INTO pages(id,workspace_id,definition_id,definition_version,title,draft,legacy_default,managed,initial_model,initial_model_revision) VALUES($1,$2,$3,0,$4,$5,true,true,$6,$7)", [randomUUID(), definition.workspace_id, definition.id, definition.title, page, model, revision]);
  else if (old.managed && !old.archived_at) await tx.query("UPDATE pages SET title=$2,draft=$3,initial_model=CASE WHEN definition_version=0 THEN $4::jsonb ELSE NULL END,initial_model_revision=CASE WHEN definition_version=0 THEN $5::integer ELSE NULL END,revision=revision+1 WHERE id=$1", [old.id, definition.title, page, model, revision]);
}
export async function storeModelVersion(tx: Transaction, definitionId: string, version: number, schema: FormSchema, managePage: boolean, pageTitle?: string) {
  const { model, page } = separateFormSchema(schema);
  await tx.query("INSERT INTO data_object_versions(definition_id,version,model) VALUES($1,$2,$3)", [definitionId, version, model]);
  if (!managePage) return;
  const old = (await tx.query("SELECT * FROM pages WHERE definition_id=$1 AND legacy_default AND managed AND archived_at IS NULL FOR UPDATE", [definitionId])).rows[0];
  if (!old) return;
  const next = old.latest_version + 1;
  await tx.query("INSERT INTO page_versions(page_id,version,title,definition_id,definition_version,schema) VALUES($1,$2,$3,$4,$5,$6)", [old.id, next, pageTitle ?? old.title, definitionId, version, page]);
  await tx.query("UPDATE pages SET definition_version=$2,latest_version=$3,draft=$4,initial_model=NULL,initial_model_revision=NULL,revision=revision+1 WHERE id=$1", [old.id, version, next, page]);
}

/** Repeatable upgrade of legacy immutable schemas; published rows and records are untouched. */
export async function upgradeDataProjection(db: Database) {
  await db.transaction(async tx => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended(current_database() || '/' || current_schema() || '/data-pages',0))");
    const definitions = (await tx.query("SELECT * FROM definitions WHERE model_draft IS NULL ORDER BY id FOR UPDATE")).rows;
    for (const definition of definitions) {
      await storeModelDraft(tx, definition, definition.draft, true);
      const versions = (await tx.query("SELECT * FROM definition_versions WHERE definition_id=$1 ORDER BY version", [definition.id])).rows;
      for (const version of versions) {
        await storeModelVersion(tx, definition.id, version.version, version.schema, true, version.title);
      }
      const draft = separateFormSchema(definition.draft).page;
      await tx.query("UPDATE pages SET draft=$2,title=$3 WHERE definition_id=$1 AND legacy_default AND managed AND archived_at IS NULL", [definition.id, draft, definition.title]);
    }
  });
}
