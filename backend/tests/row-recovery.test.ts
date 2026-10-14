import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pageForModel } from "@platform/contracts";
import { harness, field, schema } from "./helpers";
const h = harness();
let definition: any, record: any;
before(async () => {
  await h.start(); definition = await h.definition("明细恢复", schema(field("name"), field("lines", "subform", { children: [field("item"), field("quantity", "number"), field("private_note")] })));
  record = await h.record(definition.id, { name: "恢复验证", lines: [{ item: "A", quantity: 2, private_note: "仅授权成员可见" }] });
});
after(() => h.close());
const remove = (detail: any) => ({ requestId: randomUUID(), rows: [{ action: "remove", subformId: "lines", rowId: detail.record.values.lines[0]._rowId, expectedRevision: detail.record.rowRevisions.lines, expectedCells: detail.record.cellRevisions }] });
test("deleted rows are recoverable with their original identity and cannot accept stale pre-deletion cell edits", async () => {
  const row = record.record.values.lines[0];
  const removed = await h.request(`/records/${record.record.id}`, "PATCH", remove(record));
  const list = await h.request(`/records/${record.record.id}/removed-rows`);
  assert.equal(list.length, 1); assert.equal(list[0].rowId, row._rowId); assert.equal(list[0].restorable, true);
  const command = { requestId: randomUUID(), rows: [{ action: "restore", subformId: "lines", rowId: row._rowId, eventId: list[0].eventId, expectedRevision: removed.record.rowRevisions.lines }] };
  const restored = await h.request(`/records/${record.record.id}`, "PATCH", command);
  assert.deepEqual(restored.record.values.lines[0], row);
  assert.ok(restored.record.cellRevisions[`lines/${row._rowId}/item`] > record.record.cellRevisions[`lines/${row._rowId}/item`]);
  assert.deepEqual(await h.request(`/records/${record.record.id}`, "PATCH", command), restored);
  assert.deepEqual(await h.request(`/records/${record.record.id}/removed-rows`), []);
  await h.request(`/records/${record.record.id}`, "PATCH", { requestId: randomUUID(), changes: [{ subformId: "lines", rowId: row._rowId, fieldId: "item", expectedRevision: 1, value: "过期编辑" }] }, "admin", 409);
  const removedAgain = await h.request(`/records/${record.record.id}`, "PATCH", remove(restored));
  command.requestId = randomUUID(); command.rows[0]!.expectedRevision = removedAgain.record.rowRevisions.lines;
  await h.request(`/records/${record.record.id}`, "PATCH", command, "admin", 409);
  assert.equal((await h.request(`/records/${record.record.id}/removed-rows`)).length, 1);
});
test("member and page column restrictions hide deleted values and prevent restoring an inaccessible row", async () => {
  const list = await h.request(`/records/${record.record.id}/removed-rows`), detail = await h.request(`/records/${record.record.id}`);
  const user = (await h.request("/users")).find((item: any) => item.username === "editor");
  await h.permissionGroup(definition.id, {
    id: "member_" + user.id,
    subjects: [{ kind: "member", id: user.id }],
    scope: "all",
    fields: {
      name: "edit",
      lines: "edit",
      item: "edit",
      quantity: "edit",
      private_note: "hidden",
    },
    actions: ["view", "create", "edit"],
  });
  assert.deepEqual(await h.request(`/records/${record.record.id}/removed-rows`, "GET", undefined, "editor"), []);
  const command = { requestId: randomUUID(), rows: [{ action: "restore", subformId: "lines", rowId: list[0].rowId, eventId: list[0].eventId, expectedRevision: detail.record.rowRevisions.lines }] };
  await h.request(`/records/${record.record.id}`, "PATCH", command, "editor", 403);
  const model = (await h.request(`/data-objects/${definition.id}/draft`)).model, pageSchema = pageForModel(model);
  pageSchema.controls[1]!.children = pageSchema.controls[1]!.children.filter(control => control.binding!.fieldId !== "private_note");
  const page = await h.request("/pages", "POST", { title: "只显示部分列", definitionId: definition.id, definitionVersion: 1, schema: pageSchema }, "admin", 201);
  await h.request(`/pages/${page.id}/publish`, "POST", { expectedRevision: page.revision }, "admin", 201);
  assert.deepEqual(await h.request(`/pages/${page.id}/records/${record.record.id}/removed-rows?version=1`), []);
  await h.request(`/pages/${page.id}/records/${record.record.id}`, "PATCH", { ...command, pageVersion: 1 }, "admin", 403);
});
test("restoration detects concurrent row changes and rolls back together with unrelated cell edits", async () => {
  const list = await h.request(`/records/${record.record.id}/removed-rows`), before = await h.request(`/records/${record.record.id}`);
  const added = await h.request(`/records/${record.record.id}`, "PATCH", { requestId: randomUUID(), rows: [{ action: "add", subformId: "lines", expectedRevision: before.record.rowRevisions.lines, values: { item: "B", quantity: 1 } }] });
  const command = { requestId: randomUUID(), rows: [{ action: "restore", subformId: "lines", rowId: list[0].rowId, eventId: list[0].eventId, expectedRevision: before.record.rowRevisions.lines }], changes: [{ fieldId: "name", value: "不能部分写入", expectedRevision: 1 }] };
  await h.request(`/records/${record.record.id}`, "PATCH", command, "admin", 409);
  assert.deepEqual((await h.request(`/records/${record.record.id}`)).record, added.record);
  command.rows[0]!.expectedRevision = added.record.rowRevisions.lines;
  const result = await h.request(`/records/${record.record.id}`, "PATCH", command);
  assert.equal(result.record.values.lines.length, 2);
  await h.restart();
  assert.deepEqual(await h.request(`/records/${record.record.id}`, "PATCH", command), result);
});
