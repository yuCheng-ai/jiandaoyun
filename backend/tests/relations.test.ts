import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { field, harness, schema } from "./helpers";
const h = harness(), api = h.request;
let source: any, target: any, users: any[], sourceRecord: any, targetRecord: any, relation: any, linked: any;
const sourceSchema = schema(field("name"), field("region"), field("quoted", "number"), field("lines", "subform", { children: [field("item"), field("quantity", "number"), field("cost", "number")] }));
const targetSchema = schema(field("name"), field("region"), field("price", "number"), field("secret"));
const sourceFields = { name: "edit", region: "edit", quoted: "edit", lines: "edit", item: "edit", quantity: "edit", cost: "edit" };
const targetFields = { name: "read", region: "read", price: "read", secret: "hidden" };
const sourceGrant = (extra: any = {}) => ({ userId: users.find(u => u.username === "editor").id, read: true, create: true, edit: true, remove: true, scope: "all", fields: sourceFields, relations: { [relation.id]: "edit" }, ...extra });
const targetGrant = (extra: any = {}) => ({ userId: users.find(u => u.username === "editor").id, read: true, create: false, edit: false, scope: "all", fields: targetFields, ...extra });
const relationSpec = (extra: any = {}) => ({ title: "业务资料", sourceDefinitionId: source.id, targetDefinitionId: target.id, cardinality: "one", inverseCardinality: "many", labelFieldId: "name", columns: ["price", "secret"], filters: [{ id: "regionFilter", sourceFieldId: "region", operator: "equals", source: "field", value: "region" }], mappings: [{ fromTargetFieldId: "price", toSourceFieldId: "quoted" }], valueMode: "snapshot", ...extra });
const linkBody = (record = sourceRecord, selected = targetRecord, extra: any = {}) => ({ requestId: randomUUID(), targetRecordId: selected.record.id, expectedCells: record.record.cellRevisions, ...extra });
const linkPath = (record = sourceRecord, rel = relation) => `/records/${record.record.id}/relations/${rel.id}/links`;
before(async () => {
  await h.start(); users = await api("/users"); source = await h.definition("业务单", sourceSchema); target = await h.definition("业务资料", targetSchema);
  sourceRecord = await h.record(source.id, { name: "来源一", region: "华东", quoted: 0, lines: [{ item: "A", quantity: 2, cost: 0 }] });
  targetRecord = await h.record(target.id, { name: "资料 A", region: "华东", price: 120, secret: "绝不能出现在成员响应" });
  await h.record(target.id, { name: "其他区域", region: "华北", price: 80, secret: "另一个秘密" });
});
after(() => h.close());
test("relation configuration validates types, identities, mappings and publication versions", async () => {
  await api("/relations", "POST", { spec: relationSpec() }, "editor", 403);
  await api("/relations", "POST", { spec: relationSpec({ labelFieldId: "missing" }) }, "admin", 400);
  await api("/relations", "POST", { spec: relationSpec({ cardinality: "many" }) }, "admin", 400);
  await api("/relations", "POST", { spec: relationSpec({ mappings: [{ fromTargetFieldId: "price", toSourceFieldId: "name" }] }) }, "admin", 400);
  relation = await h.relation(relationSpec());
  await api(`/relations/${relation.id}/publish`, "POST", { expectedRevision: 1 }, "admin", 409);
  await assert.rejects(h.db.query("UPDATE relation_versions SET spec='{}' WHERE relation_id=$1", [relation.id]), /immutable/);
  await h.grant(source.id, sourceGrant());
  await h.grant(target.id, targetGrant());
});
test("candidate filtering runs on persisted values and masks inaccessible columns", async () => {
  const page = await api(`/records/${sourceRecord.record.id}/relations/${relation.id}/candidates`, "GET", undefined, "editor");
  assert.equal(page.items.length, 1); assert.equal(page.items[0].recordId, targetRecord.record.id); assert.equal(page.items[0].values.secret, undefined);
  assert.ok(!JSON.stringify(page).includes("秘密"));
  await h.grant(source.id, sourceGrant({ relations: {} }));
  await api(`/records/${sourceRecord.record.id}/relations/${relation.id}/candidates`, "GET", undefined, "editor", 403);
  await h.grant(source.id, sourceGrant());
  await h.grant(target.id, targetGrant({ fields: { ...targetFields, region: "hidden" } }));
  await api(`/records/${sourceRecord.record.id}/relations/${relation.id}/candidates`, "GET", undefined, "editor", 403);
  await h.grant(target.id, targetGrant());
});
test("readonly or stale mapped fields roll back link creation and all data changes", async () => {
  await h.grant(source.id, sourceGrant({ fields: { ...sourceFields, quoted: "read" } }));
  await api(linkPath(), "POST", linkBody(), "editor", 403);
  assert.equal((await h.db.query("SELECT count(*)::integer AS count FROM record_links")).rows[0].count, 0);
  await h.grant(source.id, sourceGrant());
  await api(linkPath(), "POST", linkBody(sourceRecord, targetRecord, { expectedCells: { quoted: 99 } }), "editor", 409);
  assert.equal((await api(`/records/${sourceRecord.record.id}`)).record.values.quoted, 0);
});
test("linking atomically stores identity, mapped values, snapshot, audit and an idempotent receipt", async () => {
  const body = linkBody();
  linked = await api(linkPath(), "POST", body, "editor", 201);
  assert.equal(linked.record.record.values.quoted, 120); assert.equal(linked.link.values.secret, undefined);
  const replay = await api(linkPath(), "POST", { expectedCells: body.expectedCells, targetRecordId: body.targetRecordId, requestId: body.requestId }, "editor", 201);
  assert.equal(replay.link.id, linked.link.id); assert.equal(replay.record.record.cellRevisions.quoted, 2);
  assert.equal((await api(`/records/${sourceRecord.record.id}/events`)).length, 2);
  assert.equal((await h.db.query("SELECT count(*)::integer AS count FROM relation_events WHERE source_record_id=$1", [sourceRecord.record.id])).rows[0].count, 1);
  await api(linkPath(), "POST", linkBody(), "editor", 409);
});
test("snapshot reads keep captured values but apply current target permissions", async () => {
  await api(`/records/${targetRecord.record.id}`, "PATCH", { requestId: randomUUID(), changes: [{ fieldId: "price", expectedRevision: 1, value: 150 }, { fieldId: "name", expectedRevision: 1, value: "资料 A 更新" }] });
  let groups = await api(`/records/${sourceRecord.record.id}/relations`, "GET", undefined, "editor");
  assert.equal(groups[0].links[0].values.price, 120); assert.equal(groups[0].links[0].label, "资料 A");
  assert.equal(groups[0].relation.spec.filters.length, 0); assert.equal(groups[0].links[0].values.secret, undefined);
  await h.grant(target.id, targetGrant({ fields: { ...targetFields, price: "hidden" } }));
  groups = await api(`/records/${sourceRecord.record.id}/relations`, "GET", undefined, "editor");
  assert.equal(groups[0].links[0].values.price, undefined); assert.equal(groups[0].columnLabels.price, undefined);
  await h.grant(target.id, targetGrant({ read: false }));
  groups = await api(`/records/${sourceRecord.record.id}/relations`, "GET", undefined, "editor");
  assert.deepEqual(groups[0].links[0].values, {}); assert.equal(groups[0].links[0].restricted, true);
  await h.grant(target.id, targetGrant());
});
test("a republished live rule affects new links without rewriting historical snapshot links", async () => {
  const saved = await api(`/relations/${relation.id}`, "PUT", { expectedRevision: relation.revision, spec: relationSpec({ valueMode: "live" }) });
  relation = await api(`/relations/${relation.id}/publish`, "POST", { expectedRevision: saved.revision }, "admin", 201);
  const newRecord = await h.record(source.id, { name: "来源二", region: "华东", quoted: 0 });
  const result = await api(linkPath(newRecord), "POST", linkBody(newRecord), "editor", 201);
  assert.equal(result.link.values.price, 150); assert.equal(result.link.relationVersion, 2);
  await api(`/records/${targetRecord.record.id}`, "PATCH", { requestId: randomUUID(), changes: [{ fieldId: "price", expectedRevision: 2, value: 180 }] });
  const live = await api(`/records/${newRecord.record.id}/relations`, "GET", undefined, "editor");
  const old = await api(`/records/${sourceRecord.record.id}/relations`, "GET", undefined, "editor");
  assert.equal(live[0].links[0].values.price, 180); assert.equal(old[0].links[0].values.price, 120);
  assert.equal(live[0].links[0].valueMode, "live"); assert.equal(old[0].links[0].valueMode, "snapshot");
});
test("referenced field removal and record archival are prevented before integrity is lost", async () => {
  await api(`/definitions/${target.id}`, "PUT", { title: "不可删字段", expectedRevision: 2, schema: schema(field("name"), field("region")) }, "admin", 409);
  const current = await api(`/records/${targetRecord.record.id}`);
  await api(`/records/${targetRecord.record.id}/archive`, "POST", { requestId: randomUUID(), expectedRevision: current.record.revision }, "admin", 409);
});
test("one-to-one ownership is enforced under competing transactions", async () => {
  const owned = await h.relation(relationSpec({ title: "唯一归属", inverseCardinality: "one", mappings: [], filters: [] }));
  const a = await h.record(source.id, { name: "竞争 A" }), b = await h.record(source.id, { name: "竞争 B" });
  const attempt = async (record: any) => {
    try { return await api(linkPath(record, owned), "POST", linkBody(record), "admin", 201); } catch (error) { assert.match(String(error), /目标记录已归属其他来源/); return null; }
  };
  const results = await Promise.all([attempt(a), attempt(b)]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal((await h.db.query("SELECT count(*)::integer AS count FROM record_links WHERE relation_id=$1", [owned.id])).rows[0].count, 1);
});
test("source-row relationships block deleting the referenced row; unlink keeps mapped evidence", async () => {
  const rowRelation = await h.relation(relationSpec({ title: "明细资料", sourceSubformId: "lines", mappings: [{ fromTargetFieldId: "price", toSourceFieldId: "cost" }], filters: [] }));
  const current = await api(`/records/${sourceRecord.record.id}`), rowId = current.record.values.lines[0]._rowId;
  const result = await api(linkPath(current, rowRelation), "POST", linkBody(current, targetRecord, { sourceRowId: rowId }), "admin", 201);
  assert.equal(result.record.record.values.lines[0].cost, 180);
  await api(`/records/${current.record.id}`, "PATCH", { requestId: randomUUID(), rows: [{ action: "remove", subformId: "lines", rowId, expectedRevision: 1, expectedCells: result.record.record.cellRevisions }] }, "admin", 409);
  const removed = await api(`${linkPath(current, rowRelation)}/${result.link.id}/remove`, "POST", { requestId: randomUUID() }, "admin", 201);
  assert.equal(removed.record.record.values.lines[0].cost, 180);
  const now = removed.record;
  const deleted = await api(`/records/${current.record.id}`, "PATCH", { requestId: randomUUID(), rows: [{ action: "remove", subformId: "lines", rowId, expectedRevision: 1, expectedCells: now.record.cellRevisions }] });
  assert.equal(deleted.record.values.lines.length, 0); assert.equal(deleted.record.rowRevisions.lines, 2);
});
test("row additions preserve old identities and row removal detects unseen column edits", async () => {
  const record = await h.record(source.id, { name: "结构并发", lines: [{ item: "原有", quantity: 1, cost: 0 }] });
  const row = record.record.values.lines[0];
  const added = await api(`/records/${record.record.id}`, "PATCH", { requestId: randomUUID(), rows: [{ action: "add", subformId: "lines", expectedRevision: 1, values: { item: "新增", quantity: 2 } }] });
  assert.equal(added.record.values.lines[0]._rowId, row._rowId); assert.notEqual(added.record.values.lines[1]._rowId, row._rowId);
  await api(`/records/${record.record.id}`, "PATCH", { requestId: randomUUID(), changes: [{ subformId: "lines", rowId: row._rowId, fieldId: "quantity", expectedRevision: 1, value: 5 }] });
  await api(`/records/${record.record.id}`, "PATCH", { requestId: randomUUID(), rows: [{ action: "remove", subformId: "lines", rowId: row._rowId, expectedRevision: 2, expectedCells: added.record.cellRevisions }] }, "admin", 409);
  await api(`/records/${record.record.id}`, "PATCH", { requestId: randomUUID(), rows: [{ action: "add", subformId: "lines", expectedRevision: 1, values: { item: "过期" } }] }, "admin", 409);
  const current = await api(`/records/${record.record.id}`); assert.equal(current.record.values.lines.length, 2); assert.equal(current.record.values.lines[0].quantity, 5);
});
test("unreferenced records archive with version checks; relations and their evidence survive restart", async () => {
  const spare = await h.record(target.id, { name: "可归档" });
  await api(`/records/${spare.record.id}/archive`, "POST", { requestId: randomUUID(), expectedRevision: 1 }, "admin", 201);
  await api(`/records/${spare.record.id}`, "GET", undefined, "admin", 404);
  await h.restart();
  const groups = await api(`/records/${sourceRecord.record.id}/relations`, "GET", undefined, "editor");
  assert.equal(groups.find((g: any) => g.relation.id === relation.id).links[0].label, "资料 A");
});
