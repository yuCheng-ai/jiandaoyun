import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { MigrationResourceSource } from "@platform/contracts";
import { harness, field, schema } from "./helpers";
const h = harness(); let admin: any;
const org = { scope: { mode: "custom", departmentIds: [], employeeIds: ["old-member"], roleIds: [], fieldId: "", includeChildren: true }, defaultMode: "none", defaultIds: [] };
const timestamp = "2025-01-02T03:04:05.000Z";
function fixture(): MigrationResourceSource {
  const oldSchema = schema(field("quantity", "number", { required: true, min: 0, max: 50 }), field("owner", "member", { organization: org }), field("oldField"), field("lines", "subform", { children: [field("amount", "number"), field("handler", "member", { organization: org })] }));
  const nextSchema = schema(field("quantity", "number", { required: true, min: 0, max: 5 }), field("newField", "text", { defaultValue: "不要补写历史默认值" }));
  const version = (version: number, schema: any) => ({ version, title: "历史表单", schema, workflow: { nodes: [], enabled: false }, extensions: { webhooks: [] }, publishedAt: timestamp });
  const versions = [version(1, oldSchema), version(2, nextSchema)];
  return { format: 1, namespace: randomUUID(), applicationId: "legacy-app", fingerprint: "a".repeat(64), application: { id: "legacy-app", name: "历史应用" }, forms: [{ id: "legacy-form", appId: "legacy-app", title: "历史表单", archived: true, schema: nextSchema, workflow: { nodes: [], enabled: false }, extensions: { webhooks: [] }, versions, published: versions[1], customNote: "原始附加配置保留" }], entries: [{ id: "old-record", formId: "legacy-form", definitionVersion: 1, createdBy: "old-member", createdAt: timestamp, updatedAt: timestamp, deletedAt: timestamp, status: "approved", history: [{ label: "审批", action: "通过", time: timestamp }], values: { quantity: 10, owner: "old-member", oldField: "仅旧版本存在的业务值", lines: [{ _rowId: "row-a", amount: 3, handler: "old-member" }, { amount: 7, handler: "old-member" }] } }, { id: "draft-record", formId: "legacy-form", definitionVersion: 2, createdBy: "old-member", createdAt: timestamp, status: "draft", history: [], values: {} }], access: {}, recordViews: {}, roles: [], orders: [], runs: [] };
}
async function setup(source = fixture(), historical = false) {
  const versions = new Set((source.forms[0].versions as any[]).map(item => item.version)).size;
  const records = source.entries.length, rows = source.entries.reduce((sum, entry: any) => sum + (Array.isArray(entry.values?.lines) ? entry.values.lines.length : 0), 0);
  let batch = await h.request("/migration-batches", "POST", { requestId: randomUUID(), source: { namespace: source.namespace, applicationId: source.applicationId, applicationName: "历史应用", fingerprint: source.fingerprint, identities: [{ kind: "member", sourceId: "old-member", name: "原成员", active: true, found: true }], counts: { forms: source.forms.length, versions, records, rows, issues: 0 } } }, "admin", 201);
  batch = await h.request(`/migration-batches/${batch.id}`, "PUT", { requestId: randomUUID(), expectedRevision: batch.revision, sourceFingerprint: source.fingerprint, choices: [{ kind: "member", sourceId: "old-member", mode: historical ? "historical" : "existing", targetId: admin.id }] });
  return { source, batch };
}
const prepare = (s: any, revision = 0, extra = {}, expected = 201) => h.request(`/migration-batches/${s.batch.id}/resources`, "POST", { requestId: randomUUID(), expectedBatchRevision: s.batch.revision, expectedResourceRevision: revision, source: s.source, ...extra }, "admin", expected);
const saved = async (id: string) => (await h.db.query("SELECT * FROM migration_resource_snapshots WHERE id=$1", [id])).rows[0];
before(async () => { await h.start(); admin = (await h.request("/users")).find((user: any) => user.username === "admin"); });
after(() => h.close());

test("exact historical versions preserve fields, values, deleted/draft states, rows and original snapshots", async () => {
  const s = await setup(), original = structuredClone(s.source);
  assert.deepEqual(await h.request(`/migration-batches/${s.batch.id}/resources`), { plan: null });
  const result = await prepare(s), snapshot = await saved(result.id);
  assert.deepEqual(snapshot.payload, original); assert.equal(result.importAvailable, false);
  assert.deepEqual(result.forms[0].versions.map((v: any) => v.targetVersion), [1, 2]);
  assert.deepEqual(result.records.map((r: any) => r.checked), [true, true]);
  assert.deepEqual(result.totals, { forms: 1, versions: 2, records: 2, rows: 2, archivedForms: 1, deletedRecords: 1, draftRecords: 1, historyEvents: 1, orders: 0, runs: 0 });
  const record = snapshot.projection.records[0]; assert.equal(record.version, 1); assert.equal(record.values.quantity, 10); assert.equal(record.values.oldField, "仅旧版本存在的业务值"); assert.equal(record.values.owner, admin.id); assert.equal(record.values.lines[0].handler, admin.id);
  assert.equal(record.deletedAt, timestamp); assert.equal(record.status, "approved"); assert.equal(record.history[0].action, "通过"); assert.equal(record.values.lines[0]._rowId, result.records[0].rows[0].targetId);
  assert.deepEqual(snapshot.projection.records[1].values, {}); assert.equal(snapshot.projection.records[1].status, "draft");
  assert.ok(!JSON.stringify(result).includes("仅旧版本存在的业务值")); assert.ok(!JSON.stringify(result).includes("不要补写历史默认值"));
});
test("stable keys survive retries, repeated checks and restart; original runtime tables remain untouched", async () => {
  const s = await setup(undefined, true), users = await h.request("/users");
  const counts = async () => (await h.db.query("SELECT (SELECT count(*) FROM definitions) AS definitions,(SELECT count(*) FROM records) AS records,(SELECT count(*) FROM grants) AS grants")).rows[0]; const before = await counts();
  const requestId = randomUUID(), a = await prepare(s, 0, { requestId }), retry = await prepare(s, 0, { requestId }); assert.equal(a.id, retry.id);
  const b = await prepare(s, 1); assert.notEqual(a.id, b.id); assert.equal(a.targetApplicationId, b.targetApplicationId); assert.deepEqual(a.records, b.records); assert.deepEqual(a.forms, b.forms);
  assert.equal((await prepare(s, 0, { requestId })).current, false);
  assert.deepEqual(await counts(), before); assert.deepEqual(await h.request("/users"), users);
  await h.restart(); assert.equal((await h.request(`/migration-batches/${s.batch.id}/resources`)).plan.id, b.id);
  await assert.rejects(h.db.query("DELETE FROM migration_resource_snapshots WHERE id=$1", [a.id]), /immutable/i);
});
test("permissions, namespace, stale batch/resource revisions and incomplete packages cannot write", async () => {
  const s = await setup(); await h.request(`/migration-batches/${s.batch.id}/resources`, "GET", undefined, "editor", 403);
  await h.request(`/migration-batches/${s.batch.id}/resources`, "POST", {}, "editor", 403);
  await prepare(s, 0, { expectedBatchRevision: 0 }, 409); await prepare(s, 0, { source: { ...s.source, fingerprint: "b".repeat(64) } }, 409);
  await prepare(s, 0, { source: { ...s.source, entries: [] } }, 409);
  assert.equal((await h.db.query("SELECT 1 FROM migration_resource_keys WHERE source_namespace=$1", [s.source.namespace])).rowCount, 0);
  const a = await prepare(s); await prepare(s, 0, {}, 409);
  await h.db.query("UPDATE migration_batches SET workspace_id='other' WHERE id=$1", [s.batch.id]);
  await h.request(`/migration-batches/${s.batch.id}/resources`, "GET", undefined, "admin", 404);
  assert.ok(await saved(a.id));
});
test("conflicting versions, unknown values, invalid numbers and duplicate row identities are reported without values", async () => {
  const source = fixture(), form: any = source.forms[0], entry: any = source.entries[0];
  entry.values.quantity = 100; entry.values.secretUnknown = "must-not-return"; entry.values.lines[1]._rowId = "row-a";
  const s = await setup(source), result = await prepare(s);
  assert.equal(result.records[0].checked, false); assert.ok(result.issues.some((issue: any) => issue.message.includes("重复的原行身份"))); assert.ok(result.issues.some((issue: any) => issue.message.includes("超出允许范围"))); assert.ok(result.issues.some((issue: any) => issue.fieldId === "secretUnknown"));
  assert.ok(!JSON.stringify(result).includes("must-not-return")); assert.equal((await saved(result.id)).projection.records.length, 1);
  form.versions.push({ ...structuredClone(form.versions[0]), title: "冲突版本" });
  source.namespace = randomUUID();
  const other = await setup(source), conflict = await prepare(other); assert.equal(conflict.forms[0].versions[0].variants, 2); assert.equal(conflict.records[0].checked, false); assert.equal(conflict.records[0].rows.length, 2);
});
test("missing version/creator and unfinished workflow or extension semantics remain explicit", async () => {
  const source = fixture(), form: any = source.forms[0]; source.namespace = randomUUID();
  form.workflow = { enabled: false, nodes: [{ id: "node" }] }; form.extensions = { payment: { enabled: false, keep: "原配置" } }; source.access = { "legacy-form": { groups: [{ id: "old-permission" }] } };
  (source.entries[1] as any).definitionVersion = 99; delete source.entries[1].createdBy;
  const result = await prepare(await setup(source));
  assert.ok(result.issues.some((item: any) => item.message.includes("发布版本不存在"))); assert.ok(result.issues.some((item: any) => item.message.includes("创建者缺失"))); assert.ok(result.issues.some((item: any) => item.message.includes("流程画布"))); assert.ok(result.issues.some((item: any) => item.message.includes("扩展配置"))); assert.ok(result.issues.some((item: any) => item.message.includes("访问权限")));
  assert.deepEqual((await saved(result.id)).payload.forms[0].extensions, form.extensions);
});
test("source row order changes regenerate only positional reservations and invalidate the prior plan", async () => {
  const s = await setup(), a = await prepare(s); const entry: any = s.source.entries[0]; entry.values.lines.reverse(); s.source.fingerprint = "b".repeat(64);
  s.batch = await h.request(`/migration-batches/${s.batch.id}/source`, "POST", { requestId: randomUUID(), expectedRevision: s.batch.revision, source: { ...s.batch.source, fingerprint: s.source.fingerprint } }, "admin", 201);
  assert.equal((await h.request(`/migration-batches/${s.batch.id}/resources`)).plan.current, false);
  const b = await prepare(s, a.revision), before = a.records[0].rows, after = b.records[0].rows;
  assert.equal(before[0].targetId, after[1].targetId); assert.notEqual(before[1].targetId, after[0].targetId); assert.equal(a.records[0].targetId, b.records[0].targetId);
  assert.deepEqual((await saved(a.id)).payload.entries[0].values.lines[0]._rowId, "row-a");
});
test("identity or organization updates mark prior resource checks stale", async () => {
  const s = await setup(), result = await prepare(s); assert.equal(result.current, true);
  s.batch = await h.request(`/migration-batches/${s.batch.id}`, "PUT", { requestId: randomUUID(), expectedRevision: s.batch.revision, sourceFingerprint: s.source.fingerprint, choices: s.batch.choices });
  assert.equal((await h.request(`/migration-batches/${s.batch.id}/resources`)).plan.current, false);
  const next = await prepare(s, result.revision); const org = await h.request("/organization"); await h.request("/organization", "PUT", { expectedRevision: org.revision, spec: org.spec });
  assert.equal((await h.request(`/migration-batches/${s.batch.id}/resources`)).plan.current, false); assert.ok(next.current);
});
test("snapshot insert failure rolls back key reservations and retry command", async () => {
  const s = await setup(), requestId = randomUUID();
  await h.db.query("CREATE FUNCTION reject_resource_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'snapshot failure'; END $$");
  await h.db.query("CREATE TRIGGER reject_resource_snapshot BEFORE INSERT ON migration_resource_snapshots FOR EACH ROW EXECUTE FUNCTION reject_resource_snapshot()");
  try { await prepare(s, 0, { requestId }, 500); } finally { await h.db.query("DROP TRIGGER reject_resource_snapshot ON migration_resource_snapshots"); }
  assert.equal((await h.db.query("SELECT 1 FROM migration_resource_keys WHERE source_namespace=$1", [s.source.namespace])).rowCount, 0);
  await prepare(s, 0, { requestId });
});
test("duplicate record identities exclude all ambiguous variants from the converted records", async () => {
  const source = fixture(); source.entries.push({ ...structuredClone(source.entries[0]), values: { quantity: 4 } });
  const result = await prepare(await setup(source));
  assert.equal(result.records.filter((item: any) => item.sourceId === "old-record").every((item: any) => !item.checked), true);
  assert.equal((await saved(result.id)).projection.records.some((item: any) => item.sourceId === "old-record"), false);
});

test("access conversion is archived with raw source while the API reveals only group summaries and never activates grants", async () => {
  const source = fixture();
  source.access = { "legacy-form": { membersEnabled: true, publicEnabled: false, allowMerged: false, filling: { enabled: false, startsAt: "", endsAt: "", limit: 8, allowRepeat: false }, groups: [
    { id: "export-original", name: "原导出组", enabled: true, archived: false, identities: ["old-member"], actions: ["view", "export"], scope: "custom", fields: { oldField: "read", lines: "read", amount: "read" }, filters: [{ id: "filter1", sourceFieldId: "oldField", operator: "contains", source: "constant", value: "不能出现在检查结果的筛选值" }] },
    { id: "create-original", name: "原仅添加组", enabled: false, archived: true, identities: ["old-member"], actions: ["create"], scope: "all", fields: {}, filters: [] },
  ] } };
  const s = await setup(source), before = structuredClone(source);
  const counts = async () => (await h.db.query("SELECT (SELECT count(*) FROM grants) grants,(SELECT count(*) FROM subject_grants) subject_grants,(SELECT count(*) FROM users) users,(SELECT count(*) FROM definitions) definitions,(SELECT count(*) FROM records) records")).rows[0];
  const baseline = await counts(), requestId = randomUUID(), plan = await prepare(s, 0, { requestId }), retry = await prepare(s, 0, { requestId });
  assert.equal(retry.id, plan.id); assert.deepEqual(retry.access, plan.access);
  assert.equal(plan.access[0].checked, true); assert.equal(plan.access[0].executionReady, false); assert.equal(plan.importAvailable, false);
  assert.deepEqual(plan.access[0].groups.map((g: any) => g.id), ["export-original", "create-original"]);
  assert.ok(plan.issues.some((i: any) => i.kind === "unsupported" && i.version === "访问权限"));
  assert.ok(!JSON.stringify(plan).includes("不能出现在检查结果的筛选值"));
  const snapshot = await saved(plan.id);
  assert.deepEqual(snapshot.payload, before); assert.equal(snapshot.projection.forms[0].access.groups[0].filters[0].value, "不能出现在检查结果的筛选值");
  assert.equal(snapshot.projection.forms[0].access.groups[0].subjects[0].id, admin.id);
  assert.equal(snapshot.projection.forms[0].access.groups[0].fields.oldField, "read");
  assert.deepEqual(await counts(), baseline);
  await h.restart(); assert.deepEqual((await h.request(`/migration-batches/${s.batch.id}/resources`)).plan.access, plan.access);
});

test("one broken group excludes the entire access projection and reports the affected group and field", async () => {
  const source = fixture(); source.access = { "legacy-form": { groups: [
    { id: "valid", name: "有效配置", enabled: true, archived: false, identities: ["old-member"], actions: ["view"], scope: "self", filters: [], fields: { oldField: "read" } },
    { id: "broken", name: "断开的权限字段", enabled: false, archived: true, identities: ["old-member"], actions: ["view"], scope: "all", filters: [], fields: { missingColumn: "edit" } },
  ] } };
  const plan = await prepare(await setup(source));
  assert.equal(plan.access[0].checked, false); assert.deepEqual(plan.access[0].groups.map((g: any) => g.checked), [true, false]);
  assert.ok(plan.issues.some((i: any) => i.groupId === "broken" && i.fieldId === "missingColumn"));
  assert.equal((await saved(plan.id)).projection.forms[0].access, undefined);
});
