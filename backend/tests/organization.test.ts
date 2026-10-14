import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type {
  RecordPermissionGroup,
  OrganizationSpec,
} from "@platform/contracts";
import { harness, field, schema } from "./helpers";
const h = harness(); let editor: any, reviewer: any, admin: any, organization: any, base: OrganizationSpec;
const parent = randomUUID(), child = randomUUID(), other = randomUUID(), group = randomUUID(), role = randomUUID();
const content = schema(field("name"), field("quantity", "number"), field("secret"), field("lines", "subform", { children: [field("item"), field("count", "number")] }));
const readable: RecordPermissionGroup["fields"] = {
  name: "read",
  quantity: "read",
  secret: "read",
  lines: "read",
  item: "read",
  count: "read",
};
const policy = (
  extra: any = {},
): Pick<RecordPermissionGroup, "fields" | "actions"> &
  Partial<RecordPermissionGroup> => ({
  scope: "all",
  fields: readable,
  actions: ["view"],
  ...extra,
});
async function save(spec: OrganizationSpec) { organization = await h.request("/organization", "PUT", { expectedRevision: organization.revision, spec }); return organization; }
async function subject(
  definitionId: string,
  kind: string,
  id: string,
  grant: Pick<RecordPermissionGroup, "fields" | "actions"> &
    Partial<RecordPermissionGroup>,
  includeChildren = false,
) {
  return h.permissionGroup(definitionId, {
    id: `${kind}_${id}`,
    subjects: [
      {
        kind: kind as "department" | "role",
        id,
        ...(kind === "department" ? { includeChildren } : {}),
      },
    ],
    ...grant,
  });
}
async function direct(
  definitionId: string,
  userId: string,
  grant: Pick<RecordPermissionGroup, "fields" | "actions"> &
    Partial<RecordPermissionGroup>,
) {
  return h.permissionGroup(definitionId, {
    id: "member_" + userId,
    subjects: [{ kind: "member", id: userId }],
    ...grant,
  });
}
before(async () => {
  await h.start(); const users = await h.request("/users"); [admin, editor, reviewer] = ["admin", "editor", "reviewer"].map(username => users.find((u: any) => u.username === username));
  organization = await h.request("/organization");
  base = { departments: [{ id: parent, name: "业务部", parentId: null, archived: false }, { id: child, name: "业务一组", parentId: parent, archived: false }, { id: other, name: "其他部门", parentId: null, archived: false }], roleGroups: [{ id: group, name: "业务角色" }], roles: [{ id: role, groupId: group, name: "办理人员", description: "", memberIds: [], departmentIds: [parent], includeChildren: true, archived: false }], assignments: [{ userId: editor.id, departmentIds: [parent], primaryDepartmentId: parent }, { userId: reviewer.id, departmentIds: [child], primaryDepartmentId: child }, { userId: admin.id, departmentIds: [other], primaryDepartmentId: other }] };
  await save(base);
});
beforeEach(async () => { await save(structuredClone(base)); });
after(() => h.close());

test("organization saves are atomic, versioned, scoped and reject cycles or invalid member references", async () => {
  await h.request("/organization", "GET", undefined, "editor", 403);
  const cycle = structuredClone(base); cycle.departments[0]!.parentId = child;
  await h.request("/organization", "PUT", { expectedRevision: organization.revision, spec: cycle }, "admin", 400);
  const foreign = structuredClone(base); foreign.assignments[0]!.userId = randomUUID();
  await h.request("/organization", "PUT", { expectedRevision: organization.revision, spec: foreign }, "admin", 400);
  await h.request("/organization", "PUT", { expectedRevision: organization.revision - 1, spec: base }, "admin", 409);
  const removed = structuredClone(base); removed.roles = [];
  await h.request("/organization", "PUT", { expectedRevision: organization.revision, spec: removed }, "admin", 409);
  assert.deepEqual(await h.request("/organization"), organization);
  const events = (await h.db.query("SELECT revision FROM organization_events ORDER BY revision")).rows;
  assert.equal(events.at(-1).revision, organization.revision);
  assert.equal(events.length, organization.revision);
});
test("department and role grants expose application, data and page entries to matching members only", async () => {
  const definition = await h.definition("仅部门授权", content);
  await subject(definition.id, "department", parent, policy(), false);
  assert.ok((await h.request("/definitions", "GET", undefined, "editor")).some((d: any) => d.id === definition.id));
  assert.ok(!(await h.request("/definitions", "GET", undefined, "reviewer")).some((d: any) => d.id === definition.id));
  await subject(definition.id, "department", parent, policy(), true);
  const draft = await h.request(`/data-objects/${definition.id}/draft`);
  assert.ok((await h.request("/applications", "GET", undefined, "reviewer")).some((a: any) => a.id === draft.applicationId));
  assert.ok((await h.request(`/pages?definitionId=${definition.id}`, "GET", undefined, "reviewer")).length);
  await subject(
    definition.id,
    "department",
    parent,
    policy({ enabled: false }),
    true,
  );
  await subject(definition.id, "role", role, policy());
  assert.ok((await h.request(`/pages?definitionId=${definition.id}`, "GET", undefined, "reviewer")).length);
  const configuration = await h.request(
    `/definitions/${definition.id}/permission-groups`,
  );
  const invalid = structuredClone(configuration);
  invalid.groups[0].subjects = [{ kind: "role", id: randomUUID() }];
  await h.request(
    `/definitions/${definition.id}/permission-groups`,
    "PUT",
    { expectedRevision: configuration.revision, groups: invalid.groups },
    "admin",
    400,
  );
  await h.request(
    `/definitions/${definition.id}/permission-groups`,
    "PUT",
    { expectedRevision: 0, groups: configuration.groups },
    "admin",
    409,
  );
  await h.request(
    `/definitions/${definition.id}/permission-groups`,
    "GET",
    undefined,
    "reviewer",
    403,
  );
});
test("self edit and global read remain separate per record and hidden does not deny another valid grant", async () => {
  const definition = await h.definition("多授权范围", content);
  await direct(
    definition.id,
    editor.id,
    policy({
      scope: "self",
      fields: { name: "edit", quantity: "edit", secret: "hidden" },
      actions: ["view", "create", "edit"],
    }),
  );
  await subject(definition.id, "role", role, policy());
  const own = await h.record(definition.id, { name: "本人", quantity: 2 }, "editor");
  const another = await h.record(definition.id, { name: "别人", quantity: 3, secret: "只读内容" });
  const otherDetail = await h.request(`/records/${another.record.id}`, "GET", undefined, "editor");
  assert.equal(otherDetail.access.edit, false); assert.equal(otherDetail.access.fields.quantity, "read");
  assert.equal(own.access.fields.quantity, "edit"); assert.equal(own.access.fields.secret, "read");
  await h.request(`/records/${another.record.id}`, "PATCH", { requestId: randomUUID(), changes: [{ fieldId: "quantity", value: 99, expectedRevision: 1 }] }, "editor", 403);
  await h.request(`/records/${own.record.id}`, "PATCH", { requestId: randomUUID(), changes: [{ fieldId: "quantity", value: 4, expectedRevision: 1 }] }, "editor");
  assert.equal((await h.request(`/records/${another.record.id}`)).record.values.quantity, 3);
});
test("parent restrictions are applied within each grant before child-column permissions are combined", async () => {
  const definition = await h.definition("父子列授权组合", content), record = await h.record(definition.id, { name: "A", lines: [{ item: "物料", count: 2 }] });
  await direct(
    definition.id,
    editor.id,
    policy({
      fields: { name: "read", lines: "read", count: "edit" },
      actions: ["view", "edit"],
    }),
  );
  await subject(
    definition.id,
    "role",
    role,
    policy({
      fields: { lines: "edit", item: "edit", count: "hidden" },
      actions: ["view", "edit"],
    }),
  );
  const detail = await h.request(`/records/${record.record.id}`, "GET", undefined, "editor");
  assert.equal(detail.access.fields.lines, "edit"); assert.equal(detail.access.fields.count, "read"); assert.equal(detail.access.fields.item, "edit");
  await h.request(`/records/${record.record.id}`, "PATCH", { requestId: randomUUID(), changes: [{ fieldId: "count", subformId: "lines", rowId: record.record.values.lines[0]._rowId, value: 10, expectedRevision: 1 }] }, "editor", 403);
});
test("create-only permissions cannot borrow editable fields from a separate edit-only grant", async () => {
  const definition = await h.definition("新增与修改分别授权", content);
  await direct(
    definition.id,
    editor.id,
    policy({ fields: { name: "edit" }, actions: ["view", "create"] }),
  );
  await subject(
    definition.id,
    "role",
    role,
    policy({ fields: { secret: "edit" }, actions: ["view", "edit"] }),
  );
  await h.request(`/definitions/${definition.id}/records`, "POST", { requestId: randomUUID(), version: 1, values: { name: "合法", secret: "不应通过" } }, "editor", 403);
  const created = await h.record(definition.id, { name: "可创建" }, "editor"); assert.equal(created.record.values.secret, "");
  const page = (await h.request(`/pages?definitionId=${definition.id}`))[0];
  const form = await h.request(`/pages/${page.id}/form`, "GET", undefined, "editor"); assert.equal(form.access.fields.secret, undefined); assert.equal(form.access.fields.name, "edit");
  assert.equal((await h.request(`/definitions/${definition.id}/records`)).length, 1);
});
test("candidate filters and response fields use the target record's own eligible grants", async () => {
  const source = await h.definition("关联来源", schema(field("name"))), target = await h.definition("关联候选", content);
  const sourceRecord = await h.record(source.id, { name: "来源" });
  const relation = await h.relation({ title: "按秘密筛选", sourceDefinitionId: source.id, targetDefinitionId: target.id, cardinality: "many", inverseCardinality: "many", labelFieldId: "name", columns: ["name", "secret"], filters: [{ id: "secret_filter", sourceFieldId: "secret", operator: "equals", source: "constant", value: "匹配" }], mappings: [], valueMode: "live" });
  await direct(
    source.id,
    editor.id,
    policy({
      fields: { name: "edit" },
      relations: { [relation.id]: "edit" },
      actions: ["view", "edit"],
    }),
  );
  await direct(
    target.id,
    editor.id,
    policy({
      scope: "self",
      fields: { name: "edit", secret: "edit" },
      actions: ["view", "create"],
    }),
  );
  await subject(target.id, "role", role, policy({ fields: { name: "read", secret: "hidden" } }));
  const own = await h.record(target.id, { name: "可查看候选", secret: "匹配" }, "editor"); await h.record(target.id, { name: "不应泄露候选", secret: "匹配" });
  const candidates = await h.request(`/records/${sourceRecord.record.id}/relations/${relation.id}/candidates`, "GET", undefined, "editor");
  assert.equal(candidates.items.length, 1); assert.equal(candidates.items[0].recordId, own.record.id); assert.ok(!JSON.stringify(candidates).includes("不应泄露候选"));
});
test("archiving a role revokes its grants immediately and restoring it recovers the configured policy", async () => {
  const definition = await h.definition("角色停用", content); await subject(definition.id, "role", role, policy());
  const record = await h.record(definition.id, { name: "可读" }); const changed = structuredClone(base); changed.roles[0]!.archived = true; await save(changed);
  await h.request(`/records/${record.record.id}`, "GET", undefined, "editor", 403);
  await save(base); await h.request(`/records/${record.record.id}`, "GET", undefined, "editor");
});
test("group selection expands every member, previews changes, joins all tasks and preserves existing assignments", async () => {
  const definition = await h.definition("角色办理", content), object = await h.request(`/data-objects/${definition.id}/draft`), page = (await h.request(`/pages?definitionId=${definition.id}`))[0];
  const record = await h.record(definition.id, { name: "多成员办理", lines: [{ item: "A", count: 1 }, { item: "B", count: 2 }] });
  await subject(definition.id, "role", role, policy());
  const spec = {
    title: "角色逐人办理",
    startTaskIds: ["group"],
    endTaskIds: ["finish"],
    bindings: [
      {
        id: "business",
        title: "业务",
        definitionId: definition.id,
        definitionVersion: 1,
      },
    ],
    tasks: [
      {
        id: "group",
        title: "逐行确认",
        assigneeId: "",
        assigneeSelector: { kind: "role", id: role },
        recordBinding: "business",
        pageId: page.id,
        pageVersion: 1,
        subformId: "lines",
        requiredFields: [],
        dependsOn: [],
      },
      {
        id: "finish",
        title: "汇总",
        assigneeId: admin.id,
        recordBinding: "business",
        pageId: page.id,
        pageVersion: 1,
        requiredFields: [],
        dependsOn: ["group"],
      },
    ],
  };
  const template = await h.request("/process-templates", "POST", { requestId: randomUUID(), applicationId: object.applicationId, spec }, "admin", 201);
  await h.request(`/process-templates/${template.id}/publish`, "POST", { expectedRevision: template.revision }, "admin", 201);
  const path = `/process-templates/${template.id}/versions/1`, bindings = { business: record.record.id };
  const preview = await h.request(`${path}/preview`, "POST", { bindings }, "admin", 201); assert.equal(preview.tasks.length, 5); assert.equal(preview.tasks.at(-1).dependsOn.length, 4);
  await h.request(`${path}/start`, "POST", { requestId: randomUUID(), bindings, recordRevisions: preview.recordRevisions }, "admin", 409);
  const moved = structuredClone(base); moved.assignments[1]!.departmentIds = [other]; moved.assignments[1]!.primaryDepartmentId = other; await save(moved);
  await h.request(`${path}/start`, "POST", { requestId: randomUUID(), bindings, recordRevisions: preview.recordRevisions, participantsToken: preview.participantsToken }, "admin", 409);
  const fresh = await h.request(`${path}/preview`, "POST", { bindings }, "admin", 201); assert.equal(fresh.tasks.length, 3);
  const command = { requestId: randomUUID(), bindings, recordRevisions: fresh.recordRevisions, participantsToken: fresh.participantsToken };
  const process = await h.request(`${path}/start`, "POST", command, "admin", 201); assert.equal(process.tasks.length, 3);
  await save(base); const replay = await h.request(`${path}/start`, "POST", command, "admin", 201); assert.equal(replay.id, process.id); assert.equal(replay.tasks.length, 3);
  const assigned = (await h.db.query("SELECT assignee_id FROM tasks WHERE process_id=$1 ORDER BY task_key", [process.id])).rows.map(row => row.assignee_id);
  assert.deepEqual(assigned, [editor.id, editor.id, admin.id]);
  const archived = structuredClone(base); archived.roles[0]!.archived = true; await save(archived);
  const blocked = await h.request(`/processes/${process.id}`); assert.equal(blocked.summary.blocked, 2);
  await h.request(`/processes/${process.id}/tasks/${process.tasks[0].id}/complete`, "POST", {}, "editor", 409);
  await save(base);
  assert.equal((await h.request(`/processes/${process.id}`)).summary.ready, 2);
  for (const task of process.tasks.slice(0, 2)) await h.request(`/processes/${process.id}/tasks/${task.id}/complete`, "POST", {}, "editor", 201);
  const joined = await h.request(`/processes/${process.id}`); assert.equal(joined.summary.completed, 2); assert.equal(joined.summary.ready, 1);
  const completed = await h.request(`/processes/${process.id}/tasks/${process.tasks[2].id}/complete`, "POST", {}, "admin", 201); assert.equal(completed.status, "completed");
});
test("department selection honors descendant choice and an empty role cannot silently generate no work", async () => {
  const definition = await h.definition("部门取人", schema(field("name"))), object = await h.request(`/data-objects/${definition.id}/draft`), page = (await h.request(`/pages?definitionId=${definition.id}`))[0];
  const record = await h.record(definition.id, { name: "部门办理" }); await subject(definition.id, "role", role, policy({ fields: { name: "read" } }));
  const spec = {
    title: "部门办理",
    startTaskIds: ["department"],
    endTaskIds: ["department"],
    bindings: [
      {
        id: "business",
        title: "业务",
        definitionId: definition.id,
        definitionVersion: 1,
      },
    ],
    tasks: [
      {
        id: "department",
        title: "部门确认",
        assigneeId: "",
        assigneeSelector: {
          kind: "department",
          id: parent,
          includeChildren: false,
        },
        recordBinding: "business",
        pageId: page.id,
        pageVersion: 1,
        requiredFields: [],
        dependsOn: [],
      },
    ],
  };
  const template = await h.request("/process-templates", "POST", { requestId: randomUUID(), applicationId: object.applicationId, spec }, "admin", 201);
  await h.request(`/process-templates/${template.id}/publish`, "POST", { expectedRevision: template.revision }, "admin", 201);
  const path = `/process-templates/${template.id}/versions/1`;
  assert.equal((await h.request(`${path}/preview`, "POST", { bindings: { business: record.record.id } }, "admin", 201)).tasks.length, 1);
  const empty = structuredClone(base); empty.assignments = empty.assignments.filter(assignment => assignment.userId !== editor.id); await save(empty);
  await h.request(`${path}/preview`, "POST", { bindings: { business: record.record.id } }, "admin", 400);
});

test("workspace membership cannot be borrowed through a department or role", async () => {
  const definition = await h.definition("工作空间隔离", content); await subject(definition.id, "role", role, policy());
  await h.db.query("UPDATE users SET workspace_id='other_workspace' WHERE id=$1", [reviewer.id]);
  try {
    const current = await h.request('/organization'); assert.ok(!current.users.some((user: any) => user.id === reviewer.id));
    await h.request('/organization', 'PUT', { expectedRevision: current.revision, spec: base }, 'admin', 400);
    assert.ok(!(await h.request('/definitions', 'GET', undefined, 'reviewer')).some((item: any) => item.id === definition.id));
    await h.request(`/definitions/${definition.id}/published`, 'GET', undefined, 'reviewer', 404);
  } finally { await h.db.query("UPDATE users SET workspace_id='local' WHERE id=$1", [reviewer.id]); }
});

test("page publication counts active group members once and reflects membership changes", async () => {
  const definition = await h.definition("组授权发布检查", schema(field('name'))), page = (await h.request(`/pages?definitionId=${definition.id}`))[0];
  await subject(definition.id, 'role', role, policy({ fields: { name: 'read' } }));
  await direct(definition.id, editor.id, policy({ fields: { name: 'read' } }));
  const preview = () => h.request(`/pages/${page.id}/publish-preview`, 'POST', { expectedRevision: page.revision }, 'admin', 201);
  const initial = await preview(); assert.equal(initial.authorizedMembers, 2);
  const moved = structuredClone(base); moved.assignments[1]!.departmentIds = [other]; moved.assignments[1]!.primaryDepartmentId = other; await save(moved);
  const changed = await preview(); assert.equal(changed.authorizedMembers, 1); assert.notEqual(changed.token, initial.token);
});

for (const mode of ['record-update', 'page-update', 'record-create', 'page-create', 'record-link', 'page-link', 'record-unlink', 'page-unlink']) test(`organization changes serialize with ${mode} and revoke the next write`, async () => {
  const definition = await h.definition('调动并发边界', schema(field('name'))), record = await h.record(definition.id, { name: '原值' });
  await subject(
    definition.id,
    "role",
    role,
    policy({ fields: { name: "edit" }, actions: ["view", "create", "edit"] }),
  );
  const page = (await h.request(`/pages?definitionId=${definition.id}`))[0], creating = mode.endsWith('create'), paged = mode.startsWith('page');
  let relationPath = '', targetId = '';
  if (mode.endsWith('link')) {
    const target = await h.definition('关联目标', schema(field('name'))); targetId = (await h.record(target.id, { name: '参考数据' })).record.id;
    const relation = await h.relation({ title: '并发关联', sourceDefinitionId: definition.id, targetDefinitionId: target.id, cardinality: 'many', inverseCardinality: 'many', labelFieldId: 'name', columns: ['name'], filters: [], mappings: [], valueMode: 'live' });
    await subject(
      definition.id,
      "role",
      role,
      policy({
        fields: { name: "edit" },
        relations: { [relation.id]: "edit" },
        actions: ["view", "edit"],
      }),
    );
    await subject(target.id, 'role', role, policy({ fields: { name: 'read' } }));
    relationPath = `${paged ? `/pages/${page.id}` : ''}/records/${record.record.id}/relations/${relation.id}/links`;
    if (mode.endsWith('unlink')) {
      const existing = await h.request(relationPath, 'POST', { requestId: randomUUID(), targetRecordId: targetId, ...(paged ? { pageVersion: 1 } : {}) }, 'editor', 201);
      relationPath += `/${existing.link.id}/remove`;
    }
  }
  const barrier = await h.db.pool.connect(), key = 18743901;
  let writing: Promise<any> | undefined, moving: Promise<any> | undefined;
  const waitFor = async (condition: () => Promise<boolean>) => { const deadline = Date.now() + 5000; while (!(await condition())) { if (Date.now() > deadline) assert.fail('expected database lock was not reached'); await new Promise(resolve => setTimeout(resolve, 20)); } };
  await barrier.query('BEGIN'); await barrier.query('SELECT pg_advisory_xact_lock($1)', [key]);
  await h.db.query(`CREATE FUNCTION hold_org_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(${key}); RETURN NEW; END $$`);
  await h.db.query('CREATE TRIGGER hold_org_write BEFORE INSERT OR UPDATE ON records FOR EACH ROW EXECUTE FUNCTION hold_org_write()');
  try {
    const path = relationPath || (paged ? `/pages/${page.id}/records${creating ? '' : `/${record.record.id}`}` : creating ? `/definitions/${definition.id}/records` : `/records/${record.record.id}`);
    const body = { requestId: randomUUID(), ...(paged ? { pageVersion: 1 } : { version: 1 }), ...(relationPath ? { targetRecordId: targetId } : creating ? { values: { name: '调动前已授权的提交' } } : { changes: [{ fieldId: 'name', value: '调动前已授权的提交', expectedRevision: 1 }] }) };
    writing = h.request(path, creating || relationPath ? 'POST' : 'PATCH', body, 'editor', creating || relationPath ? 201 : 200);
    let writingPid = 0;
    await waitFor(async () => { writingPid = (await h.db.query("SELECT pid FROM pg_locks WHERE locktype='advisory' AND objid=$1 AND NOT granted", [key])).rows[0]?.pid; return !!writingPid; });
    const moved = structuredClone(base); moved.assignments[0]!.departmentIds = [other]; moved.assignments[0]!.primaryDepartmentId = other;
    moving = save(moved);
    await waitFor(async () => !!(await h.db.query("SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) AND query LIKE 'SELECT pg_advisory_xact_lock(hashtextextended%'", [writingPid])).rowCount);
    assert.equal((await h.db.query('SELECT revision FROM workspace_organizations')).rows[0].revision, organization.revision);
    await barrier.query('COMMIT'); const response = await writing, result = relationPath ? response.record : response; await moving;
    await h.request(`/records/${result.record.id}`, 'PATCH', { requestId: randomUUID(), changes: [{ fieldId: 'name', value: '不应写入', expectedRevision: result.record.cellRevisions.name }] }, 'editor', 403);
    assert.equal((await h.request(`/records/${result.record.id}`)).record.values.name, relationPath ? '原值' : '调动前已授权的提交');
    if (relationPath) assert.equal((await h.db.query('SELECT count(*)::int AS count FROM record_links WHERE source_record_id=$1', [result.record.id])).rows[0].count, mode.endsWith('unlink') ? 0 : 1);
  } finally {
    await barrier.query('ROLLBACK'); barrier.release(); await Promise.allSettled([writing, moving]);
    await h.db.query('DROP TRIGGER hold_org_write ON records'); await h.db.query('DROP FUNCTION hold_org_write()');
  }
});
