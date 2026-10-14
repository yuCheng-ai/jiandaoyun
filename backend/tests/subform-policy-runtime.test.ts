import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { newSubformPermissions, pageForModel, type SubformPermissions } from '@platform/contracts';
import { harness, field, schema } from './helpers';
const h = harness();
let editor: any;
before(async () => { await h.start(); editor = (await h.request('/users')).find((u: any) => u.username === 'editor'); });
after(() => h.close());
async function setup(policy?: SubformPermissions) {
  const definition = await h.definition('子表权限', schema(field('name'), field('lines', 'subform', {
    children: [field('item'), field('amount', 'number')], ...(policy ? { subformPermissions: policy } : {})
  })));
  await h.permissionGroup(definition.id, {
    id: "member_" + editor.id,
    subjects: [{ kind: "member", id: editor.id }],
    scope: "all",
    fields: { name: "edit", lines: "edit", item: "edit", amount: "edit" },
    actions: ["view", "create", "edit"],
  });
  const record = await h.record(definition.id, { name: '保留', lines: [{ item: 'A', amount: 1 }, { item: 'B', amount: 2 }] }, 'editor');
  const defaultPage = (await h.request(`/pages?definitionId=${definition.id}`))[0];
  return { definition, record, defaultPage };
}
async function page(definition: any, policy: SubformPermissions) {
  const model = (await h.request(`/data-objects/${definition.id}/draft`)).model;
  const layout = pageForModel(model);
  layout.controls.find(c => c.binding?.fieldId === 'lines')!.properties.subformPermissions = policy;
  const draft = await h.request('/pages', 'POST', { definitionId: definition.id, definitionVersion: 1, title: '处理表单', schema: layout }, 'admin', 201);
  await h.request(`/pages/${draft.id}/publish`, 'POST', { expectedRevision: draft.revision }, 'admin', 201);
  return draft;
}
const patch = (path: string, body: any, expected = 200) => h.request(path, 'PATCH', { requestId: randomUUID(), changes: [], ...body }, 'editor', expected);
test('published page restrictions block existing-cell edits, removal and insertion atomically while permitted append and retry work', async () => {
  const x = await setup({ add: true, insert: false, editExisting: false, deleteExisting: false });
  const path = `/pages/${x.defaultPage.id}/records/${x.record.record.id}`, rowId = x.record.record.values.lines[0]._rowId;
  const before = await h.request(path, 'GET', undefined, 'editor');
  assert.deepEqual(before.rowActions.lines, { add: true, insert: false, editExisting: false, remove: false });
  await patch(path, { pageVersion: 1, changes: [{ fieldId: 'name', value: '不应保存', expectedRevision: 1 }, { subformId: 'lines', rowId, fieldId: 'amount', expectedRevision: 1, value: 10 }] }, 403);
  await patch(path, { pageVersion: 1, rows: [{ action: 'remove', subformId: 'lines', rowId, expectedRevision: 1, expectedCells: before.record.cellRevisions }] }, 403);
  await patch(path, { pageVersion: 1, rows: [{ action: 'insert', subformId: 'lines', beforeRowId: rowId, expectedRevision: 1, values: { item: 'C' } }] }, 403);
  assert.deepEqual((await h.request(path, 'GET', undefined, 'editor')).record, before.record);
  const body = { pageVersion: 1, requestId: randomUUID(), rows: [{ action: 'add', subformId: 'lines', expectedRevision: 1, values: { item: 'C', amount: 3 } }] };
  const result = await patch(path, body);
  assert.deepEqual(result.record.values.lines.map((r: any) => r.item), ['A', 'B', 'C']);
  assert.equal((await patch(path, body)).record.revision, result.record.revision);
  assert.equal((await h.request(`/records/${x.record.record.id}/events`)).length, 2);
});
test('page insertion-only policy preserves row order, rejects old anchors and never widens a data restriction', async () => {
  const x = await setup(), p = await page(x.definition, { add: false, insert: true, editExisting: false, deleteExisting: false });
  const path = `/pages/${p.id}/records/${x.record.record.id}`;
  const original = await h.request(`${path}?version=1`, 'GET', undefined, 'editor');
  assert.deepEqual(original.rowActions.lines, { add: false, insert: true, editExisting: false, remove: false });
  const anchor = original.record.values.lines[1]._rowId;
  await patch(path, { pageVersion: 1, rows: [{ action: 'add', subformId: 'lines', expectedRevision: 1, values: { item: '不允许' } }] }, 403);
  const body = { requestId: randomUUID(), pageVersion: 1, rows: [
    { action: 'insert', subformId: 'lines', beforeRowId: anchor, expectedRevision: 1, values: { item: 'C' } },
    { action: 'insert', subformId: 'lines', beforeRowId: anchor, expectedRevision: 1, values: { item: 'D' } }
  ] };
  const saved = await patch(path, body);
  assert.deepEqual(saved.record.values.lines.map((r: any) => r.item), ['A', 'C', 'D', 'B']);
  assert.equal((await patch(path, body)).record.revision, saved.record.revision);
  await patch(path, { ...body, requestId: randomUUID() }, 409);
  await patch(path, { pageVersion: 1, rows: [{ action: 'insert', subformId: 'lines', beforeRowId: randomUUID(), expectedRevision: 2, values: { item: '失效位置' } }] }, 409);
  assert.deepEqual((await h.request(`${path}?version=1`, 'GET', undefined, 'editor')).record, saved.record);
  const strict = await setup();
  await h.permissionGroup(strict.definition.id, {
    id: "member_" + editor.id,
    subjects: [{ kind: "member", id: editor.id }],
    fields: { name: "edit", lines: "read", item: "edit", amount: "edit" },
    actions: ["view", "create", "edit"],
  });
  const loose = await page(strict.definition, newSubformPermissions());
  const strictPath = `/pages/${loose.id}/records/${strict.record.record.id}`;
  assert.equal((await h.request(strictPath + '?version=1', 'GET', undefined, 'editor')).rowActions.lines.insert, false);
  await patch(strictPath, { pageVersion: 1, rows: [{ action: 'insert', subformId: 'lines', beforeRowId: null, expectedRevision: 1, values: { item: '禁止扩大' } }] }, 403);
});
test('creation and saved drafts enforce the published page policy without writes on rejection; old versions retain their rules', async () => {
  const x = await setup(), policy = { add: false, insert: false, editExisting: false, deleteExisting: false };
  const p = await page(x.definition, policy);
  assert.equal((await h.request(`/pages/${p.id}/form?version=1`, 'GET', undefined, 'editor')).rowActions.lines.add, false);
  for (const state of ['active', 'draft']) await h.request(`/pages/${p.id}/records`, 'POST', { requestId: randomUUID(), pageVersion: 1, state, values: { name: '被拒绝', lines: [{ item: '禁止新增' }] } }, 'editor', 403);
  const draft = await h.request(`/pages/${p.id}/records`, 'POST', { requestId: randomUUID(), pageVersion: 1, state: 'draft', values: { name: '可保存', lines: [] } }, 'editor', 201);
  await patch(`/pages/${p.id}/records/${draft.record.id}`, { pageVersion: 1, rows: [{ action: 'add', subformId: 'lines', expectedRevision: 1, values: { item: '草稿也不绕过' } }] }, 403);
  const current = await h.request(`/pages/${p.id}/draft`);
  current.schema.controls.find((c: any) => c.binding.fieldId === 'lines').properties.subformPermissions = newSubformPermissions();
  const saved = await h.request(`/pages/${p.id}`, 'PUT', { ...current, expectedRevision: current.revision });
  await h.request(`/pages/${p.id}/publish`, 'POST', { expectedRevision: saved.revision }, 'admin', 201);
  assert.equal((await h.request(`/pages/${p.id}?version=1`)).page.schema.controls.find((c: any) => c.binding.fieldId === 'lines').properties.subformPermissions.add, false);
  await patch(`/pages/${p.id}/records/${draft.record.id}`, { pageVersion: 1, rows: [{ action: 'add', subformId: 'lines', expectedRevision: 1, values: { item: '旧版本仍禁止' } }] }, 403);
  const updated = await patch(`/pages/${p.id}/records/${draft.record.id}`, { pageVersion: 2, rows: [{ action: 'add', subformId: 'lines', expectedRevision: 1, values: { item: '新版本允许' } }] });
  assert.equal(updated.record.values.lines[0].item, '新版本允许');
});
test('relation mapping cannot edit a restricted existing row and creates neither link nor record event', async () => {
  const x = await setup({ ...newSubformPermissions(), editExisting: false });
  const target = await h.definition('关联来源', schema(field('name'), field('price', 'number')));
  const selected = await h.record(target.id, { name: '来源', price: 10 });
  const relation = await h.relation({ title: '关联回填', sourceDefinitionId: x.definition.id, targetDefinitionId: target.id, sourceSubformId: 'lines', cardinality: 'one', inverseCardinality: 'many', labelFieldId: 'name', columns: ['price'], filters: [], mappings: [{ fromTargetFieldId: 'price', toSourceFieldId: 'amount' }], valueMode: 'snapshot' });
  const rowId = x.record.record.values.lines[0]._rowId;
  await h.request(`/pages/${x.defaultPage.id}/records/${x.record.record.id}/relations/${relation.id}/candidates?version=1&rowId=${rowId}`, 'GET', undefined, 'admin', 403);
  await h.request(`/pages/${x.defaultPage.id}/records/${x.record.record.id}/relations/${relation.id}/links`, 'POST', { pageVersion: 1, requestId: randomUUID(), sourceRowId: rowId, targetRecordId: selected.record.id, expectedCells: x.record.record.cellRevisions }, 'admin', 403);
  assert.equal((await h.db.query('SELECT 1 FROM record_links WHERE source_record_id=$1', [x.record.record.id])).rowCount, 0);
  assert.equal((await h.request(`/records/${x.record.record.id}`)).record.values.lines[0].amount, 1);
});
test('restoration obeys current row creation policy and a failed restore retains the original deletion', async () => {
  const x = await setup(), p = await page(x.definition, { add: false, insert: false, editExisting: true, deleteExisting: true });
  const path = `/pages/${p.id}/records/${x.record.record.id}`, rowId = x.record.record.values.lines[0]._rowId;
  await patch(path, { pageVersion: 1, rows: [{ action: 'remove', subformId: 'lines', rowId, expectedRevision: 1, expectedCells: x.record.record.cellRevisions }] });
  const removed = await h.request(path + '/removed-rows?version=1', 'GET', undefined, 'editor');
  assert.equal(removed.length, 1); assert.equal(removed[0].restorable, false);
  await patch(path, { pageVersion: 1, rows: [{ action: 'restore', subformId: 'lines', rowId, eventId: removed[0].eventId, expectedRevision: 2 }] }, 403);
  assert.deepEqual((await h.request(path + '?version=1', 'GET', undefined, 'editor')).record.values.lines.map((r: any) => r.item), ['B']);
});
test('task row permissions cannot override a readonly-existing-row page', async () => {
  const x = await setup(), p = await page(x.definition, { add: true, insert: true, editExisting: false, deleteExisting: true });
  const rowId = x.record.record.values.lines[0]._rowId;
  const process = await h.request('/processes', 'POST', { requestId: randomUUID(), spec: { title: '已有行办理', tasks: [{ id: 'check', title: '检查', assigneeId: editor.id, recordBinding: 'order', dependsOn: [], pageId: p.id, pageVersion: 1, subformId: 'lines', rowId }] }, bindings: { order: x.record.record.id } }, 'admin', 201);
  const path = `/processes/${process.id}/tasks/${process.tasks[0].id}/record`;
  const detail = await h.request(path, 'GET', undefined, 'editor');
  assert.deepEqual(detail.rowActions.lines, { add: false, insert: false, editExisting: false, remove: false });
  await patch(path, { changes: [{ subformId: 'lines', rowId, fieldId: 'item', expectedRevision: 1, value: '不允许' }] }, 403);
  assert.equal((await h.request(`/records/${x.record.record.id}`)).record.values.lines[0].item, 'A');
});
