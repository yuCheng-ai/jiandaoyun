import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { harness, field, schema } from "./helpers";

const h = harness();
before(() => h.start());
after(() => h.close());
const rows = (count: number) => Array.from({ length: count }, (_, i) => ({ item: `物料${i + 1}`, qty: i }));
const layout = () => schema(field("title"), field("lines", "subform", { children: [field("item"), field("qty", "number")] }));

test("definition and page creation accept 200 rows, reject 201 without retaining a command, and submit the same draft", async () => {
  const definition = await h.definition("200行新建验收", layout());
  const active = await h.record(definition.id, { title: "200行", lines: rows(200) });
  assert.equal(active.record.values.lines.length, 200);
  const requestId = randomUUID();
  await h.request(`/definitions/${definition.id}/records`, "POST", { requestId, version: 1, values: { title: "超限", lines: rows(201) } }, "admin", 400);
  assert.equal((await h.db.query("SELECT 1 FROM commands WHERE request_id=$1", [requestId])).rowCount, 0);
  const page = (await h.request(`/pages?definitionId=${definition.id}`))[0];
  const draft = await h.request(`/pages/${page.id}/records`, "POST", { requestId: randomUUID(), pageVersion: 1, state: "draft", values: { title: "草稿200行", lines: rows(200) } }, "admin", 201);
  const submitted = await h.request(`/pages/${page.id}/records/${draft.record.id}/submit`, "POST", { requestId: randomUUID(), pageVersion: 1, expectedRevision: draft.record.revision }, "admin", 201);
  assert.equal(submitted.record.id, draft.record.id);
  assert.equal(submitted.record.values.lines.length, 200);
  assert.deepEqual(submitted.record.values.lines.map((row: any) => row._rowId), draft.record.values.lines.map((row: any) => row._rowId));
  await h.request(`/pages/${page.id}/records`, "POST", { requestId: randomUUID(), pageVersion: 1, state: "draft", values: { lines: rows(201) } }, "admin", 400);
});

test("growth and restoration check the final count transactionally, preserving cells and row identity on failure", async () => {
  const definition = await h.definition("200行操作验收", layout());
  let detail = await h.record(definition.id, { title: "原值", lines: rows(199) });
  const path = `/records/${detail.record.id}`;
  const add = () => ({ action: "add", subformId: "lines", expectedRevision: detail.record.rowRevisions.lines, values: { item: "新增", qty: 0 } });
  const failedId = randomUUID();
  await h.request(path, "PATCH", { requestId: failedId, changes: [{ fieldId: "title", expectedRevision: detail.record.cellRevisions.title, value: "不能部分写入" }], rows: [add(), add()] }, "admin", 400);
  assert.deepEqual((await h.request(path)).record, detail.record);
  assert.equal((await h.db.query("SELECT 1 FROM commands WHERE request_id=$1", [failedId])).rowCount, 0);
  detail = await h.request(path, "PATCH", { requestId: randomUUID(), rows: [add()], changes: [] });
  assert.equal(detail.record.values.lines.length, 200);
  const original = detail.record.values.lines[0];
  detail = await h.request(path, "PATCH", { requestId: randomUUID(), rows: [{ action: "remove", subformId: "lines", rowId: original._rowId, expectedRevision: detail.record.rowRevisions.lines, expectedCells: Object.fromEntries(["item", "qty"].map(id => [`lines/${original._rowId}/${id}`, detail.record.cellRevisions[`lines/${original._rowId}/${id}`]])) }], changes: [] });
  assert.equal(detail.record.values.lines.length, 199);
  const removed = (await h.request(`${path}/removed-rows`)).find((row: any) => row.rowId === original._rowId);
  detail = await h.request(path, "PATCH", { requestId: randomUUID(), rows: [add()], changes: [] });
  await h.request(path, "PATCH", { requestId: randomUUID(), rows: [{ action: "restore", subformId: "lines", rowId: original._rowId, eventId: removed.eventId, expectedRevision: detail.record.rowRevisions.lines }], changes: [] }, "admin", 400);
  assert.deepEqual((await h.request(path)).record, detail.record);
  assert.equal(detail.record.values.lines.some((row: any) => row._rowId === original._rowId), false);
});
