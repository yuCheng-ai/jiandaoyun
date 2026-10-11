import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pageForModel, separateFormSchema, type FormSchema } from "@platform/contracts";
import { harness, field, schema } from "./helpers";
const h = harness(); let definition: any, object: any, page: any, member: any, record: any, related: any, template: any;
const addition = separateFormSchema(schema(field("review")) as unknown as FormSchema).model.fields[0]!;
before(async () => {
  await h.start(); definition = await h.definition("使用情况验收", schema(field("name"), field("quantity", "number"), field("lines", "subform", { children: [field("count", "number")] })));
  object = await h.request(`/data-objects/${definition.id}/draft`); page = (await h.request(`/pages?definitionId=${definition.id}`))[0];
  record = await h.record(definition.id, { name: "不能出现在预览的业务值", quantity: 8, lines: [{ count: 1 }] });
  const users = await h.request("/users"); member = users.find((u: any) => u.username === "editor");
  await h.request(`/definitions/${definition.id}/grants`, "PUT", { userId: member.id, read: true, create: false, edit: false, scope: "all", fields: { name: "read" } });
  related = await h.definition("参考资料", schema(field("name")));
  await h.relation({ title: "参考关系", sourceDefinitionId: definition.id, targetDefinitionId: related.id, cardinality: "many", inverseCardinality: "many", labelFieldId: "name", columns: ["name"], filters: [], mappings: [], valueMode: "live" });
  const spec = { title: "使用此页的流程", bindings: [{ id: "business", title: "业务数据", definitionId: definition.id, definitionVersion: 1 }], tasks: [{ id: "review", title: "阅读确认", assigneeId: member.id, recordBinding: "business", pageId: page.id, pageVersion: 1, requiredFields: [], dependsOn: [] }] };
  template = await h.request("/process-templates", "POST", { applicationId: object.applicationId, requestId: randomUUID(), spec }, "admin", 201);
  await h.request(`/process-templates/${template.id}/publish`, "POST", { expectedRevision: template.revision }, "admin", 201);
  const preview = await h.request(`/process-templates/${template.id}/versions/1/preview`, "POST", { bindings: { business: record.record.id } }, "admin", 201);
  await h.request(`/process-templates/${template.id}/versions/1/start`, "POST", { requestId: randomUUID(), bindings: preview.bindings, recordRevisions: preview.recordRevisions }, "admin", 201);
  const sibling = await h.request("/pages", "POST", { title: "另一页", definitionId: definition.id, definitionVersion: 1, schema: pageForModel(object.model) }, "admin", 201);
  await h.request(`/pages/${sibling.id}/publish`, "POST", { expectedRevision: sibling.revision }, "admin", 201);
  const existing = await h.request(`/pages/${page.id}/draft`), next = pageForModel({ ...object.model, fields: [...object.model.fields, addition] });
  next.controls = next.controls.filter(control => control.binding?.fieldId !== "quantity"); next.controls[0]!.properties.label = "业务名称";
  page = await h.request(`/pages/${page.id}`, "PUT", { ...existing, title: "调整后的处理页", expectedRevision: existing.revision, baseDefinitionRevision: object.revision, schema: next, additions: [{ field: addition }] });
});
after(() => h.close());
const preview = () => h.request(`/pages/${page.id}/publish-preview`, "POST", { expectedRevision: page.revision }, "admin", 201);
test("preview distinguishes controls from data changes and inventories retained versions without mutating drafts", async () => {
  const before = await h.request(`/pages/${page.id}/editor`), result = await preview();
  assert.deepEqual(await h.request(`/pages/${page.id}/editor`), before);
  assert.deepEqual(result.newFields, [{ id: "review", name: "review" }]);
  assert.deepEqual(result.controls.removed, ["quantity"]); assert.ok(result.controls.changed.includes("name")); assert.equal(result.controls.titleChanged, true);
  assert.equal(result.toDataVersion, 2); assert.equal(result.authorizedMembers, 1);
  assert.deepEqual(result.records, [{ version: 1, count: 1 }]); assert.deepEqual(result.tasks, [{ version: 1, active: 1, completed: 0 }]);
  assert.ok(result.references.some((r: any) => r.kind === "page" && r.title === "另一页"));
  assert.ok(result.references.some((r: any) => r.kind === "relation" && r.title === "参考关系"));
  assert.ok(result.references.some((r: any) => r.kind === "process" && r.detail.includes("V1")));
  assert.ok(!JSON.stringify(result).includes("不能出现在预览的业务值"));
  assert.equal((await preview()).token, result.token);
});
test("preview requires administrator, current revision and workspace ownership", async () => {
  await h.request(`/pages/${page.id}/publish-preview`, "POST", { expectedRevision: page.revision }, "editor", 403);
  await h.request(`/pages/${page.id}/publish-preview`, "POST", { expectedRevision: 0 }, "admin", 409);
  await h.request(`/pages/${randomUUID()}/publish-preview`, "POST", { expectedRevision: 1 }, "admin", 404);
  await h.db.query("UPDATE users SET workspace_id='elsewhere' WHERE username='admin'");
  try { await h.request(`/pages/${page.id}/publish-preview`, "POST", { expectedRevision: page.revision }, "admin", 404); }
  finally { await h.db.query("UPDATE users SET workspace_id='local' WHERE username='admin'"); }
});
test("changed usage invalidates publication review, preserves draft, then fresh review publishes atomically", async () => {
  const stale = await preview();
  await h.request("/pages", "POST", { title: "后来添加的页面草稿", definitionId: definition.id, definitionVersion: 1, schema: pageForModel(object.model) }, "admin", 201);
  await h.request(`/pages/${page.id}/publish`, "POST", { expectedRevision: page.revision, impactToken: stale.token }, "admin", 409);
  assert.equal((await h.request(`/pages/${page.id}/draft`)).revision, page.revision);
  assert.equal((await h.request(`/data-objects/${definition.id}/draft`)).latestVersion, 1);
  const fresh = await preview(); assert.notEqual(fresh.token, stale.token);
  assert.ok(fresh.references.some((r: any) => r.state === "draft" && r.title === "后来添加的页面草稿"));
  const published = await h.request(`/pages/${page.id}/publish`, "POST", { expectedRevision: page.revision, impactToken: fresh.token }, "admin", 201);
  assert.equal(published.version, 2); assert.equal(published.definitionVersion, 2);
  assert.equal((await h.request(`/records/${record.record.id}`)).record.definitionVersion, 1);
  const model = await h.request(`/data-objects/${definition.id}/draft`); assert.ok(model.model.fields.some((f: any) => f.id === "quantity"));
  const old = await h.request(`/pages/${page.id}?version=1`); assert.ok(old.page.schema.controls.some((c: any) => c.binding.fieldId === "quantity"));
});
test("same-scope duplicate new fields including subform children cannot bypass the editor", async () => {
  const invalid = structuredClone(object.model); invalid.fields[2].children.push({ ...invalid.fields[2].children[0], id: "another_count", name: " count " });
  await h.request("/data-objects", "POST", { title: "重复明细", model: invalid }, "admin", 409);
  const fresh = await h.request(`/data-objects/${definition.id}/draft`);
  const duplicate = { ...addition, id: "duplicate_name", name: "name" };
  await h.request("/pages", "POST", { title: "重复业务字段", definitionId: definition.id, definitionVersion: 2, baseDefinitionRevision: fresh.revision, schema: pageForModel({ ...fresh.model, fields: [...fresh.model.fields, duplicate] }), additions: [{ field: duplicate }] }, "admin", 409);
});
