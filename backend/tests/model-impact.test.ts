import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pageForModel } from "@platform/contracts";
import { harness, field, schema } from "./helpers";
const h = harness();
before(() => h.start()); after(() => h.close());
const draft = (id: string) => h.request(`/data-objects/${id}/draft`);
const save = (value: any) => h.request(`/data-objects/${value.id}`, "PUT", { ...value, expectedRevision: value.revision });
const preview = (value: any) => h.request(`/data-objects/${value.id}/publish-preview`, "POST", { expectedRevision: value.revision }, "admin", 201);
const publish = (value: any, impact: any, status = 201) => h.request(`/data-objects/${value.id}/publish`, "POST", { expectedRevision: value.revision, impactToken: impact.token }, "admin", status);

test("model review inventories field constraints, draft and published dependencies, grants and retained records without disclosing values", async () => {
  const def = await h.definition("字段影响", schema(field("name"), field("qty", "number"), field("lines", "subform", { children: [field("note"), field("count", "number")] })));
  const record = await h.record(def.id, { name: "机密正文不返回", qty: 9, lines: [{ note: "明细正文", count: 4 }] });
  const page = (await h.request(`/pages?definitionId=${def.id}`))[0];
  const users = await h.request("/users"), editor = users.find((u: any) => u.username === "editor");
  await h.request(`/definitions/${def.id}/grants`, "PUT", { userId: editor.id, read: true, create: false, edit: false, scope: "all", fields: { name: "read", lines: "read", note: "read", count: "read" } });
  const target = await h.definition("引用端", schema(field("title")));
  const relation = await h.relation({ title: "关联资料", sourceDefinitionId: def.id, targetDefinitionId: target.id, cardinality: "many", inverseCardinality: "many", labelFieldId: "title", columns: [], filters: [{ id: "f", sourceFieldId: "title", source: "field", value: "name", operator: "equals" }], mappings: [], valueMode: "live" });
  await h.request(`/relations/${relation.id}`, "PUT", { expectedRevision: relation.revision, spec: { ...relation.spec, title: "未发布关系修改" } });
  const object = await draft(def.id);
  const template = await h.request("/process-templates", "POST", { applicationId: object.applicationId, requestId: randomUUID(), spec: { title: "字段处理流程", bindings: [{ id: "record", title: "主记录", definitionId: def.id, definitionVersion: 1 }], tasks: [{ id: "check", title: "确认", assigneeId: editor.id, recordBinding: "record", pageId: page.id, pageVersion: 1, requiredFields: ["name"], dependsOn: [] }] } }, "admin", 201);
  await h.request(`/process-templates/${template.id}/publish`, "POST", { expectedRevision: template.revision }, "admin", 201);
  const start = await h.request(`/process-templates/${template.id}/versions/1/preview`, "POST", { bindings: { record: record.record.id } }, "admin", 201);
  await h.request(`/process-templates/${template.id}/versions/1/start`, "POST", { requestId: randomUUID(), bindings: start.bindings, recordRevisions: start.recordRevisions }, "admin", 201);
  object.title = "字段影响新版"; object.model.fields[0].name = "业务名称"; object.model.fields[0].required = true;
  object.model.fields[2].children[1].settings.max = 2;
  const saved = await save(object), result = await preview(saved);
  assert.deepEqual(await draft(def.id), saved); assert.equal(result.titleChanged, true);
  assert.equal(result.changes.renamed[0].beforeName, "name");
  assert.ok(result.changes.changed.some((f: any) => f.parentName === "lines" && f.details.includes("最大值：未设置 → 2")));
  assert.deepEqual(result.records, [{ version: 1, count: 1, archived: 0, incompatible: 1 }]);
  assert.deepEqual(result.tasks, [{ version: 1, active: 1, completed: 0 }]);
  assert.ok(result.references.some((r: any) => r.kind === "relation" && r.state === "draft"));
  assert.ok(result.references.some((r: any) => r.kind === "process" && r.fields.includes("业务名称")));
  assert.ok(result.references.some((r: any) => r.kind === "permission" && r.title.includes(editor.name)));
  assert.ok(!JSON.stringify(result).includes("机密正文不返回")); assert.ok(!JSON.stringify(result).includes(record.record.id));
  assert.equal((await preview(saved)).token, result.token);
  await h.request(`/data-objects/${def.id}/publish`, "POST", { expectedRevision: saved.revision }, "admin", 409);
  await publish(saved, result);
  assert.deepEqual((await h.request(`/records/${record.record.id}`)).record, record.record);
  assert.equal((await h.request(`/pages/${page.id}`)).page.definitionVersion, 1);
});

test("published default/custom pages and live relation fields block removal, while a persisted draft can be safely abandoned", async () => {
  const def = await h.definition("引用保护", schema(field("keep"), field("remove")));
  const target = await h.definition("关联方", schema(field("name")));
  await h.relation({ title: "保留字段关系", sourceDefinitionId: def.id, targetDefinitionId: target.id, cardinality: "many", inverseCardinality: "many", labelFieldId: "name", columns: [], filters: [{ id: "f", sourceFieldId: "name", source: "field", value: "remove", operator: "equals" }], mappings: [], valueMode: "live" });
  const original = await draft(def.id), page = (await h.request(`/pages?definitionId=${def.id}`))[0];
  assert.equal(original.hasDraftChanges, false);
  const pageBefore = await h.request(`/pages/${page.id}/editor`);
  let edited = structuredClone(original); edited.model.fields.pop(); edited = await save(edited);
  assert.equal(edited.hasDraftChanges, true);
  const impact = await preview(edited);
  assert.equal(impact.references.filter((r: any) => r.effect === "blocks").length, 2);
  await publish(edited, impact, 409);
  assert.equal((await draft(def.id)).latestVersion, 1);
  await h.request(`/data-objects/${def.id}/discard-draft`, "POST", { expectedRevision: original.revision }, "admin", 409);
  await h.request(`/data-objects/${def.id}/discard-draft`, "POST", { expectedRevision: edited.revision }, "editor", 403);
  const restored = await h.request(`/data-objects/${def.id}/discard-draft`, "POST", { expectedRevision: edited.revision }, "admin", 201);
  assert.deepEqual(restored.model, original.model); assert.equal(restored.revision, edited.revision + 1);
  assert.equal(restored.hasDraftChanges, false);
  assert.deepEqual((await h.request(`/pages/${page.id}/editor`)).draft, pageBefore.draft);
  const event = (await h.db.query("SELECT * FROM configuration_events WHERE resource_id=$1 AND action='discard_draft'", [def.id])).rows[0];
  assert.equal(event.detail.restoredVersion, 1);
  await assert.rejects(() => h.db.query("DELETE FROM configuration_events WHERE id=$1", [event.id]), /immutable/i);
});

test("grant and page changes invalidate reviewed publication, preserving the saved draft and version", async () => {
  const def = await h.definition("陈旧检查", schema(field("name")));
  let object = await draft(def.id); object.model.fields[0].required = true; object = await save(object);
  const first = await preview(object), users = await h.request("/users");
  await h.request(`/definitions/${def.id}/grants`, "PUT", { userId: users.find((u: any) => u.username === "editor").id, read: true, create: false, edit: false, scope: "all", fields: { name: "read" } });
  await publish(object, first, 409);
  const second = await preview(object); assert.notEqual(second.token, first.token);
  await h.request("/pages", "POST", { title: "新草稿", definitionId: def.id, definitionVersion: 1, schema: pageForModel((await h.request(`/data-objects/${def.id}/versions/1`))) }, "admin", 201);
  await publish(object, second, 409); assert.deepEqual(await draft(def.id), object);
  await publish(object, await preview(object)); assert.equal((await draft(def.id)).latestVersion, 2);
});

test("audit failures roll back both publishing and abandoning a saved model draft, then retry survives restart", async () => {
  const def = await h.definition("配置回滚", schema(field("name")));
  let object = await draft(def.id); object.model.fields[0].required = true; object = await save(object);
  const impact = await preview(object);
  await h.db.query("CREATE FUNCTION reject_configuration_audit() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'deliberate configuration audit failure'; END; $$ LANGUAGE plpgsql");
  await h.db.query("CREATE TRIGGER reject_configuration_audit BEFORE INSERT ON configuration_events FOR EACH ROW EXECUTE FUNCTION reject_configuration_audit()");
  try {
    await publish(object, impact, 500); assert.deepEqual(await draft(def.id), object);
    await h.request(`/data-objects/${def.id}/discard-draft`, "POST", { expectedRevision: object.revision }, "admin", 500);
    assert.deepEqual(await draft(def.id), object);
    assert.equal((await h.db.query("SELECT count(*)::int AS count FROM data_object_versions WHERE definition_id=$1", [def.id])).rows[0].count, 1);
  } finally { await h.db.query("DROP TRIGGER reject_configuration_audit ON configuration_events"); }
  await publish(object, impact); await h.restart();
  object = await draft(def.id); assert.equal(object.latestVersion, 2);
  object.title = "待放弃"; object = await save(object);
  const restored = await h.request(`/data-objects/${def.id}/discard-draft`, "POST", { expectedRevision: object.revision }, "admin", 201);
  assert.equal(restored.title, "配置回滚"); assert.equal(restored.latestVersion, 2);
});

test("model impact and discard enforce workspace ownership, admin status and a published baseline", async () => {
  const object = await h.request("/data-objects", "POST", { title: "初始草稿", model: { version: 1, fields: [] } }, "admin", 201);
  await h.request(`/data-objects/${object.id}/discard-draft`, "POST", { expectedRevision: object.revision }, "admin", 400);
  const def = await h.definition("隔离检查", schema(field("name")));
  await h.request(`/data-objects/${def.id}/publish-preview`, "POST", { expectedRevision: 2 }, "editor", 403);
  await h.request(`/data-objects/${def.id}/publish-preview`, "POST", { expectedRevision: 1 }, "admin", 409);
  await h.db.query("UPDATE users SET workspace_id='elsewhere' WHERE username='admin'");
  try {
    await h.request(`/data-objects/${def.id}/publish-preview`, "POST", { expectedRevision: 2 }, "admin", 404);
    await h.request(`/data-objects/${def.id}/discard-draft`, "POST", { expectedRevision: 2 }, "admin", 404);
  } finally { await h.db.query("UPDATE users SET workspace_id='local' WHERE username='admin'"); }
});

test("model review serializes record creation so its aggregate counts describe one consistent state", async () => {
  const def = await h.definition("检查并发", schema(field("qty", "number")));
  await h.record(def.id, { qty: 2 });
  let object = await draft(def.id); object.model.fields[0].settings.max = 5; object = await save(object);
  const barrier = await h.db.pool.connect(); let reviewing: Promise<any> | undefined, writing: Promise<any> | undefined;
  const waitFor = async (condition: () => Promise<boolean>) => { const deadline = Date.now() + 5000; while (!await condition()) { if (Date.now() > deadline) assert.fail("expected database lock was not reached"); await new Promise(resolve => setTimeout(resolve, 20)); } };
  await barrier.query("BEGIN"); await barrier.query("LOCK TABLE records IN ACCESS EXCLUSIVE MODE");
  const blockerPid = (await barrier.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
  try {
    reviewing = preview(object); let previewPid = 0;
    await waitFor(async () => { previewPid = (await h.db.query("SELECT pid FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) AND query LIKE 'SELECT definition_version AS version,count%records%'", [blockerPid])).rows[0]?.pid; return !!previewPid; });
    writing = h.record(def.id, { qty: 9 });
    await waitFor(async () => !!(await h.db.query("SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) AND query LIKE 'SELECT * FROM definitions%FOR SHARE'", [previewPid])).rowCount);
    await barrier.query("COMMIT");
    const result = await reviewing; await writing;
    assert.deepEqual(result.records, [{ version: 1, count: 1, archived: 0, incompatible: 0 }]);
    const fresh = await preview(object);
    assert.deepEqual(fresh.records, [{ version: 1, count: 2, archived: 0, incompatible: 1 }]);
    await publish(object, result, 409);
  } finally { await barrier.query("ROLLBACK"); barrier.release(); await Promise.allSettled([reviewing, writing]); }
});
