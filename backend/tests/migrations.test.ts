import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool } from "pg";

process.env.DATABASE_SCHEMA = `platform_test_${randomUUID().replaceAll("-", "")}`;
const { Database } = require("../src/database") as typeof import("../src/database");
const { config } = require("../src/config") as typeof import("../src/config");
const db = new Database(), second = new Database();
const definitionId = randomUUID(), actorId = randomUUID(), recordId = randomUUID();
before(async () => {
  // A database created by the previous M1 startup has tables and data but no ledger.
  await db.query(`CREATE SCHEMA "${config.schema}"`);
  await db.query(await readFile(resolve(__dirname, "../../migrations/001-platform.sql"), "utf8"));
  await db.query("INSERT INTO users(id,workspace_id,username,name,role,password_hash) VALUES($1,'local','preserved','保留成员','admin','test-only')", [actorId]);
  await db.query("INSERT INTO definitions(id,workspace_id,title,draft,latest_version) VALUES($1,'local','既有表单',$2,1)", [definitionId, { version: 1, fields: [], settings: { rules: [] } }]);
  await db.query("INSERT INTO definition_versions(definition_id,version,title,schema) SELECT id,1,title,draft FROM definitions WHERE id=$1", [definitionId]);
  await db.query("INSERT INTO records(id,workspace_id,definition_id,definition_version,values,cell_revisions,created_by) VALUES($1,'local',$2,1,$3,$4,$5)", [recordId, definitionId, { preserved: "既有记录" }, { preserved: 1 }, actorId]);
});
after(async () => {
  await db.onModuleDestroy(); await second.onModuleDestroy();
  const pool = new Pool({ connectionString: config.databaseUrl });
  if (!/^platform_test_[a-f0-9]+$/.test(config.schema)) throw new Error("Unsafe cleanup schema");
  await pool.query(`DROP SCHEMA "${config.schema}" CASCADE`); await pool.end();
});
test("legacy M1 database upgrades without replacing its records or published versions", async () => {
  await db.migrate();
  assert.equal((await db.query("SELECT values FROM records WHERE id=$1", [recordId])).rows[0].values.preserved, "既有记录");
  assert.equal((await db.query("SELECT count(*)::integer AS count FROM definition_versions WHERE definition_id=$1", [definitionId])).rows[0].count, 1);
  assert.ok((await db.query("SELECT name FROM migration_history")).rows.some(row => row.name === "001-platform.sql"));
});
test("concurrent and repeated startup preserves a single immutable migration receipt", async () => {
  const before = (await db.query("SELECT * FROM migration_history ORDER BY name")).rows;
  await Promise.all([db.migrate(), second.migrate()]);
  assert.deepEqual((await db.query("SELECT * FROM migration_history ORDER BY name")).rows, before);
  await assert.rejects(db.query("UPDATE definition_versions SET title='changed' WHERE definition_id=$1", [definitionId]), /immutable/);
});
test("a changed applied migration stops upgrade and preserves existing data", async () => {
  const receipt = (await db.query("SELECT checksum FROM migration_history WHERE name='001-platform.sql'")).rows[0];
  await db.query("UPDATE migration_history SET checksum='deliberate-test-mismatch' WHERE name='001-platform.sql'");
  await assert.rejects(db.migrate(), /Applied migration was changed/);
  assert.equal((await db.query("SELECT values FROM records WHERE id=$1", [recordId])).rows[0].values.preserved, "既有记录");
  await db.query("UPDATE migration_history SET checksum=$1 WHERE name='001-platform.sql'", [receipt.checksum]);
});
