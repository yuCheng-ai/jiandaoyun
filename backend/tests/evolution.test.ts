import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pageForModel, separateFormSchema, type FormSchema } from "@platform/contracts";
import { harness, field, schema } from "./helpers";
const h = harness();
let definition: any, oldPage: any, newPage: any, record: any;
const source = schema(field("name"), field("lines", "subform", { children: [field("item"), field("quantity", "number")] }));
before(async () => {
  await h.start(); definition = await h.definition("版本演进", source);
  oldPage = (await h.request(`/pages?definitionId=${definition.id}`))[0];
  record = await h.record(definition.id, { name: "原内容", lines: [{ item: "原明细", quantity: 3 }] });
  const next = schema(field("name"), field("lines", "subform", { children: [field("item"), field("quantity", "number"), field("remark")] }), field("conclusion"));
  let object = await h.request(`/data-objects/${definition.id}/draft`);
  object = await h.request(`/data-objects/${definition.id}`, "PUT", { ...object, expectedRevision: object.revision, model: separateFormSchema(next as unknown as FormSchema).model });
  object = await h.request(`/data-objects/${definition.id}/publish`, "POST", { expectedRevision: object.revision }, "admin", 201);
  const pageSchema = pageForModel(object.model); pageSchema.controls.at(-1)!.properties.required = true;
  newPage = await h.request("/pages", "POST", { title: "新增字段处理页", definitionId: definition.id, definitionVersion: 2, schema: pageSchema }, "admin", 201);
  await h.request(`/pages/${newPage.id}/publish`, "POST", { expectedRevision: newPage.revision }, "admin", 201);
});
after(() => h.close());
const upgradePath = (id: string, page = newPage) => `/pages/${page.id}/records/${id}/upgrade`;

test("record upgrade preserves values, row identities, existing revisions and a recoverable audit snapshot", async () => {
  const currentModel = await h.request(`/data-objects/${definition.id}/published-model`);
  assert.equal(currentModel.object.latestVersion, 2);
  assert.equal(currentModel.model.fields.at(-1).id, "conclusion");
  await h.request(`/pages/${newPage.id}/records/${record.record.id}`, "GET", undefined, "admin", 409);
  const preview = await h.request(`${upgradePath(record.record.id)}?version=1`);
  assert.equal(preview.allowed, true); assert.equal(preview.additions.length, 2);
  const command = { requestId: randomUUID(), pageVersion: 1, expectedRevision: preview.revision };
  const upgraded = await h.request(upgradePath(record.record.id), "POST", command, "admin", 201);
  assert.equal(upgraded.record.definitionVersion, 2); assert.equal(upgraded.record.revision, 2);
  assert.equal(upgraded.record.values.name, "原内容"); assert.equal(upgraded.record.values.conclusion, "");
  assert.deepEqual(upgraded.record.values.lines[0], { ...record.record.values.lines[0], remark: "" });
  assert.equal(upgraded.record.rowRevisions.lines, record.record.rowRevisions.lines);
  assert.equal(upgraded.record.cellRevisions.name, record.record.cellRevisions.name);
  assert.deepEqual(await h.request(upgradePath(record.record.id), "POST", command, "admin", 201), upgraded);
  const events = await h.request(`/records/${record.record.id}/events`);
  assert.equal(events.length, 2); assert.equal(events[1].changes.action, "upgrade");
  assert.deepEqual(events[1].changes.before.values, record.record.values);
  const legacyRuntime = await h.request(`/pages/${oldPage.id}/form`);
  assert.deepEqual(legacyRuntime.compatibleVersions.sort(), [1, 2]);
  const legacy = await h.request(`/pages/${oldPage.id}/records/${record.record.id}`);
  assert.equal(legacy.record.values.conclusion, undefined);
  assert.deepEqual(legacy.rowActions.lines, { add: true, remove: false, insert: false, editExisting: true });
  assert.deepEqual(upgraded.rowActions.lines, { add: true, remove: true, insert: false, editExisting: true });
  await h.request(`/pages/${oldPage.id}/records/${record.record.id}`, "PATCH", { pageVersion: 1, requestId: randomUUID(), changes: [{ fieldId: "name", value: "原页面继续办理", expectedRevision: 1 }] });
  const fresh = await h.request(`/pages/${newPage.id}/records/${record.record.id}`);
  assert.equal(fresh.record.values.name, "原页面继续办理");
});
test("only administrators can upgrade and new fields do not inherit broader member permissions", async () => {
  const users = await h.request("/users"), member = users.find((item: any) => item.username === "editor");
  await h.permissionGroup(definition.id, {
    id: "member_" + member.id,
    subjects: [{ kind: "member", id: member.id }],
    scope: "all",
    fields: { name: "edit", lines: "edit", item: "edit", quantity: "read" },
    actions: ["view", "create", "edit"],
  });
  await h.request(`${upgradePath(record.record.id)}?version=1`, "GET", undefined, "editor", 403);
  await h.request(upgradePath(record.record.id), "POST", { pageVersion: 1, expectedRevision: 3, requestId: randomUUID() }, "editor", 403);
  const detail = await h.request(`/pages/${newPage.id}/records/${record.record.id}`, "GET", undefined, "editor");
  assert.equal(detail.record.values.conclusion, undefined); assert.equal(detail.record.values.lines[0].remark, undefined);
  assert.equal(detail.record.cellRevisions.conclusion, undefined);
  await h.request(`/pages/${newPage.id}/records/${record.record.id}`, "PATCH", { pageVersion: 1, requestId: randomUUID(), changes: [{ fieldId: "conclusion", value: "越权", expectedRevision: 1 }] }, "editor", 403);
});
test("stale upgrade previews and records from another object cannot be applied", async () => {
  const old = await h.record(definition.id, { name: "并发记录", lines: [] });
  const plan = await h.request(`${upgradePath(old.record.id)}?version=1`);
  await h.request(`/records/${old.record.id}`, "PATCH", { requestId: randomUUID(), changes: [{ fieldId: "name", expectedRevision: 1, value: "他人更新" }] });
  await h.request(upgradePath(old.record.id), "POST", { pageVersion: 1, requestId: randomUUID(), expectedRevision: plan.revision }, "admin", 409);
  const unchanged = await h.request(`/records/${old.record.id}`);
  assert.equal(unchanged.record.definitionVersion, 1); assert.equal(unchanged.record.values.name, "他人更新");
  assert.equal((await h.request(`/records/${old.record.id}/events`)).length, 2);
  const other = await h.definition("其他对象", schema(field("name"))), otherRecord = await h.record(other.id, { name: "其他" });
  await h.request(`${upgradePath(otherRecord.record.id)}?version=1`, "GET", undefined, "admin", 400);
});
test("constraint changes and unsatisfied new required values block upgrade without partially changing records", async () => {
  const original = await h.definition("强约束验证", schema(field("name")));
  const old = await h.record(original.id, { name: "原有内容" });
  let object = await h.request(`/data-objects/${original.id}/draft`);
  object.model.fields[0].settings.maxLength = 1;
  object = await h.request(`/data-objects/${original.id}`, "PUT", { ...object, expectedRevision: object.revision });
  object = await h.request(`/data-objects/${original.id}/publish`, "POST", { expectedRevision: object.revision, impactToken: (await h.request(`/data-objects/${original.id}/publish-preview`, "POST", { expectedRevision: object.revision }, "admin", 201)).token }, "admin", 201);
  const originalPage = (await h.request(`/pages?definitionId=${original.id}`))[0];
  assert.deepEqual((await h.request(`/pages/${originalPage.id}/form`)).compatibleVersions, [1]);
  let page = await h.request("/pages", "POST", { title: "约束页", definitionId: original.id, definitionVersion: 2, schema: pageForModel(object.model) }, "admin", 201);
  await h.request(`/pages/${page.id}/publish`, "POST", { expectedRevision: page.revision }, "admin", 201);
  assert.equal((await h.request(`${upgradePath(old.record.id, page)}?version=1`)).allowed, false);
  await h.request(upgradePath(old.record.id, page), "POST", { pageVersion: 1, requestId: randomUUID(), expectedRevision: 1 }, "admin", 409);
  assert.deepEqual((await h.request(`/records/${old.record.id}`)).record, old.record);
  object.model.fields[0].settings.maxLength = 200;
  object.model.fields.push(separateFormSchema(schema(field("new_required", "text", { required: true })) as unknown as FormSchema).model.fields[0]);
  object = await h.request(`/data-objects/${original.id}`, "PUT", { ...object, expectedRevision: object.revision });
  object = await h.request(`/data-objects/${original.id}/publish`, "POST", { expectedRevision: object.revision, impactToken: (await h.request(`/data-objects/${original.id}/publish-preview`, "POST", { expectedRevision: object.revision }, "admin", 201)).token }, "admin", 201);
  page = await h.request("/pages", "POST", { title: "新增必填", definitionId: original.id, definitionVersion: 3, schema: pageForModel(object.model) }, "admin", 201);
  await h.request(`/pages/${page.id}/publish`, "POST", { expectedRevision: page.revision }, "admin", 201);
  assert.equal((await h.request(`${upgradePath(old.record.id, page)}?version=1`)).allowed, false);
  await h.request(upgradePath(old.record.id, page), "POST", { pageVersion: 1, requestId: randomUUID(), expectedRevision: 1 }, "admin", 400);
  assert.equal((await h.request(`/records/${old.record.id}/events`)).length, 1);
});
test("audit write failure rolls back the entire upgrade and retry survives restart", async () => {
  const old = await h.record(definition.id, { name: "回滚验证", lines: [] });
  await h.db.query(`CREATE FUNCTION reject_upgrade_audit() RETURNS trigger AS $$ BEGIN IF NEW.changes->>'action'='upgrade' THEN RAISE EXCEPTION 'deliberate upgrade audit failure'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql`);
  await h.db.query("CREATE TRIGGER reject_upgrade BEFORE INSERT ON record_events FOR EACH ROW EXECUTE FUNCTION reject_upgrade_audit()");
  const command = { pageVersion: 1, requestId: randomUUID(), expectedRevision: 1 };
  try {
    await h.request(upgradePath(old.record.id), "POST", command, "admin", 500);
    assert.deepEqual((await h.request(`/records/${old.record.id}`)).record, old.record);
  } finally { await h.db.query("DROP TRIGGER reject_upgrade ON record_events"); }
  const upgraded = await h.request(upgradePath(old.record.id), "POST", command, "admin", 201);
  await h.restart();
  assert.deepEqual(await h.request(upgradePath(old.record.id), "POST", command, "admin", 201), upgraded);
});
test("page additions cannot reuse a removed historical field identity with a new type", async () => {
  const original = await h.definition("历史字段身份", schema(field("keep"), field("historical")));
  let object = await h.request(`/data-objects/${original.id}/draft`);
  // Remove the active default-page control first; historical page versions remain immutable.
  const summary = (await h.request(`/pages?definitionId=${original.id}`))[0];
  let draft = await h.request(`/pages/${summary.id}/draft`);
  draft.schema.controls = draft.schema.controls.filter((control: any) => control.binding.fieldId !== "historical");
  draft = await h.request(`/pages/${summary.id}`, "PUT", { ...draft, expectedRevision: draft.revision });
  await h.request(`/pages/${summary.id}/publish`, "POST", { expectedRevision: draft.revision }, "admin", 201);
  object.model.fields.pop();
  object = await h.request(`/data-objects/${original.id}`, "PUT", { ...object, expectedRevision: object.revision });
  object = await h.request(`/data-objects/${original.id}/publish`, "POST", { expectedRevision: object.revision, impactToken: (await h.request(`/data-objects/${original.id}/publish-preview`, "POST", { expectedRevision: object.revision }, "admin", 201)).token }, "admin", 201);
  const addition = separateFormSchema(schema(field("historical", "number")) as unknown as FormSchema).model.fields[0]!;
  const page = await h.request("/pages", "POST", { title: "错误复用", definitionId: original.id, definitionVersion: 2, baseDefinitionRevision: object.revision, additions: [{ field: addition }], schema: pageForModel({ ...object.model, fields: [...object.model.fields, addition] }) }, "admin", 201);
  await h.request(`/pages/${page.id}/publish`, "POST", { expectedRevision: page.revision }, "admin", 400);
  assert.equal((await h.request(`/data-objects/${original.id}/draft`)).latestVersion, 2);
  assert.equal((await h.request(`/pages/${page.id}/draft`)).additions[0].field.id, "historical");
});
