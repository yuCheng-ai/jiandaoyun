import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pageForModel } from "@platform/contracts";
import { field, harness, schema } from "./helpers";
const h = harness(), api = h.request;
let source: any, target: any, record: any, chosen: any, relation: any, page: any, readPage: any, hiddenPage: any, member: any;
const spec = () => ({ title: "关联资料", sourceDefinitionId: source.id, targetDefinitionId: target.id, cardinality: "one", inverseCardinality: "many", labelFieldId: "name", columns: ["price", "secret"], filters: [{ id: "region", sourceFieldId: "region", operator: "equals", source: "field", value: "region" }], mappings: [{ fromTargetFieldId: "price", toSourceFieldId: "price" }], valueMode: "live" });
const sourceGrant = (extra: any = {}) => ({ userId: member.id, read: true, create: false, edit: true, scope: "all", fields: { name: "edit", region: "edit", price: "edit", hidden: "hidden" }, relations: { [relation.id]: "edit" }, ...extra });
const path = (p = page) => `/pages/${p.id}/records/${record.record.id}/relations`;
const command = (extra: any = {}) => ({ requestId: randomUUID(), pageVersion: 1, expectedTargetRevision: chosen.record.revision, expectedRelationVersion: relation.latestVersion, targetRecordId: chosen.record.id, expectedCells: record.record.cellRevisions, ...extra });
before(async () => {
  await h.start();
  source = await h.definition("业务记录", schema(field("name"), field("region"), field("price", "number"), field("hidden")));
  target = await h.definition("资料记录", schema(field("name"), field("region"), field("price", "number"), field("secret")));
  record = await h.record(source.id, { name: "来源名称", region: "华东", price: 0, hidden: "页面不可泄露" });
  chosen = await h.record(target.id, { name: "目标名称", region: "华东", price: 42, secret: "目标秘密" });
  relation = await h.relation(spec());
  const model = (await api(`/data-objects/${source.id}/draft`)).model;
  const makePage = async (mode: string) => {
    const layout = pageForModel(model); layout.controls = layout.controls.filter(c => c.binding?.fieldId !== "hidden" && !(mode === "hidden" && c.binding?.fieldId === "price"));
    if (mode === "read") layout.controls.find(c => c.binding?.fieldId === "price")!.properties.editable = false;
    const draft = await api("/pages", "POST", { title: mode, definitionId: source.id, definitionVersion: 1, schema: layout }, "admin", 201);
    return api(`/pages/${draft.id}/publish`, "POST", { expectedRevision: draft.revision }, "admin", 201);
  };
  page = await makePage("edit"); readPage = await makePage("read"); hiddenPage = await makePage("hidden");
  member = (await api("/users")).find((u: any) => u.username === "editor");
  await h.grant(source.id, sourceGrant());
  await h.grant(target.id, { userId: member.id, read: true, edit: false, create: false, scope: "all", fields: { name: "read", region: "read", price: "read", secret: "hidden" } });
});
after(() => h.close());
test("a retried relation draft creation returns the same identity", async () => {
  const body = { requestId: randomUUID(), spec: { ...spec(), title: "草稿重试" } };
  const first = await api("/relations", "POST", body, "admin", 201);
  const retry = await api("/relations", "POST", body, "admin", 201);
  assert.equal(retry.id, first.id);
  await api("/relations", "POST", { ...body, spec: { ...body.spec, title: "不一致重试" } }, "admin", 409);
});
test("page relation candidates include authorized labels and explicit mapping previews", async () => {
  const result = await api(`${path()}/${relation.id}/candidates?version=1`, "GET", undefined, "editor");
  assert.equal(result.items.length, 1); assert.equal(result.items[0].revision, 1);
  assert.deepEqual(result.items[0].mappings, [{ fieldId: "price", label: "price", before: 0, value: 42, beforeLabel: "0", valueLabel: "42" }]);
  assert.equal(result.items[0].displayValues.secret, undefined);
  assert.equal(result.columnLabels.secret, undefined); assert.ok(!JSON.stringify(result).includes("秘密"));
  for (const restricted of [readPage, hiddenPage]) {
    const groups = await api(`${path(restricted)}?version=1`, "GET", undefined, "editor");
    assert.equal(groups[0].canLink, false);
    await api(`${path(restricted)}/${relation.id}/candidates?version=1`, "GET", undefined, "editor", 403);
    await api(`${path(restricted)}/${relation.id}/links`, "POST", command(), "editor", 403);
  }
  assert.equal((await api(`/records/${record.record.id}`)).record.values.price, 0);
});
test("target or relation changes after selection reject linking without partial mappings", async () => {
  await api(`${path()}/${relation.id}/links`, "POST", command({ expectedTargetRevision: 99 }), "editor", 409);
  await api(`${path()}/${relation.id}/links`, "POST", command({ expectedRelationVersion: 99 }), "editor", 409);
  assert.equal((await h.db.query("SELECT count(*)::int AS n FROM record_links")).rows[0].n, 0);
  assert.equal((await api(`/records/${record.record.id}`)).record.values.price, 0);
});
test("page-scoped linking and replay return only page-authorized fields; reverse view checks source access", async () => {
  const body = command();
  const result = await api(`${path()}/${relation.id}/links`, "POST", body, "editor", 201);
  assert.equal(result.record.record.values.price, 42); assert.equal(result.record.record.values.hidden, undefined);
  assert.equal(result.record.page.id, page.id); assert.equal(result.link.values.secret, undefined);
  const replay = await api(`${path()}/${relation.id}/links`, "POST", body, "editor", 201);
  assert.equal(replay.link.id, result.link.id); assert.equal(replay.record.record.cellRevisions.price, 2);
  let incoming = await api(`/records/${chosen.record.id}/relations`, "GET", undefined, "editor");
  assert.equal(incoming[0].direction, "incoming"); assert.equal(incoming[0].links[0].sourceRecordId, record.record.id);
  assert.equal(incoming[0].links[0].values.hidden, undefined);
  await h.grant(source.id, sourceGrant({ relations: {} }));
  assert.deepEqual(await api(`/records/${chosen.record.id}/relations`, "GET", undefined, "editor"), []);
  await h.grant(source.id, sourceGrant({ scope: "self" }));
  assert.deepEqual(await api(`/records/${chosen.record.id}/relations`, "GET", undefined, "editor"), []);
  await h.grant(source.id, sourceGrant());
  const removed = await api(`${path()}/${relation.id}/links/${result.link.id}/remove`, "POST", { pageVersion: 1, requestId: randomUUID() }, "editor", 201);
  assert.equal(removed.record.record.values.hidden, undefined); assert.equal(removed.record.record.values.price, 42);
  assert.deepEqual(await api(`/records/${chosen.record.id}/relations`, "GET", undefined, "editor"), []);
});
