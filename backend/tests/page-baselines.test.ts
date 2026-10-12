import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pageForModel, separateFormSchema, type FormSchema } from "@platform/contracts";
import { harness, field, schema } from "./helpers";

const h = harness();
before(() => h.start()); after(() => h.close());
const model = (...fields: ReturnType<typeof field>[]) => separateFormSchema(schema(...fields) as unknown as FormSchema).model;
async function draft(title: string) {
  const editor = await h.request("/pages/new-business", "POST", { title, requestId: randomUUID() }, "admin", 201);
  const additions = model(field("inspection", "subform", { children: [field("result")] }));
  const saved = await h.request(`/pages/${editor.draft.id}`, "PUT", { ...editor.draft, expectedRevision: editor.draft.revision, baseDefinitionRevision: editor.object.revision,
    additions: additions.fields.map(field => ({ field })), schema: pageForModel(additions) });
  return { ...editor, draft: saved };
}
test("a first page retains its initial model and new columns when data management publishes first", async () => {
  const original = await draft("先建页面后发布数据");
  const object = await h.request(`/data-objects/${original.object.id}`, "PUT", { ...original.object, expectedRevision: original.object.revision, model: model(field("name")) });
  await h.request(`/data-objects/${object.id}/publish`, "POST", { expectedRevision: object.revision }, "admin", 201);
  const reopened = await h.request(`/pages/${original.draft.id}/editor`);
  assert.deepEqual(reopened.model, original.model);
  assert.deepEqual(reopened.draft, original.draft);
  assert.equal(reopened.object.latestVersion, 1);
  await h.restart();
  assert.deepEqual(await h.request(`/pages/${original.draft.id}/editor`), reopened);
});
test("a stale initial draft saves safely and explicitly adopts the published model before publication", async () => {
  const original = await draft("草稿先保留后采用");
  const object = await h.request(`/data-objects/${original.object.id}`, "PUT", { ...original.object, expectedRevision: original.object.revision, model: model(field("name")) });
  await h.request(`/data-objects/${object.id}/publish`, "POST", { expectedRevision: object.revision }, "admin", 201);
  let page = await h.request(`/pages/${original.draft.id}`, "PUT", { ...original.draft, expectedRevision: original.draft.revision, title: "修改保留", initial_model: object.model, initial_model_revision: 3, baseDefinitionRevision: 3 });
  assert.equal((await h.request(`/pages/${page.id}/editor`)).model.fields.length, 0);
  const conflict = await h.request(`/pages/${page.id}/publish-preview`, "POST", { expectedRevision: page.revision }, "admin", 409);
  assert.match(conflict.message, /表单字段.*已保留/);
  await h.request(`/pages/${page.id}/publish`, "POST", { expectedRevision: page.revision }, "admin", 409);
  const latest = await h.request(`/data-objects/${object.id}/published-model`);
  page = await h.request(`/pages/${page.id}`, "PUT", { ...page, expectedRevision: page.revision, definitionVersion: latest.object.latestVersion, baseDefinitionRevision: latest.object.revision });
  const impact = await h.request(`/pages/${page.id}/publish-preview`, "POST", { expectedRevision: page.revision }, "admin", 201);
  assert.equal(impact.toDataVersion, 2);
  const published = await h.request(`/pages/${page.id}/publish`, "POST", { expectedRevision: page.revision, impactToken: impact.token }, "admin", 201);
  assert.equal(published.definitionVersion, 2);
  const result = await h.request(`/pages/${page.id}/editor`);
  assert.deepEqual(result.model.fields.map((f: any) => f.id), ["name", "inspection"]);
  assert.deepEqual(result.draft.schema.controls.map((c: any) => c.binding.fieldId), ["inspection"]);
  assert.equal(result.draft.additions.length, 0);
});
test("another initial page can publish first without making its sibling unreadable or losing its fields", async () => {
  const original = await draft("并行初始页面");
  const firstModel = model(field("other"));
  const sibling = await h.request("/pages", "POST", { title: "先发布页面", definitionId: original.object.id, definitionVersion: 0, baseDefinitionRevision: original.object.revision,
    schema: pageForModel(firstModel), additions: firstModel.fields.map(field => ({ field })) }, "admin", 201);
  await h.request(`/pages/${sibling.id}/publish`, "POST", { expectedRevision: sibling.revision }, "admin", 201);
  const reopened = await h.request(`/pages/${original.draft.id}/editor`);
  assert.deepEqual(reopened.model, original.model);
  assert.deepEqual(reopened.draft.additions, original.draft.additions);
  const pending = await h.request(`/data-objects/${original.object.id}/pending-page-fields`);
  assert.equal(pending.pages.length, 1); assert.equal(pending.pages[0].fields[1].parentName, "inspection");
  const saved = await h.request(`/pages/${original.draft.id}`, "PUT", { ...original.draft, expectedRevision: original.draft.revision, title: "继续编辑" });
  assert.equal(saved.title, "继续编辑");
  await h.request(`/pages/${saved.id}/publish`, "POST", { expectedRevision: saved.revision }, "admin", 409);
});
test("initial data constraints stay pinned through data draft edits and archive/restore", async () => {
  const base = model(field("amount", "number", { max: 10 }), field("lines", "subform", { children: [field("item")] }));
  const object = await h.request("/data-objects", "POST", { title: "初始字段约束", model: base }, "admin", 201);
  let page = await h.request("/pages", "POST", { title: "原规则页面", definitionId: object.id, definitionVersion: 0, schema: pageForModel(base) }, "admin", 201);
  const changed = structuredClone(object.model); changed.fields[0].settings.max = 20; changed.fields[1].name = "改名明细";
  await h.request(`/data-objects/${object.id}`, "PUT", { ...object, model: changed, expectedRevision: object.revision });
  assert.deepEqual((await h.request(`/pages/${page.id}/editor`)).model, object.model);
  for (const action of ["archive", "restore"]) {
    const impact = await h.request(`/pages/${page.id}/lifecycle-preview`, "POST", { expectedRevision: page.revision, action }, "admin", 201);
    page = await h.request(`/pages/${page.id}/${action}`, "POST", { expectedRevision: page.revision, impactToken: impact.token }, "admin", 201);
    assert.deepEqual((await h.request(`/pages/${page.id}/editor`)).model, object.model);
  }
  await h.request(`/pages/${page.id}/publish`, "POST", { expectedRevision: page.revision }, "admin", 409);
  await h.request(`/pages/${page.id}/editor`, "GET", undefined, "editor", 403);
});
test("publishing an initial model with reused fields and no page additions creates both first versions atomically", async () => {
  const object = await h.request("/data-objects", "POST", { title: "初始数据直接发布", model: model(field("name")) }, "admin", 201);
  const page = await h.request("/pages", "POST", { title: "复用初始字段", definitionId: object.id, definitionVersion: 0, schema: pageForModel(object.model) }, "admin", 201);
  const impact = await h.request(`/pages/${page.id}/publish-preview`, "POST", { expectedRevision: page.revision }, "admin", 201);
  assert.equal(impact.toDataVersion, 1); assert.deepEqual(impact.newFields.map((f: any) => f.id), ["name"]);
  await h.db.query("CREATE FUNCTION reject_initial_page() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'deliberate page version failure'; END; $$ LANGUAGE plpgsql");
  await h.db.query("CREATE TRIGGER reject_initial_page BEFORE INSERT ON page_versions FOR EACH ROW EXECUTE FUNCTION reject_initial_page()");
  try {
    await h.request(`/pages/${page.id}/publish`, "POST", { expectedRevision: page.revision, impactToken: impact.token }, "admin", 500);
    assert.equal((await h.request(`/data-objects/${object.id}/draft`)).latestVersion, 0);
    assert.deepEqual((await h.request(`/pages/${page.id}/editor`)).draft, page);
  } finally { await h.db.query("DROP TRIGGER reject_initial_page ON page_versions"); }
  const published = await h.request(`/pages/${page.id}/publish`, "POST", { expectedRevision: page.revision, impactToken: impact.token }, "admin", 201);
  assert.equal(published.definitionVersion, 1);
  assert.equal((await h.request(`/data-objects/${object.id}/draft`)).latestVersion, 1);
  assert.equal((await h.db.query("SELECT initial_model FROM pages WHERE id=$1", [page.id])).rows[0].initial_model, null);
});
test("migration retains known initial models but does not invent missing history from a published model", async () => {
  const retained = await draft("迁移保留初始模型"), missing = await draft("未知原始基线");
  const object = await h.request(`/data-objects/${missing.object.id}`, "PUT", { ...missing.object, expectedRevision: missing.object.revision, model: model(field("later")) });
  await h.request(`/data-objects/${object.id}/publish`, "POST", { expectedRevision: object.revision }, "admin", 201);
  const client = await h.db.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("ALTER TABLE pages DROP CONSTRAINT page_initial_model_pair, DROP COLUMN initial_model, DROP COLUMN initial_model_revision");
    await client.query(await readFile(resolve(__dirname, "../../migrations/011-page-initial-model.sql"), "utf8"));
    const row = (await client.query("SELECT initial_model,initial_model_revision FROM pages WHERE id=$1", [retained.draft.id])).rows[0];
    assert.deepEqual(row.initial_model, retained.model); assert.equal(row.initial_model_revision, retained.object.revision);
    assert.equal((await client.query("SELECT initial_model FROM pages WHERE id=$1", [missing.draft.id])).rows[0].initial_model, null);
  } finally { await client.query("ROLLBACK"); client.release(); }
});
