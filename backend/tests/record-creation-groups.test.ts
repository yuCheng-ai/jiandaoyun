import { separateFormSchema, type FormSchema } from "@platform/contracts";
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { harness, field, schema } from './helpers';
const h = harness();
let editor: string, reviewer: string;
before(async () => { await h.start(); const users = await h.request('/users'); editor = users.find((u: any) => u.username === 'editor').id; reviewer = users.find((u: any) => u.username === 'reviewer').id; });
after(() => h.close());
const group = (id: string, extra: any = {}) => ({ id, name: id, enabled: true, archived: false, subjects: [{ kind: 'member', id: editor }], actions: ['create'], scope: 'all', filters: [], fields: { name: 'edit', lines: 'edit', item: 'edit' }, relations: {}, ...extra });
const headers = (id: string, selection: string) => ({ 'X-Platform-Access-Groups': JSON.stringify({ [id]: selection }) });
async function setup(groups?: (id: string) => any[], allowMerged = false) {
  const definition = await h.definition('仅登记业务', schema(field('name', 'text', { required: true }), field('secret', 'text', { defaultValue: '系统默认' }), field('lines', 'subform', { children: [field('item'), field('internal', 'text', { defaultValue: '内部默认' })] })));
  const page = (await h.request(`/pages?definitionId=${definition.id}`))[0];
  const config = await h.request(`/definitions/${definition.id}/permission-groups`, 'PUT', { expectedRevision: 0, mode: 'groups', allowMerged, groups: groups ? groups(definition.id) : [group('register')] });
  return { definition, page, config };
}
const call = (f: any, path: string, method = 'GET', body?: any, expected = 200, selection = 'register', user = 'editor') => h.request(path, method, body, user, expected, headers(f.definition.id, selection));
const create = (f: any, body: any, selection = 'register', expected = 201) => call(f, `/pages/${f.page.id}/records`, 'POST', { pageVersion: 1, ...body }, expected, selection);
const receipt = (result: any) => { assert.equal(result.accessLost, true); assert.equal(result.access.read, false); assert.deepEqual(result.record.values, {}); assert.deepEqual(result.record.cellRevisions, {}); assert.deepEqual(result.definition.schema.fields, []); assert.equal(result.identities, undefined); assert.equal(result.creator, undefined); };

test('only-add entries can open and submit without granting existing-record reads or exposing fields in the response', async () => {
  const f = await setup();
  assert.ok((await h.request('/definitions', 'GET', undefined, 'editor')).some((d: any) => d.id === f.definition.id));
  const form = await call(f, `/pages/${f.page.id}/form?version=1`);
  assert.equal(form.access.create, true); assert.equal(form.access.read, false); assert.equal(form.access.edit, false);
  assert.deepEqual(form.definition.schema.fields.map((field: any) => field.id), ['name', 'lines']);
  assert.deepEqual(form.definition.schema.fields[1].children.map((field: any) => field.id), ['item']);
  const body = { requestId: randomUUID(), values: { name: '登记完成', lines: [{ item: '可填列' }] } };
  const result = await create(f, body); receipt(result); assert.equal(result.record.state, 'active');
  const retried = await create(f, body); receipt(retried); assert.equal(retried.record.id, result.record.id);
  for (const path of [`/definitions/${f.definition.id}/records`, `/records/${result.record.id}`, `/pages/${f.page.id}/records/${result.record.id}?version=1`, `/records/${result.record.id}/output/export`, `/records/${result.record.id}/output/print`]) await call(f, path, 'GET', undefined, 403);
  await call(f, `/records/${result.record.id}`, 'PATCH', { requestId: randomUUID(), changes: [{ fieldId: 'name', expectedRevision: 1, value: '越权' }] }, 403);
  const stored = await h.request(`/records/${result.record.id}`); assert.equal(stored.record.values.secret, '系统默认'); assert.equal(stored.record.values.lines[0].internal, '内部默认');
  assert.equal((await h.db.query('SELECT 1 FROM record_events WHERE record_id=$1', [result.record.id])).rowCount, 1);
});

test('own drafts support resume and row edits, then submit atomically with the same identity and content-free retry', async () => {
  const f = await setup();
  const d = await create(f, { requestId: randomUUID(), state: 'draft', values: {} });
  assert.equal(d.access.read, false); assert.equal(d.access.edit, true); assert.equal(d.record.state, 'draft');
  const own = await call(f, `/definitions/${f.definition.id}/records?state=draft`); assert.deepEqual(own.map((r: any) => r.id), [d.record.id]);
  const resumed = await call(f, `/pages/${f.page.id}/records/${d.record.id}?version=1`); assert.deepEqual(resumed.record, d.record);
  const patched = await call(f, `/pages/${f.page.id}/records/${d.record.id}`, 'PATCH', { requestId: randomUUID(), pageVersion: 1, changes: [{ fieldId: 'name', expectedRevision: 1, value: '完整登记' }], rows: [{ action: 'add', subformId: 'lines', expectedRevision: 1, values: { item: '一行' } }] });
  assert.equal(patched.rowActions.lines.add, true); assert.equal(patched.rowActions.lines.remove, false); // hidden column cannot be destroyed
  const rowId = patched.record.values.lines[0]._rowId;
  const body = { requestId: randomUUID(), pageVersion: 1, expectedRevision: patched.record.revision, changes: [{ subformId: 'lines', rowId, fieldId: 'item', expectedRevision: 1, value: '已核对' }] };
  const submitted = await call(f, `/pages/${f.page.id}/records/${d.record.id}/submit`, 'POST', body, 201); receipt(submitted); assert.equal(submitted.record.id, d.record.id);
  const retry = await call(f, `/pages/${f.page.id}/records/${d.record.id}/submit`, 'POST', body, 201); receipt(retry); assert.equal(retry.record.revision, submitted.record.revision);
  assert.deepEqual(await call(f, `/definitions/${f.definition.id}/records?state=draft`), []);
  const final = await h.request(`/records/${d.record.id}`); assert.equal(final.record.values.lines[0]._rowId, rowId); assert.equal(final.record.values.lines[0].item, '已核对');
  const events = (await h.db.query('SELECT changes FROM record_events WHERE record_id=$1 ORDER BY revision', [d.record.id])).rows; assert.equal(events.at(-1).changes.action, 'submit-draft');
});

test('merged read or edit groups cannot lend fields to creation; creation fields cannot lend themselves to existing-record edits', async () => {
  const f = await setup(() => [group('register'), group('review', { actions: ['view', 'edit'], fields: { secret: 'edit', lines: 'edit', internal: 'edit' } })], true);
  const form = await call(f, `/pages/${f.page.id}/form?version=1`, 'GET', undefined, 200, '*');
  assert.equal(form.access.read, true); assert.equal(form.access.fields.secret, undefined);
  await create(f, { requestId: randomUUID(), values: { name: '伪造', secret: '串组写入' } }, '*', 403);
  await create(f, { requestId: randomUUID(), state: 'draft', values: { lines: [{ internal: '串组子列' }] } }, '*', 403);
  const result = await create(f, { requestId: randomUUID(), values: { name: '登记' } }, '*');
  assert.equal(result.record.values.name, undefined); assert.equal(result.record.values.secret, '系统默认'); assert.equal(result.access.fields.secret, 'edit');
  await call(f, `/records/${result.record.id}`, 'PATCH', { requestId: randomUUID(), changes: [{ fieldId: 'name', expectedRevision: 1, value: '越权修改' }] }, 403, '*');
  await create(f, { requestId: randomUUID(), values: { name: '无添加操作' } }, 'review', 403);
});

test('record filters apply after submission, not to own registration drafts; failures preserve the draft and command identity', async () => {
  const f = await setup(() => [group('register', { actions: ['create', 'view'], scope: 'custom', filters: [{ id: 'pending', sourceFieldId: 'name', operator: 'equals', source: 'constant', value: '待处理' }] })]);
  const d = await create(f, { requestId: randomUUID(), state: 'draft', values: {} });
  assert.equal((await call(f, `/definitions/${f.definition.id}/records?state=draft`))[0].id, d.record.id);
  const requestId = randomUUID();
  await call(f, `/pages/${f.page.id}/records/${d.record.id}/submit`, 'POST', { requestId, pageVersion: 1, expectedRevision: 1 }, 400);
  assert.equal((await call(f, `/records/${d.record.id}`)).record.revision, 1);
  assert.equal((await h.db.query('SELECT 1 FROM commands WHERE actor_id=$1 AND request_id=$2', [editor, requestId])).rowCount, 0);
  const result = await call(f, `/pages/${f.page.id}/records/${d.record.id}/submit`, 'POST', { requestId, pageVersion: 1, expectedRevision: 1, changes: [{ fieldId: 'name', expectedRevision: 1, value: '交接' }] }, 201); receipt(result);
  assert.deepEqual(await call(f, `/definitions/${f.definition.id}/records`), []);
});

test('a page may tighten creation fields and child columns; hidden and readonly defaults are still server-owned', async () => {
  const f = await setup(() => [group('register', { fields: { name: 'edit', secret: 'edit', lines: 'edit', item: 'edit', internal: 'edit' } })]);
  const d = await h.request(`/pages/${f.page.id}/draft`);
  d.schema.controls.find((c: any) => c.binding.fieldId === 'secret').properties.editable = false;
  const lines = d.schema.controls.find((c: any) => c.binding.fieldId === 'lines'); lines.children.find((c: any) => c.binding.fieldId === 'internal').properties.visible = false;
  const saved = await h.request(`/pages/${f.page.id}`, 'PUT', { ...d, expectedRevision: d.revision });
  await h.request(`/pages/${f.page.id}/publish`, 'POST', { expectedRevision: saved.revision }, 'admin', 201);
  const form = await call(f, `/pages/${f.page.id}/form?version=2`); assert.equal(form.access.fields.secret, 'read'); assert.equal(form.access.fields.internal, undefined);
  await create(f, { requestId: randomUUID(), pageVersion: 2, values: { name: '越权', secret: '改默认' } }, 'register', 403);
  await create(f, { requestId: randomUUID(), pageVersion: 2, values: { name: '越权', lines: [{ internal: '隐藏列' }] } }, 'register', 403);
  const result = await create(f, { requestId: randomUUID(), pageVersion: 2, values: { name: '正常', lines: [{ item: '正常列' }] } }); receipt(result);
  const stored = await h.request(`/records/${result.record.id}`); assert.equal(stored.record.values.secret, '系统默认'); assert.equal(stored.record.values.lines[0].internal, '内部默认');
});

test('live membership and creation revocation stop new work; an already successful retry acknowledges its result without disclosure', async () => {
  const f = await setup(() => [group('register', { subjects: [{ kind: 'member', id: editor }, { kind: 'member', id: reviewer }] })]);
  const body = { requestId: randomUUID(), state: 'draft', values: { name: '自己的草稿' } }, d = await create(f, body);
  assert.deepEqual(await call(f, `/definitions/${f.definition.id}/records?state=draft`, 'GET', undefined, 200, 'register', 'reviewer'), []);
  await call(f, `/records/${d.record.id}`, 'GET', undefined, 403, 'register', 'reviewer');
  await h.request(`/definitions/${f.definition.id}/permission-groups`, 'PUT', { expectedRevision: f.config.revision, mode: 'groups', allowMerged: false, groups: [group('register', { actions: ['view'] })] });
  for (const path of [`/records/${d.record.id}`, `/definitions/${f.definition.id}/records?state=draft`]) await call(f, path, 'GET', undefined, 403);
  await call(f, `/records/${d.record.id}`, 'PATCH', { requestId: randomUUID(), changes: [{ fieldId: 'name', expectedRevision: 1, value: '撤权后写' }] }, 403);
  await call(f, `/pages/${f.page.id}/records/${d.record.id}/submit`, 'POST', { requestId: randomUUID(), pageVersion: 1, expectedRevision: 1 }, 403);
  const ack = await create(f, body); receipt(ack); assert.equal(ack.record.id, d.record.id);
  await create(f, { ...body, requestId: randomUUID() }, 'register', 403);
});

test('create and submit retry identities include the selected group and cannot cross scopes', async () => {
  const f = await setup(() => [group('a'), group('b')]);
  const body = { requestId: randomUUID(), state: 'draft', values: { name: '登记' } }, d = await create(f, body, 'a');
  await create(f, body, 'b', 409);
  const submit = { requestId: randomUUID(), pageVersion: 1, expectedRevision: 1 };
  const result = await call(f, `/pages/${f.page.id}/records/${d.record.id}/submit`, 'POST', submit, 201, 'a'); receipt(result);
  await call(f, `/pages/${f.page.id}/records/${d.record.id}/submit`, 'POST', submit, 409, 'b');
  const row = (await h.db.query('SELECT revision,state FROM records WHERE id=$1', [d.record.id])).rows[0]; assert.equal(row.revision, 2); assert.equal(row.state, 'active');
});

test('creation clamps parent and child fields within each group before an allowed merge', async () => {
  const f = await setup(() => [group('child', { fields: { name: 'edit', lines: 'read', item: 'edit' } }), group('parent', { fields: { lines: 'edit', internal: 'edit' } })], true);
  const form = await call(f, `/pages/${f.page.id}/form?version=1`, 'GET', undefined, 200, '*');
  assert.equal(form.access.fields.lines, 'edit'); assert.equal(form.access.fields.item, 'read'); assert.equal(form.access.fields.internal, 'edit');
  await create(f, { requestId: randomUUID(), state: 'draft', values: { lines: [{ item: '不能借父级' }] } }, '*', 403);
  const d = await create(f, { requestId: randomUUID(), state: 'draft', values: { name: '只填写可写列', lines: [{ internal: '同组允许' }] } }, '*');
  assert.equal(d.record.values.lines[0].internal, '同组允许'); assert.equal(d.record.values.lines[0].item, '');
  await call(f, `/records/${d.record.id}`, 'PATCH', { requestId: randomUUID(), changes: [{ subformId: 'lines', rowId: d.record.values.lines[0]._rowId, fieldId: 'item', expectedRevision: 1, value: '草稿也不越权' }] }, 403, '*');
});

test('a stored record filter cannot block only-add modeling, but must be valid again before view is restored', async () => {
  const g = group('register', { scope: 'custom', filters: [{ id: 'f', sourceFieldId: 'name', operator: 'equals', source: 'constant', value: '待处理' }] });
  const f = await setup(() => [g]);
  // 先发布移除控件的页面，再验证历史权限筛选本身是否阻止模型变更。
  const page = f.page;
  const currentPage = await h.request(`/pages/${page.id}/draft`);
  const nextPage = await h.request(`/pages/${page.id}`, "PUT", {
    ...currentPage,
    expectedRevision: currentPage.revision,
    schema: {
      ...currentPage.schema,
      controls: currentPage.schema.controls.filter(
        (control: any) => control.binding?.fieldId !== "name",
      ),
    },
  });
  await h.request(
    `/pages/${page.id}/publish`,
    "POST",
    { expectedRevision: nextPage.revision },
    "admin",
    201,
  );
  const current = await h.request(`/definitions/${f.definition.id}`);
  const next = { ...current.definition.schema, fields: current.definition.schema.fields.filter((field: any) => field.id !== 'name') };
  const draft = await h.request(`/data-objects/${f.definition.id}`, 'PUT', { expectedRevision: f.definition.revision, title: '仅登记业务', model: separateFormSchema(next as unknown as FormSchema).model });
  const preview = await h.request(`/data-objects/${f.definition.id}/publish-preview`, 'POST', { expectedRevision: draft.revision }, 'admin', 201);
  assert.deepEqual(preview.blockers, []);
  await h.request(`/data-objects/${f.definition.id}/publish`, 'POST', { expectedRevision: draft.revision, impactToken: preview.token }, 'admin', 201);
  const cfg = await h.request(`/definitions/${f.definition.id}/permission-groups`, 'PUT', { expectedRevision: f.config.revision, mode: 'groups', allowMerged: false, groups: [g] });
  assert.equal(cfg.groups[0].filters[0].sourceFieldId, 'name');
  await h.request(`/definitions/${f.definition.id}/permission-groups`, 'PUT', { expectedRevision: cfg.revision, mode: 'groups', allowMerged: false, groups: [{ ...g, actions: ['create', 'view'] }] }, 'admin', 400);
  assert.equal((await h.request(`/definitions/${f.definition.id}/permission-groups`)).revision, cfg.revision);
});
