import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pageForModel, separateFormSchema, type FormSchema } from "@platform/contracts";
import { harness, field, schema } from "./helpers";
const h = harness();
before(() => h.start()); after(() => h.close());
const addition = (id: string, label = id, children?: any[]) => separateFormSchema(schema(field(id, children ? "subform" : "text", { label, defaultValue: children ? [] : "不要泄露默认值", children: children || [] })) as unknown as FormSchema).model.fields[0]!;
const object = (id: string) => h.request(`/data-objects/${id}/draft`);
const pending = (id: string) => h.request(`/data-objects/${id}/pending-page-fields`);
async function addPage(definition: any, title: string, additions: any[]) {
  const merged = structuredClone(definition.model);
  for (const value of additions) (value.parentId ? merged.fields.find((f: any) => f.id === value.parentId).children : merged.fields).push(value.field);
  return h.request("/pages", "POST", { title, definitionId: definition.id, definitionVersion: definition.latestVersion, baseDefinitionRevision: definition.revision, additions, schema: pageForModel(merged) }, "admin", 201);
}
test("data management lists saved new fields with page and row ownership, without publishing or exposing configuration values", async () => {
  const def = await h.definition("待发布汇总", schema(field("name"), field("lines", "subform", { children: [field("item")] })));
  const original = await object(def.id);
  const page = await addPage(original, "质检页", [{ field: addition("result", "检验结论") }, { parentId: "lines", field: addition("note", "明细备注") }, { field: addition("extra", "补充明细", [field("count", "number", { label: "补充数量" })]) }]);
  const result = await pending(def.id);
  assert.equal(result.pages.length, 1); assert.equal(result.pages[0].id, page.id);
  assert.deepEqual(result.pages[0].fields.map((f: any) => [f.id, f.parentName]), [["result", undefined], ["note", "lines"], ["extra", undefined], ["count", "补充明细"]]);
  assert.deepEqual(result.pages[0].warnings, []);
  assert.ok(!JSON.stringify(result).includes("不要泄露默认值"));
  assert.deepEqual(await object(def.id), original);
  const draft = await h.request(`/pages/${page.id}/draft`);
  draft.additions = draft.additions.filter((a: any) => a.field.id !== "result"); draft.schema.controls = draft.schema.controls.filter((c: any) => c.binding.fieldId !== "result");
  const saved = await h.request(`/pages/${page.id}`, "PUT", { ...draft, expectedRevision: draft.revision });
  assert.equal((await pending(def.id)).pages[0].fields.some((f: any) => f.id === "result"), false);
  await h.request(`/pages/${page.id}/publish`, "POST", { expectedRevision: saved.revision }, "admin", 201);
  assert.deepEqual((await pending(def.id)).pages, []);
  assert.equal((await object(def.id)).model.fields.some((f: any) => f.id === "extra"), true);
});
test("concurrent page additions report duplicate names and model changes without combining their identities", async () => {
  const def = await h.definition("并行编辑", schema(field("name")));
  const baseline = await object(def.id);
  const first = await addPage(baseline, "甲页面", [{ field: addition("a", "结论") }]);
  const second = await addPage(baseline, "乙页面", [{ field: addition("b", "结论") }]);
  let result = await pending(def.id);
  assert.ok(result.pages.every((p: any) => p.warnings.some((w: string) => w.includes("请确认是否需要复用"))));
  assert.equal(result.pages[0].fields[0].id, "a"); assert.equal(result.pages[1].fields[0].id, "b");
  await h.request(`/pages/${first.id}/publish`, "POST", { expectedRevision: first.revision }, "admin", 201);
  result = await pending(def.id);
  assert.equal(result.pages.length, 1); assert.equal(result.pages[0].id, second.id);
  assert.ok(result.pages[0].warnings.some((w: string) => w.includes("数据结构已变化")));
  assert.ok(result.pages[0].warnings.some((w: string) => w.includes("已存在于当前数据")));
  const latest = await object(def.id); latest.title = "另有数据草稿";
  await h.request(`/data-objects/${def.id}`, "PUT", { ...latest, expectedRevision: latest.revision });
  assert.ok((await pending(def.id)).pages[0].warnings.some((w: string) => w.includes("另有未发布修改")));
});
test("abandoning a saved page draft restores the published binding and layout while preserving shared model drafts, records and other pages", async () => {
  const def = await h.definition("页面放弃", schema(field("name")));
  const baseline = await object(def.id), page = (await h.request(`/pages?definitionId=${def.id}`))[0];
  const original = await h.request(`/pages/${page.id}/editor`);
  const record = await h.record(def.id, { name: "业务值保留" });
  const sibling = await addPage(baseline, "其他页面", [{ field: addition("other") }]);
  const newField = addition("pending");
  const edited = await h.request(`/pages/${page.id}`, "PUT", { ...original.draft, title: "待放弃标题", expectedRevision: original.draft.revision, baseDefinitionRevision: baseline.revision, additions: [{ field: newField }], schema: { ...pageForModel({ ...baseline.model, fields: [...baseline.model.fields, newField] }), settings: { ...original.draft.schema.settings, layout: 2 } } });
  const modelDraft = await h.request(`/data-objects/${def.id}`, "PUT", { ...baseline, title: "共享数据草稿保留", expectedRevision: baseline.revision });
  await h.request(`/pages/${page.id}/discard-draft`, "POST", { expectedRevision: original.draft.revision }, "admin", 409);
  const restored = await h.request(`/pages/${page.id}/discard-draft`, "POST", { expectedRevision: edited.revision }, "admin", 201);
  assert.equal(restored.draft.title, original.draft.title); assert.deepEqual(restored.draft.schema, original.draft.schema);
  assert.equal(restored.draft.revision, edited.revision + 1); assert.deepEqual(restored.draft.additions, []);
  assert.deepEqual(restored.object, modelDraft); assert.deepEqual(restored.model, original.model);
  assert.deepEqual((await h.request(`/records/${record.record.id}`)).record, record.record);
  assert.deepEqual(await h.request(`/pages/${sibling.id}/draft`), sibling);
  assert.equal((await pending(def.id)).pages.length, 1);
  const event = (await h.db.query("SELECT * FROM configuration_events WHERE resource_id=$1 AND action='discard_draft'", [page.id])).rows[0];
  assert.deepEqual(event.detail, { restoredVersion: 1, cancelledFieldIds: ["pending"] });
  await assert.rejects(h.db.query("DELETE FROM configuration_events WHERE id=$1", [event.id]), /immutable/i);
  await h.restart(); assert.deepEqual(await h.request(`/pages/${page.id}/editor`), restored);
});
test("page discard is atomic with its audit and an old request cannot discard a later draft", async () => {
  const def = await h.definition("页面审计回滚", schema(field("name")));
  const page = (await h.request(`/pages?definitionId=${def.id}`))[0], original = await h.request(`/pages/${page.id}/draft`);
  const saved = await h.request(`/pages/${page.id}`, "PUT", { ...original, title: "保留草稿", expectedRevision: original.revision });
  await h.db.query("CREATE FUNCTION reject_page_discard() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'deliberate discard audit failure'; END; $$ LANGUAGE plpgsql");
  await h.db.query("CREATE TRIGGER reject_page_discard BEFORE INSERT ON configuration_events FOR EACH ROW EXECUTE FUNCTION reject_page_discard()");
  try { await h.request(`/pages/${page.id}/discard-draft`, "POST", { expectedRevision: saved.revision }, "admin", 500); assert.deepEqual(await h.request(`/pages/${page.id}/draft`), saved); }
  finally { await h.db.query("DROP TRIGGER reject_page_discard ON configuration_events"); }
  const restored = await h.request(`/pages/${page.id}/discard-draft`, "POST", { expectedRevision: saved.revision }, "admin", 201);
  const later = await h.request(`/pages/${page.id}`, "PUT", { ...restored.draft, title: "后续新草稿", expectedRevision: restored.draft.revision });
  await h.request(`/pages/${page.id}/discard-draft`, "POST", { expectedRevision: saved.revision }, "admin", 409);
  assert.deepEqual(await h.request(`/pages/${page.id}/draft`), later);
});
test("pending fields and page discard require admin ownership, and never-published pages have no restore baseline", async () => {
  const created = await h.request("/pages/new-business", "POST", { title: "尚未发布", requestId: randomUUID() }, "admin", 201);
  await h.request(`/pages/${created.draft.id}/discard-draft`, "POST", { expectedRevision: created.draft.revision }, "admin", 400);
  await h.request(`/data-objects/${created.object.id}/pending-page-fields`, "GET", undefined, "editor", 403);
  await h.request(`/pages/${created.draft.id}/discard-draft`, "POST", { expectedRevision: created.draft.revision }, "editor", 403);
  await h.db.query("UPDATE users SET workspace_id='elsewhere' WHERE username='admin'");
  try {
    await h.request(`/data-objects/${created.object.id}/pending-page-fields`, "GET", undefined, "admin", 404);
    await h.request(`/pages/${created.draft.id}/discard-draft`, "POST", { expectedRevision: created.draft.revision }, "admin", 404);
  } finally { await h.db.query("UPDATE users SET workspace_id='local' WHERE username='admin'"); }
});
