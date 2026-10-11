import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { separateFormSchema, pageForModel, type FormSchema } from "@platform/contracts";
import { harness, field, schema } from "./helpers";

const h = harness();
let definition: any, page: any, record: any, model: any, acceptancePage: any;
const source = schema(field("name"), field("quantity", "number"), field("lines", "subform", { children: [field("item"), field("count", "number")] }));
before(async () => {
  await h.start(); definition = await h.definition("独立业务数据", source);
  record = await h.record(definition.id, { name: "旧记录", quantity: 3, lines: [{ item: "A", count: 1 }] });
  model = (await h.request(`/data-objects/${definition.id}/draft`)).model;
});
after(() => h.close());
const newField = (id = "conclusion") => separateFormSchema(schema(field(id)) as unknown as FormSchema).model.fields[0]!;

test("existing publication gains an independent default page and data model without rewriting records", async () => {
  const list = await h.request(`/pages?definitionId=${definition.id}`);
  assert.equal(list.length, 1);
  const published = await h.request(`/pages/${list[0].id}`);
  assert.equal(published.page.definitionVersion, 1);
  assert.equal(published.model.fields[0].id, "name");
  assert.equal(published.model.fields[0].settings.width, undefined);
  assert.deepEqual((await h.request(`/records/${record.record.id}`)).record, record.record);
  await h.request(`/data-objects/${definition.id}/draft`, "GET", undefined, "editor", 403);
});
test("two pages bind one model; publishing layout changes does not increment data versions", async () => {
  const pageSchema = pageForModel(model);
  pageSchema.controls = pageSchema.controls.filter(control => control.binding?.fieldId !== "quantity");
  pageSchema.controls[0]!.properties.label = "登记名称";
  page = await h.request("/pages", "POST", { title: "登记页面", definitionId: definition.id, definitionVersion: 1, schema: pageSchema }, "admin", 201);
  const published = await h.request(`/pages/${page.id}/publish`, "POST", { expectedRevision: page.revision }, "admin", 201);
  assert.equal(published.definitionVersion, 1);
  let object = await h.request(`/data-objects/${definition.id}/draft`);
  assert.equal(object.latestVersion, 1); assert.equal(object.revision, 2);
  assert.equal(object.model.fields[1].id, "quantity");
  page = await h.request(`/pages/${page.id}/draft`);
  page.schema.settings.layout = 4;
  page.schema.settings.labelWidth = 500;
  page.schema.settings.labelAlignment = "right";
  page.schema.settings.descriptionMode = "popover";
  page.schema.settings.inputWidth = "auto";
  page.schema.settings.mobileLayout = { labelPosition: "left", labelWidth: 120, labelAlignment: "left", descriptionMode: "show" };
  page.schema.settings.allowSubmit = false;
  page.schema.settings.draftLabel = "暂存";
  page = await h.request(`/pages/${page.id}`, "PUT", { ...page, expectedRevision: page.revision });
  await h.request(`/pages/${page.id}/publish`, "POST", { expectedRevision: page.revision }, "admin", 201);
  object = await h.request(`/data-objects/${definition.id}/draft`);
  assert.equal(object.latestVersion, 1); assert.equal(object.revision, 2);
  const historical = await h.request(`/pages/${page.id}?version=1`);
  assert.equal(historical.page.schema.settings.layout, 1);
  assert.equal(historical.page.schema.settings.allowSubmit, true);
  assert.equal(historical.page.schema.settings.draftLabel, "保存草稿");
  const current = await h.request(`/pages/${page.id}`);
  assert.equal(historical.page.schema.settings.mobileLayout, undefined);
  assert.equal(current.page.schema.settings.layout, 4);
  assert.equal(current.page.schema.settings.labelWidth, 500);
  assert.equal(current.page.schema.settings.labelAlignment, "right");
  assert.equal(current.page.schema.settings.descriptionMode, "popover");
  assert.equal(current.page.schema.settings.inputWidth, "auto");
  assert.deepEqual(current.page.schema.settings.mobileLayout, { labelPosition: "left", labelWidth: 120, labelAlignment: "left", descriptionMode: "show" });
  assert.equal(current.page.schema.settings.allowSubmit, false);
  assert.equal(current.page.schema.settings.draftLabel, "暂存");
});
test("invalid bindings, malformed controls and stale page drafts are rejected", async () => {
  page = await h.request(`/pages/${page.id}/draft`);
  const invalid = structuredClone(page); invalid.schema.controls[0].binding.fieldId = "missing";
  await h.request(`/pages/${page.id}`, "PUT", { ...invalid, expectedRevision: page.revision }, "admin", 400);
  invalid.schema = structuredClone(page.schema); invalid.schema.controls[0].properties.tabs = null;
  await h.request(`/pages/${page.id}`, "PUT", { ...invalid, expectedRevision: page.revision }, "admin", 400);
  invalid.schema = structuredClone(page.schema); invalid.schema.settings.allowSubmit = "disabled";
  await h.request(`/pages/${page.id}`, "PUT", { ...invalid, expectedRevision: page.revision }, "admin", 400);
  invalid.schema = structuredClone(page.schema); invalid.schema.settings.draftLabel = { text: "暂存" };
  await h.request(`/pages/${page.id}`, "PUT", { ...invalid, expectedRevision: page.revision }, "admin", 400);
  await h.request(`/pages/${page.id}`, "PUT", { ...page, expectedRevision: page.revision - 1 }, "admin", 409);
  await h.request(`/pages/${page.id}`, "PUT", { ...page, expectedRevision: page.revision }, "editor", 403);
});
test("new fields remain in page drafts and publish atomically with their bindings", async () => {
  const addition = newField();
  const pageSchema = pageForModel({ ...model, fields: [...model.fields, addition] });
  pageSchema.controls.at(-1)!.properties.required = true;
  const draft = await h.request("/pages", "POST", { title: "验收页", definitionId: definition.id, definitionVersion: 1, baseDefinitionRevision: 2, additions: [{ field: addition }], schema: pageSchema }, "admin", 201);
  assert.equal((await h.request(`/data-objects/${definition.id}/draft`)).model.fields.length, 3);
  const published = await h.request(`/pages/${draft.id}/publish`, "POST", { expectedRevision: draft.revision }, "admin", 201);
  acceptancePage = published;
  assert.equal(published.definitionVersion, 2);
  const object = await h.request(`/data-objects/${definition.id}/draft`);
  assert.equal(object.model.fields.at(-1).id, "conclusion");
  assert.equal(object.model.fields.at(-1).required, false);
  assert.equal(published.schema.controls.at(-1).properties.required, true);
  assert.equal((await h.request(`/pages/${page.id}`)).page.definitionVersion, 1);
  assert.equal((await h.request(`/records/${record.record.id}`)).record.definitionVersion, 1);
  await h.request(`/pages/${draft.id}/publish`, "POST", { expectedRevision: draft.revision }, "admin", 409);
});
test("removing an unpublished new control also requires removing its pending data field", async () => {
  const object = await h.request(`/data-objects/${definition.id}/draft`), addition = newField("unused");
  await h.request("/pages", "POST", { title: "遗留字段", definitionId: definition.id, definitionVersion: 2, baseDefinitionRevision: object.revision, additions: [{ field: addition }], schema: pageForModel(object.model) }, "admin", 400);
  assert.equal((await h.request(`/data-objects/${definition.id}/draft`)).model.fields.some((field: any) => field.id === "unused"), false);
});
test("a concurrent model publication rejects the whole page publication and preserves its pending fields", async () => {
  const object = await h.request(`/data-objects/${definition.id}/draft`), addition = newField("pending");
  const draft = await h.request("/pages", "POST", { title: "并发页", definitionId: definition.id, definitionVersion: 2, baseDefinitionRevision: object.revision, additions: [{ field: addition }], schema: pageForModel({ ...object.model, fields: [...object.model.fields, addition] }) }, "admin", 201);
  const changed = structuredClone(object); changed.model.fields[0].name = "业务名称";
  const saved = await h.request(`/data-objects/${definition.id}`, "PUT", { ...changed, expectedRevision: object.revision });
  await h.request(`/data-objects/${definition.id}/publish`, "POST", { expectedRevision: saved.revision }, "admin", 201);
  await h.request(`/pages/${draft.id}/publish`, "POST", { expectedRevision: draft.revision }, "admin", 409);
  assert.equal((await h.request(`/pages/${draft.id}/draft`)).additions[0].field.id, "pending");
  assert.equal((await h.request(`/data-objects/${definition.id}/draft`)).model.fields.some((field: any) => field.id === "pending"), false);
  assert.equal((await h.db.query("SELECT count(*)::int AS count FROM page_versions WHERE page_id=$1", [draft.id])).rows[0].count, 0);
});
test("published page and model versions cannot be rewritten; restart retains independent histories", async () => {
  await assert.rejects(h.db.query("UPDATE data_object_versions SET model='{}' WHERE definition_id=$1", [definition.id]), /immutable/);
  await assert.rejects(h.db.query("DELETE FROM page_versions WHERE page_id=$1", [page.id]), /immutable/);
  const before = await h.request(`/pages/${page.id}?version=1`);
  await h.restart();
  assert.deepEqual(await h.request(`/pages/${page.id}?version=1`), before);
  assert.equal((await h.request(`/records/${record.record.id}`)).record.values.name, "旧记录");
});

test("two pages read and write the same record while page and member restrictions both apply", async () => {
  const users = await h.request("/users"), editor = users.find((user: any) => user.username === "editor");
  await h.request(`/definitions/${definition.id}/grants`, "PUT", { userId: editor.id, read: true, create: true, edit: true, scope: "all", fields: { name: "edit", quantity: "edit", lines: "edit", item: "edit", count: "read", conclusion: "hidden" } });
  const schema = pageForModel(model); schema.controls[0]!.properties.editable = false; schema.controls[1]!.properties.visible = false;
  let scoped = await h.request("/pages", "POST", { title: "只读名称与处理明细", definitionId: definition.id, definitionVersion: 1, schema }, "admin", 201);
  scoped = await h.request(`/pages/${scoped.id}/publish`, "POST", { expectedRevision: scoped.revision }, "admin", 201);
  const path = `/pages/${scoped.id}/records/${record.record.id}`;
  const detail = await h.request(path, "GET", undefined, "editor");
  assert.equal(detail.access.fields.name, "read");
  assert.equal(detail.access.fields.count, "read");
  assert.equal(detail.record.values.quantity, undefined);
  assert.equal(detail.record.cellRevisions.quantity, undefined);
  assert.equal(detail.definition.schema.fields.some((field: any) => field.id === "quantity"), false);
  for (const fieldId of ["name", "quantity"]) await h.request(path, "PATCH", { pageVersion: 1, requestId: randomUUID(), changes: [{ fieldId, value: fieldId === "name" ? "非法" : 9, expectedRevision: 1 }] }, "editor", 403);
  const rowId = record.record.values.lines[0]._rowId;
  await h.request(path, "PATCH", { pageVersion: 1, requestId: randomUUID(), changes: [{ subformId: "lines", rowId, fieldId: "count", value: 8, expectedRevision: 1 }] }, "editor", 403);
  const command = { pageVersion: 1, requestId: randomUUID(), changes: [{ subformId: "lines", rowId, fieldId: "item", value: "跨页面同一数据", expectedRevision: 1 }] };
  await h.request(path, "PATCH", command, "editor");
  await h.request(path, "PATCH", command, "editor");
  const otherPage = await h.request(`/pages/${page.id}/records/${record.record.id}`, "GET", undefined, "editor");
  assert.equal(otherPage.record.values.lines[0].item, "跨页面同一数据");
  assert.equal(otherPage.record.cellRevisions[`lines/${rowId}/item`], 2);
  await h.request(`/pages/${acceptancePage.id}/records/${record.record.id}`, "GET", undefined, "editor", 409);
});
test("page-only required fields are enforced on submission without preventing another page from storing partial business data", async () => {
  const partial = await h.record(definition.id, { name: "待验收", quantity: 2, lines: [], conclusion: "" }, "admin", 2);
  const path = `/pages/${acceptancePage.id}/records/${partial.record.id}`;
  const changes = [{ fieldId: "name", value: "不应先保存", expectedRevision: 1 }];
  await h.request(path, "PATCH", { pageVersion: 1, requestId: randomUUID(), changes }, "admin", 400);
  assert.equal((await h.request(`/records/${partial.record.id}`)).record.values.name, "待验收");
  assert.equal((await h.request(`/records/${partial.record.id}/events`)).length, 1);
  changes.push({ fieldId: "conclusion", value: "通过", expectedRevision: 1 });
  const updated = await h.request(path, "PATCH", { pageVersion: 1, requestId: randomUUID(), changes });
  assert.equal(updated.record.values.conclusion, "通过");
  await h.request(`/pages/${acceptancePage.id}/records`, "POST", { pageVersion: 1, requestId: randomUUID(), values: { name: "缺少结论", quantity: 1, lines: [] } }, "admin", 400);
});
test("removing a referenced data field can be drafted but publication is prevented", async () => {
  const draft = await h.request(`/data-objects/${definition.id}/draft`);
  draft.model.fields = draft.model.fields.filter((field: any) => field.id !== "name");
  const saved = await h.request(`/data-objects/${definition.id}`, "PUT", { ...draft, expectedRevision: draft.revision });
  const impact = await h.request(`/data-objects/${definition.id}/publish-preview`, "POST", { expectedRevision: saved.revision }, "admin", 201);
  assert.ok(impact.blockers.length);
  await h.request(`/data-objects/${definition.id}/publish`, "POST", { expectedRevision: saved.revision, impactToken: impact.token }, "admin", 409);
  await h.request(`/data-objects/${definition.id}/discard-draft`, "POST", { expectedRevision: saved.revision }, "admin", 201);
});
test("a database failure after writing a new model rolls back model, page and version counters together", async () => {
  const object = await h.request(`/data-objects/${definition.id}/draft`), addition = newField("rollback_field");
  const draft = await h.request("/pages", "POST", { title: "事务回滚测试", definitionId: definition.id, definitionVersion: object.latestVersion, baseDefinitionRevision: object.revision, additions: [{ field: addition }], schema: pageForModel({ ...object.model, fields: [...object.model.fields, addition] }) }, "admin", 201);
  await h.db.query("CREATE FUNCTION reject_test_page() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'deliberate page write failure'; END; $$ LANGUAGE plpgsql");
  await h.db.query("CREATE TRIGGER reject_test_page BEFORE INSERT ON page_versions FOR EACH ROW EXECUTE FUNCTION reject_test_page()");
  try {
    await h.request(`/pages/${draft.id}/publish`, "POST", { expectedRevision: draft.revision }, "admin", 500);
    assert.deepEqual(await h.request(`/data-objects/${definition.id}/draft`), object);
    assert.equal((await h.request(`/pages/${draft.id}/draft`)).revision, draft.revision);
    assert.equal((await h.db.query("SELECT count(*)::int AS count FROM definition_versions WHERE definition_id=$1", [definition.id])).rows[0].count, object.latestVersion);
  } finally { await h.db.query("DROP TRIGGER reject_test_page ON page_versions"); await h.db.query("DROP FUNCTION reject_test_page()"); }
  const published = await h.request(`/pages/${draft.id}/publish`, "POST", { expectedRevision: draft.revision }, "admin", 201);
  assert.equal(published.definitionVersion, object.latestVersion + 1);
});
test("legacy conversion runs once under concurrent startup and preserves historical page titles", async () => {
  const legacy = randomUUID();
  await h.db.query("INSERT INTO definitions(id,workspace_id,title,draft,latest_version,application_id) SELECT $1,'local','新标题',$2,2,id FROM applications WHERE workspace_id='local' AND is_default", [legacy, source]);
  await h.db.query("INSERT INTO definition_versions(definition_id,version,title,schema) VALUES($1,1,'旧标题',$2),($1,2,'新标题',$2)", [legacy, source]);
  const { upgradeDataProjection } = require("../src/data-projection") as typeof import("../src/data-projection");
  await Promise.all([upgradeDataProjection(h.db), upgradeDataProjection(h.db)]);
  const [page] = await h.request(`/pages?definitionId=${legacy}`);
  assert.equal((await h.request(`/pages/${page.id}?version=1`)).page.title, "旧标题");
  assert.equal((await h.request(`/pages/${page.id}?version=2`)).page.title, "新标题");
  assert.equal((await h.db.query("SELECT count(*)::int AS count FROM data_object_versions WHERE definition_id=$1", [legacy])).rows[0].count, 2);
});
test("member page lists show published metadata and never expose an unpublished rename", async () => {
  const draft = await h.request(`/pages/${page.id}/draft`);
  await h.request(`/pages/${page.id}`, "PUT", { ...draft, title: "仅草稿中的新名称", expectedRevision: draft.revision });
  const visible = await h.request(`/pages?definitionId=${definition.id}`, "GET", undefined, "editor");
  assert.equal(visible.find((item: any) => item.id === page.id).title, "登记页面");
  assert.equal(visible.some((item: any) => item.title === "仅草稿中的新名称"), false);
});
