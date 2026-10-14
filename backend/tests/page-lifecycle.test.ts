import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pageForModel, separateFormSchema, type FormSchema } from "@platform/contracts";
import { harness, field, schema } from "./helpers";
const h = harness(); let editor: any;
before(async () => { await h.start(); editor = (await h.request('/users')).find((u: any) => u.username === 'editor'); });
after(() => h.close());
const draft = (id: string) => h.request(`/pages/${id}/draft`);
const review = (page: any, action = 'archive') => h.request(`/pages/${page.id}/lifecycle-preview`, 'POST', { action, expectedRevision: page.revision }, 'admin', 201);
const apply = (impact: any, expected = 201) => h.request(`/pages/${impact.pageId}/${impact.action}`, 'POST', { expectedRevision: impact.revision, impactToken: impact.token }, 'admin', expected);
async function fixture(title: string) {
  const object = await h.definition(title, schema(field('name'), field('note'))), page = (await h.request(`/pages?definitionId=${object.id}`))[0];
  const data = await h.request(`/data-objects/${object.id}/draft`), record = await h.record(object.id, { name: '保留记录', note: '' });
  await h.permissionGroup(object.id, {
    id: "member_" + editor.id,
    subjects: [{ kind: "member", id: editor.id }],
    scope: "all",
    fields: { name: "read", note: "edit" },
    actions: ["view", "create", "edit"],
  });
  return { object, page: await draft(page.id), data, record };
}
async function template(f: Awaited<ReturnType<typeof fixture>>) {
  const spec = {
    title: "生命周期处理",
    startTaskIds: ["handle"],
    endTaskIds: ["handle"],
    bindings: [
      {
        id: "main",
        title: "业务",
        definitionId: f.object.id,
        definitionVersion: 1,
      },
    ],
    tasks: [
      {
        id: "handle",
        title: "处理记录",
        recordBinding: "main",
        pageId: f.page.id,
        pageVersion: 1,
        assigneeId: editor.id,
        requiredFields: ["note"],
        dependsOn: [],
      },
    ],
  };
  const saved = await h.request('/process-templates', 'POST', { requestId: randomUUID(), applicationId: f.data.applicationId, spec }, 'admin', 201);
  const published = await h.request(`/process-templates/${saved.id}/publish`, 'POST', { expectedRevision: saved.revision }, 'admin', 201);
  const path = `/process-templates/${published.id}/versions/1`, bindings = { main: f.record.record.id };
  return { spec, saved, published, path, bindings };
}
const waitForLock = async (part: string) => {
  const deadline = Date.now() + 5000;
  while (!(await h.db.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE $1", [`%${part}%`])).rowCount) {
    if (Date.now() > deadline) assert.fail(`lock barrier not reached: ${part}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};
test('archive hides ordinary entry points, preserves pending fields and records, and restores the same page identity', async () => {
  const f = await fixture('归档保留'), original = await h.request(`/pages/${f.page.id}?version=1`);
  const added = separateFormSchema(schema(field('pending')) as unknown as FormSchema).model.fields[0]!;
  f.page = await h.request(`/pages/${f.page.id}`, 'PUT', { ...f.page, expectedRevision: f.page.revision, title: '待发布页面名', baseDefinitionRevision: f.data.revision, additions: [{ field: added }], schema: pageForModel({ ...f.data.model, fields: [...f.data.model.fields, added] }) });
  const impact = await review(f.page); assert.equal(impact.pendingFieldCount, 1);
  const archived = await apply(impact); assert.ok(archived.archivedAt);
  assert.equal((await h.request(`/pages?definitionId=${f.object.id}`)).length, 0);
  assert.equal((await h.request(`/pages?definitionId=${f.object.id}&state=archived`))[0].id, f.page.id);
  assert.deepEqual((await h.request(`/pages/${f.page.id}/editor`)).draft.additions, f.page.additions);
  assert.deepEqual(await h.request(`/pages/${f.page.id}?version=1`), original);
  const path = `/pages/${f.page.id}`;
  for (const suffix of ['/form?version=1', `/records/${f.record.record.id}?version=1`, `/records/${f.record.record.id}/removed-rows?version=1`, `/records/${f.record.record.id}/upgrade?version=1`]) await h.request(path + suffix, 'GET', undefined, 'admin', 409);
  await h.request(path, 'PUT', { ...archived, expectedRevision: archived.revision }, 'admin', 409);
  for (const suffix of ['publish', 'publish-preview', 'discard-draft']) await h.request(`${path}/${suffix}`, 'POST', { expectedRevision: archived.revision }, 'admin', 409);
  await h.request(`${path}/records`, 'POST', { requestId: randomUUID(), pageVersion: 1, values: { name: '不应创建', note: '' } }, 'admin', 409);
  await h.request(`${path}/records/${f.record.record.id}`, 'PATCH', { requestId: randomUUID(), taskId: randomUUID(), pageVersion: 1, changes: [{ fieldId: 'note', value: '不应写入', expectedRevision: 1 }] }, 'admin', 409);
  assert.deepEqual((await h.request(`/records/${f.record.record.id}`)).record, f.record.record);
  assert.deepEqual(await h.request(`/data-objects/${f.object.id}/draft`), f.data);
  assert.ok((await h.request(`/data-objects/${f.object.id}/pending-page-fields`)).pages[0].archivedAt);
  const restored = await apply(await review(archived, 'restore'));
  assert.equal(restored.archivedAt, null); assert.equal(restored.id, f.page.id);
  assert.deepEqual(restored.schema, f.page.schema); assert.deepEqual(restored.additions, f.page.additions);
  assert.equal((await h.request(`${path}/form?version=1`)).definition.version, 1);
  const events = (await h.db.query("SELECT * FROM configuration_events WHERE resource_id=$1 ORDER BY created_at,id", [f.page.id])).rows;
  assert.deepEqual(events.map(e => e.action), ['publish', 'archive', 'restore']);
  await assert.rejects(h.db.query('DELETE FROM configuration_events WHERE id=$1', [events[0].id]), /immutable/);
});
test('archived pages reject new process starts but already issued tasks keep pinned pages and current permissions after restart', async () => {
  const f = await fixture('历史任务保留'), t = await template(f);
  const start = { ...await h.request(`${t.path}/preview`, 'POST', { bindings: t.bindings }, 'admin', 201), requestId: randomUUID() };
  const process = await h.request(`${t.path}/start`, 'POST', start, 'admin', 201), task = process.tasks[0];
  const impact = await review(f.page); assert.deepEqual(impact.tasks, [{ version: 1, active: 1, completed: 0 }]);
  assert.ok(impact.references.some((r: any) => r.state === 'published')); assert.ok(impact.references.some((r: any) => r.state === 'draft'));
  const archived = await apply(impact); await h.restart();
  await h.request(`${t.path}/preview`, 'POST', { bindings: t.bindings }, 'admin', 409);
  await h.request(`${t.path}/start`, 'POST', { ...start, requestId: randomUUID() }, 'admin', 409);
  assert.equal((await h.request(`${t.path}/start`, 'POST', start, 'admin', 201)).id, process.id);
  await h.request('/processes', 'POST', { requestId: randomUUID(), spec: { title: '绕过模板', tasks: t.spec.tasks }, bindings: t.bindings }, 'admin', 409);
  await h.request('/process-templates', 'POST', { requestId: randomUUID(), applicationId: f.data.applicationId, spec: t.spec }, 'admin', 201);
  const retainedDraft = await h.request(`/process-templates/${t.saved.id}`, 'PUT', { expectedRevision: 2, spec: { ...t.spec, title: '保留原引用的草稿' } });
  await h.request(`/process-templates/${t.saved.id}/publish`, 'POST', { expectedRevision: retainedDraft.revision }, 'admin', 409);
  const taskPath = `/processes/${process.id}/tasks/${task.id}`;
  assert.equal((await h.request(`${taskPath}/record`, 'GET', undefined, 'editor')).page.version, 1);
  await h.request(`${taskPath}/record`, 'PATCH', { requestId: randomUUID(), changes: [{ fieldId: 'name', value: '越权修改', expectedRevision: 1 }] }, 'editor', 403);
  await h.request(`${taskPath}/record`, 'PATCH', { requestId: randomUUID(), changes: [{ fieldId: 'note', value: '归档后完成', expectedRevision: 1 }] }, 'editor');
  const completed = await h.request(`${taskPath}/complete`, 'POST', {}, 'editor', 201); assert.equal(completed.status, 'completed');
  const restore = await review(archived, 'restore'); assert.deepEqual(restore.tasks, [{ version: 1, active: 0, completed: 1 }]);
  await apply(restore);
  const next = await h.request(`${t.path}/preview`, 'POST', { bindings: t.bindings }, 'admin', 201); assert.equal(next.tasks.length, 1);
});
test('archived page dependencies do not block model changes; restore reviews differences and retains the old data contract', async () => {
  const f = await fixture('旧契约恢复'), archived = await apply(await review(f.page));
  const next = { ...f.data, model: { ...f.data.model, fields: [f.data.model.fields[0]] } };
  const saved = await h.request(`/data-objects/${f.object.id}`, 'PUT', { ...next, expectedRevision: next.revision });
  const impact = await h.request(`/data-objects/${f.object.id}/publish-preview`, 'POST', { expectedRevision: saved.revision }, 'admin', 201);
  assert.deepEqual(impact.blockers, []); assert.match(impact.references[0].detail, /已归档/);
  await h.request(`/data-objects/${f.object.id}/publish`, 'POST', { expectedRevision: saved.revision, impactToken: impact.token }, 'admin', 201);
  const restore = await review(archived, 'restore'); assert.ok(restore.warnings.some((s: string) => s.includes('note') && s.includes('V1')));
  await apply(restore);
  const form = await h.request(`/pages/${f.page.id}/form?version=1`); assert.equal(form.definition.version, 1); assert.ok(form.definition.schema.fields.some((field: any) => field.id === 'note'));
  const current = await h.request(`/data-objects/${f.object.id}/draft`); assert.equal(current.latestVersion, 2); assert.equal(current.model.fields.length, 1);
  const blocked = await h.request(`/data-objects/${f.object.id}/publish-preview`, 'POST', { expectedRevision: current.revision }, 'admin', 201); assert.ok(blocked.blockers.length);
});
test('review tokens, page revisions, audit rollback and ownership protect lifecycle changes', async () => {
  const f = await fixture('归档检查与回滚'), impact = await review(f.page);
  await template(f); await apply(impact, 409);
  const current = await review(f.page);
  await h.request(`/pages/${f.page.id}/archive`, 'POST', { expectedRevision: f.page.revision }, 'admin', 409);
  await h.request(`/pages/${f.page.id}/archive`, 'POST', { expectedRevision: f.page.revision, impactToken: current.token }, 'editor', 403);
  await h.request('/pages?state=archived', 'GET', undefined, 'editor', 403); await h.request('/pages?state=unknown', 'GET', undefined, 'admin', 400);
  await h.db.query("CREATE FUNCTION reject_lifecycle() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'deliberate lifecycle audit failure'; END; $$ LANGUAGE plpgsql");
  await h.db.query('CREATE TRIGGER reject_lifecycle BEFORE INSERT ON configuration_events FOR EACH ROW EXECUTE FUNCTION reject_lifecycle()');
  try { await apply(current, 500); assert.deepEqual(await draft(f.page.id), f.page); } finally { await h.db.query('DROP TRIGGER reject_lifecycle ON configuration_events'); }
  const archived = await apply(current), restore = await review(archived, 'restore');
  await h.db.query('CREATE TRIGGER reject_lifecycle BEFORE INSERT ON configuration_events FOR EACH ROW EXECUTE FUNCTION reject_lifecycle()');
  try { await apply(restore, 500); assert.deepEqual(await draft(f.page.id), archived); } finally { await h.db.query('DROP TRIGGER reject_lifecycle ON configuration_events'); }
  await h.db.query("UPDATE users SET workspace_id='elsewhere' WHERE username='admin'");
  try { await apply(restore, 404); await h.request(`/pages/${f.page.id}/lifecycle-preview`, 'POST', { action: 'restore', expectedRevision: archived.revision }, 'admin', 404); }
  finally { await h.db.query("UPDATE users SET workspace_id='local' WHERE username='admin'"); }
  await apply(restore); await apply(current, 409);
});
test('a process start waiting behind archive rechecks page state before creating any tasks', async () => {
  const f = await fixture('发起归档并发'), t = await template(f), preview = await h.request(`${t.path}/preview`, 'POST', { bindings: t.bindings }, 'admin', 201), impact = await review(f.page);
  const barrier = await h.db.pool.connect(); let archiving: Promise<any> | undefined, starting: Promise<any> | undefined;
  await barrier.query('BEGIN'); await barrier.query('SELECT id FROM pages WHERE id=$1 FOR UPDATE', [f.page.id]);
  try {
    archiving = apply(impact); await waitForLock('FOR UPDATE OF p');
    starting = h.request(`${t.path}/start`, 'POST', { ...preview, requestId: randomUUID() }, 'admin', 409); await waitForLock('FROM definitions WHERE');
    await barrier.query('COMMIT'); await archiving; await starting;
    assert.equal((await h.db.query('SELECT count(*)::int AS n FROM tasks WHERE record_id=$1', [f.record.record.id])).rows[0].n, 0);
  } finally { await barrier.query('ROLLBACK'); barrier.release(); await Promise.allSettled([archiving, starting].filter(Boolean)); }
});
test('relation link and unlink recheck archive after preloaded page scope, inside the write transaction', async () => {
  const f = await fixture('关系归档并发'), target = await h.definition('关系目标', schema(field('name'))), targetRecord = await h.record(target.id, { name: '目标' });
  const relation = await h.relation({ title: '生命周期关系', sourceDefinitionId: f.object.id, targetDefinitionId: target.id, cardinality: 'many', inverseCardinality: 'many', labelFieldId: 'name', columns: [], filters: [], mappings: [], valueMode: 'live' });
  const base = `/pages/${f.page.id}/records/${f.record.record.id}/relations/${relation.id}/links`;
  for (const action of ['link', 'unlink']) {
    let path = base, body: any = { requestId: randomUUID(), pageVersion: 1, targetRecordId: targetRecord.record.id };
    if (action === 'unlink') {
      await h.request(`/records/${f.record.record.id}/relations/${relation.id}/links`, 'POST', { requestId: randomUUID(), targetRecordId: targetRecord.record.id }, 'admin', 201);
      const link = (await h.db.query('SELECT id FROM record_links WHERE relation_id=$1', [relation.id])).rows[0]; path = `${base}/${link.id}/remove`; body = { requestId: randomUUID(), pageVersion: 1 };
    }
    const impact = await review(await draft(f.page.id)), barrier = await h.db.pool.connect(); let writing: Promise<any> | undefined;
    await barrier.query('BEGIN'); await barrier.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`relation:${relation.id}`]);
    try {
      writing = h.request(path, 'POST', body, 'admin', 409); await waitForLock('pg_advisory_xact_lock(hashtextextended');
      const archived = await apply(impact); await barrier.query('COMMIT'); await writing;
      assert.equal((await h.db.query('SELECT count(*)::int AS n FROM record_links WHERE relation_id=$1', [relation.id])).rows[0].n, action === 'link' ? 0 : 1);
      await apply(await review(archived, 'restore'));
    } finally { await barrier.query('ROLLBACK'); barrier.release(); await Promise.allSettled([writing].filter(Boolean)); }
  }
});
test('never-published pages can be archived and restored with their pending additions intact', async () => {
  const created = await h.request('/pages/new-business', 'POST', { title: '新页面草稿', requestId: randomUUID() }, 'admin', 201);
  const added = separateFormSchema(schema(field('initial')) as unknown as FormSchema).model.fields[0]!;
  const page = await h.request(`/pages/${created.draft.id}`, 'PUT', { ...created.draft, expectedRevision: created.draft.revision, baseDefinitionRevision: created.object.revision, additions: [{ field: added }], schema: pageForModel({ version: 1, fields: [added] }) });
  const archived = await apply(await review(page)); assert.equal(archived.latestVersion, 0);
  const restored = await apply(await review(archived, 'restore'));
  assert.deepEqual(restored.additions, page.additions); assert.deepEqual(restored.schema, page.schema);
  assert.equal((await h.request(`/pages/${page.id}/editor`)).model.fields.length, 0);
  const published = await h.request(`/pages/${page.id}/publish`, 'POST', { expectedRevision: restored.revision }, 'admin', 201); assert.equal(published.version, 1);
});
