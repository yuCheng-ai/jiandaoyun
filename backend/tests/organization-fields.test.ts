import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { separateFormSchema, pageForModel, type FormSchema } from "@platform/contracts";
import { harness, field, schema } from "./helpers";

const h = harness(), main = randomUUID(), child = randomUUID(), other = randomUUID(), role = randomUUID(), group = randomUUID();
let users: any[], admin: string, editor: string, reviewer: string, definition: any, page: any;
const config = (scope = {}, defaults = {}) => ({ scope: { mode: "all", departmentIds: [], roleIds: [], employeeIds: [], includeChildren: true, fieldId: "", ...scope }, defaultMode: "none", defaultIds: [], ...defaults });
const member = (id: string, type = "member", scope = {}, defaults = {}, extra = {}) => field(id, type, { organization: config(scope, defaults), ...extra });
const layout = () => schema(field("note"), member("department", "department", {}, { defaultMode: "currentDepartment" }), member("owner", "member", { mode: "fieldDepartment", fieldId: "department" }, { defaultMode: "currentUser" }), member("reviewers", "members", { mode: "custom", roleIds: [role] }), member("manager", "member", {}, { defaultMode: "departmentManager" }), member("departments", "departments"), field("lines", "subform", { children: [member("lineDepartment", "department", {}, { defaultMode: "currentDepartment" }), member("handler", "member", { mode: "fieldDepartment", fieldId: "lineDepartment" }, { defaultMode: "currentUser" }), member("helpers", "members")] }));
const create = (values: unknown, user = "admin", expected = 201) => h.request(`/pages/${page.id}/records`, "POST", { pageVersion: 1, requestId: randomUUID(), values }, user, expected);
const options = (body: any, user = "admin", expected = 201) => h.request(`/pages/${page.id}/organization-options`, "POST", { pageVersion: 1, ...body }, user, expected);
before(async () => {
  await h.start(); users = await h.request("/users");
  [admin, editor, reviewer] = ["admin", "editor", "reviewer"].map(name => users.find(user => user.username === name).id);
  await h.request("/organization", "PUT", { expectedRevision: 0, spec: {
    departments: [{ id: main, name: "业务部", parentId: null, archived: false, managerIds: [reviewer] }, { id: child, name: "业务一组", parentId: main, archived: false }, { id: other, name: "财务部", parentId: null, archived: false }],
    roleGroups: [{ id: group, name: "业务角色" }], roles: [{ id: role, groupId: group, name: "复核人", description: "", memberIds: [reviewer], departmentIds: [], includeChildren: false, archived: false }],
    assignments: [{ userId: admin, departmentIds: [main], primaryDepartmentId: main }, { userId: editor, departmentIds: [child], primaryDepartmentId: child }, { userId: reviewer, departmentIds: [other], primaryDepartmentId: other }],
  } });
  definition = await h.definition("组织字段", layout()); page = (await h.request(`/pages?definitionId=${definition.id}`))[0];
  await h.permissionGroup(definition.id, {
    id: "member_" + editor,
    subjects: [{ kind: "member", id: editor }],
    scope: "all",
    fields: {
      note: "edit",
      department: "edit",
      owner: "edit",
      reviewers: "hidden",
      manager: "hidden",
      departments: "edit",
      lines: "edit",
      lineDepartment: "edit",
      handler: "read",
      helpers: "edit",
    },
    actions: ["view", "create", "edit"],
  });
});
after(() => h.close());

test("authenticated defaults and main/subform identity values survive shared pages and restart", async () => {
  const form = await h.request(`/pages/${page.id}/form`);
  assert.equal(form.defaultValues.owner, admin); assert.equal(form.defaultValues.manager, reviewer); assert.equal(form.defaultValues.department, main);
  const record = await create({ lines: [{ helpers: [editor] }], reviewers: [reviewer], departments: [main, other] });
  assert.equal(record.record.values.lines[0].handler, admin); assert.equal(record.record.values.lines[0].lineDepartment, main);
  assert.equal(record.identities.find((item: any) => item.id === editor).name, users.find(user => user.id === editor).name);
  const shared = await h.request(`/pages/${page.id}`);
  const another = await h.request("/pages", "POST", { title: "另一个组织页面", definitionId: definition.id, definitionVersion: 1, schema: pageForModel(shared.model) }, "admin", 201);
  await h.request(`/pages/${another.id}/publish`, "POST", { expectedRevision: another.revision }, "admin", 201);
  await h.restart();
  assert.deepEqual((await h.request(`/pages/${another.id}/records/${record.record.id}`)).record.values, record.record.values);
});

test("candidate endpoints follow department, descendants and role scope without exposing directory or hidden identities", async () => {
  assert.deepEqual(new Set((await options({ fieldId: "owner", context: { department: main } })).options.map((item: any) => item.id)), new Set([admin, editor]));
  assert.deepEqual((await options({ fieldId: "owner", context: { department: other } })).options.map((item: any) => item.id), [reviewer]);
  assert.deepEqual((await options({ fieldId: "reviewers" })).options.map((item: any) => item.id), [reviewer]);
  await options({ fieldId: "reviewers" }, "editor", 403);
  await options({ fieldId: "handler", subformId: "lines" }, "editor", 403);
  await options({ fieldId: "owner", context: { manager: reviewer } }, "editor", 403);
  const own = await create({ note: "成员新增", lines: [{}] }, "editor");
  assert.equal(own.record.values.owner, editor); assert.equal(own.record.values.lines[0].handler, editor);
  assert.equal(own.record.values.manager, undefined); assert.equal(own.identities.some((item: any) => item.id === reviewer), false);
  assert.equal((await options({ fieldId: "owner" }, "editor")).options.some((item: any) => "username" in item || "role" in item), false);
});

test("malformed, out-of-scope and foreign identities fail atomically through create and patch", async () => {
  for (const values of [{ owner: reviewer }, { owner: randomUUID() }, { owner: [admin] }, { reviewers: admin }, { departments: [main, main] }, { reviewers: [admin] }, { lines: [{ lineDepartment: other, handler: admin }] }]) await create(values, "admin", 400);
  const record = await create({ lines: [{ handler: editor }] });
  await h.request(`/records/${record.record.id}`, "PATCH", { requestId: randomUUID(), changes: [{ fieldId: "note", value: "应回滚", expectedRevision: 1 }, { fieldId: "owner", value: reviewer, expectedRevision: 1 }] }, "admin", 400);
  assert.equal((await h.request(`/records/${record.record.id}`)).record.values.note, "");
  await h.request(`/records/${record.record.id}`, "PATCH", { requestId: randomUUID(), changes: [{ fieldId: "department", value: other, expectedRevision: 1 }] }, "admin", 400);
  const changed = await h.request(`/records/${record.record.id}`, "PATCH", { requestId: randomUUID(), changes: [{ fieldId: "department", value: other, expectedRevision: 1 }, { fieldId: "owner", value: reviewer, expectedRevision: 1 }] });
  assert.equal(changed.record.values.owner, reviewer);
});

test("inactive history remains readable and unrelated edits succeed, while new assignments and row additions are rejected", async () => {
  const record = await create({ owner: editor, lines: [{ handler: editor }] });
  await h.db.query("UPDATE users SET active=false WHERE id=$1", [editor]);
  try {
    const view = await h.request(`/records/${record.record.id}`);
    assert.equal(view.identities.find((item: any) => item.id === editor).active, false);
    assert.equal((await options({ fieldId: "owner", recordId: record.record.id })).options.some((item: any) => item.id === editor), false);
    await h.request(`/records/${record.record.id}`, "PATCH", { requestId: randomUUID(), changes: [{ fieldId: "note", value: "历史保留", expectedRevision: 1 }] });
    await create({ owner: editor }, "admin", 400);
    await h.request(`/records/${record.record.id}`, "PATCH", { requestId: randomUUID(), rows: [{ action: "add", subformId: "lines", expectedRevision: 1, values: { handler: editor } }] }, "admin", 400);
  } finally { await h.db.query("UPDATE users SET active=true WHERE id=$1", [editor]); }
});

test("publication rejects cross-row dependencies, cycles and nonexistent directory references", async () => {
  for (const fields of [
    [member("x", "member", { mode: "fieldDepartment", fieldId: "missing" })],
    [member("x", "department", { mode: "fieldDepartment", fieldId: "y" }), member("y", "department", { mode: "fieldDepartment", fieldId: "x" })],
    [member("x", "member", { mode: "custom", employeeIds: [randomUUID()] })],
    [member("x", "member", { mode: "fieldDepartment", fieldId: "nested" }), field("rows", "subform", { children: [member("nested", "department")] })],
  ]) {
    const def = await h.request("/data-objects", "POST", { title: "不合法范围", model: separateFormSchema(schema(...fields) as unknown as FormSchema).model }, "admin", 201);
    await h.request(`/data-objects/${def.id}/publish`, "POST", { expectedRevision: 1 }, "admin", 400);
  }
  for (const item of [member("x", "member", {}, { defaultMode: "currentDepartment" }), member("x", "department", {}, { defaultIds: [main, other] }), member("x", "member", { employeeIds: ["local-person"] })]) await h.request("/data-objects", "POST", { title: "无效格式", model: separateFormSchema(schema(item) as unknown as FormSchema).model }, "admin", 400);
});

test("a page cannot request field candidates or alter department conditions outside its binding", async () => {
  const published = await h.request(`/pages/${page.id}`), schema = pageForModel(published.model);
  schema.controls = schema.controls.filter(control => control.binding?.fieldId === "owner");
  const limited = await h.request("/pages", "POST", { title: "只处理成员", definitionId: definition.id, definitionVersion: 1, schema }, "admin", 201);
  await h.request(`/pages/${limited.id}/publish`, "POST", { expectedRevision: limited.revision }, "admin", 201);
  const record = await create({ department: main });
  const result = await h.request(`/pages/${limited.id}/organization-options`, "POST", { pageVersion: 1, recordId: record.record.id, fieldId: "owner" }, "admin", 201);
  assert.deepEqual(new Set(result.options.map((item: any) => item.id)), new Set([admin, editor]));
  await h.request(`/pages/${limited.id}/organization-options`, "POST", { pageVersion: 1, recordId: record.record.id, fieldId: "owner", context: { department: other } }, "admin", 403);
  await h.request(`/pages/${limited.id}/organization-options`, "POST", { pageVersion: 1, fieldId: "manager" }, "admin", 403);
});

test("relation fills obey destination identity scopes and leave no link on failure", async () => {
  const target = await h.definition("组织来源", schema(member("who")));
  const origin = await create({}), destination = await h.record(target.id, { who: reviewer });
  const relation = await h.relation({ title: "负责人来源", sourceDefinitionId: definition.id, targetDefinitionId: target.id, cardinality: "one", inverseCardinality: "many", valueMode: "snapshot", labelFieldId: "who", columns: [], filters: [], mappings: [{ fromTargetFieldId: "who", toSourceFieldId: "owner" }] });
  const candidates = await h.request(`/records/${origin.record.id}/relations/${relation.id}/candidates`);
  assert.equal(candidates.items[0].label, users.find(user => user.id === reviewer).name);
  assert.equal(candidates.items[0].mappings[0].beforeLabel, users.find(user => user.id === admin).name);
  await h.request(`/records/${origin.record.id}/relations/${relation.id}/links`, "POST", { targetRecordId: destination.record.id, expectedCells: { owner: 1 }, requestId: randomUUID() }, "admin", 400);
  assert.equal((await h.request(`/records/${origin.record.id}/relations`))[0].links.length, 0);
});

test("task field candidates enforce task state, row identity and current permissions", async () => {
  const record = await create({ lines: [{}] }), rowId = record.record.values.lines[0]._rowId;
  const process = await h.request("/processes", "POST", { requestId: randomUUID(), bindings: { main: record.record.id }, spec: { title: "人员行任务", tasks: [{ id: "one", title: "选择经办人", assigneeId: admin, recordBinding: "main", pageId: page.id, pageVersion: 1, subformId: "lines", rowId, requiredFields: [], dependsOn: [] }] } }, "admin", 201);
  const path = `/processes/${process.id}/tasks/${process.tasks[0].id}/organization-options`;
  const result = await h.request(path, "POST", { fieldId: "handler", subformId: "lines", rowId }, "admin", 201);
  assert.ok(result.options.some((item: any) => item.id === editor));
  await h.request(path, "POST", { fieldId: "owner" }, "admin", 403);
  await h.request(path, "POST", { fieldId: "handler", subformId: "lines", rowId: randomUUID() }, "admin", 403);
  await h.request(`/processes/${process.id}/tasks/${process.tasks[0].id}/complete`, "POST", {}, "admin", 201);
  await h.request(path, "POST", { fieldId: "handler", subformId: "lines", rowId }, "admin", 403);
});

test("record upgrades preview resolved identity defaults and reject changed organization defaults without mutating history", async () => {
  const def = await h.definition("组织默认值升级", schema(field("text"))), record = await h.record(def.id, { text: "保留" });
  const page = (await h.request(`/pages?definitionId=${def.id}`))[0];
  const next = separateFormSchema(schema(
    field("text"),
    member("department", "department", {}, { defaultMode: "currentDepartment" }),
    member("manager", "member", {}, { defaultMode: "departmentManager" }),
  ) as unknown as FormSchema);
  await h.request(`/data-objects/${def.id}`, "PUT", { title: "组织默认值升级", expectedRevision: 2, model: next.model });
  await h.request(`/data-objects/${def.id}/publish`, "POST", { expectedRevision: 3 }, "admin", 201);
  const currentPage = await h.request(`/pages/${page.id}/draft`);
  const nextPage = await h.request(`/pages/${page.id}`, "PUT", {
    ...currentPage,
    expectedRevision: currentPage.revision,
    definitionVersion: 2,
    schema: next.page,
  });
  await h.request(
    `/pages/${page.id}/publish`,
    "POST",
    { expectedRevision: nextPage.revision },
    "admin",
    201,
  );
  const path = `/pages/${page.id}/records/${record.record.id}/upgrade`, plan = await h.request(`${path}?version=2`);
  assert.equal(plan.allowed, true); assert.equal(plan.additions.find((item: any) => item.fieldId === "department").defaultDisplay, "业务部");
  let org = await h.request("/organization"); org.spec.departments.find((item: any) => item.id === main).managerIds = [editor];
  org = await h.request("/organization", "PUT", { expectedRevision: org.revision, spec: org.spec });
  await h.request(path, "POST", { pageVersion: 2, requestId: randomUUID(), expectedRevision: 1, defaultsToken: plan.defaultsToken }, "admin", 409);
  assert.equal((await h.request(`/records/${record.record.id}`)).record.definitionVersion, 1);
  const fresh = await h.request(`${path}?version=2`);
  const upgraded = await h.request(path, "POST", { pageVersion: 2, requestId: randomUUID(), expectedRevision: 1, defaultsToken: fresh.defaultsToken }, "admin", 201);
  assert.equal(upgraded.record.values.manager, editor); assert.equal(upgraded.record.values.text, "保留");
  org.spec.departments.find((item: any) => item.id === main).managerIds = [reviewer];
  await h.request("/organization", "PUT", { expectedRevision: org.revision, spec: org.spec });
});

test("deleted-row recovery checks current identity availability and retains the deletion on failure", async () => {
  const record = await create({ lines: [{ handler: editor }] }), rowId = record.record.values.lines[0]._rowId;
  await h.request(`/records/${record.record.id}`, "PATCH", { requestId: randomUUID(), rows: [{ action: "remove", subformId: "lines", rowId, expectedRevision: 1, expectedCells: Object.fromEntries(Object.entries(record.record.cellRevisions).filter(([key]) => key.startsWith(`lines/${rowId}/`))) }] });
  const deleted = (await h.request(`/records/${record.record.id}/removed-rows`))[0]; assert.equal(deleted.restorable, true);
  await h.db.query("UPDATE users SET active=false WHERE id=$1", [editor]);
  try {
    const invalid = (await h.request(`/records/${record.record.id}/removed-rows`))[0]; assert.equal(invalid.restorable, false); assert.match(invalid.reason, /选择范围/);
    await h.request(`/records/${record.record.id}`, "PATCH", { requestId: randomUUID(), rows: [{ action: "restore", subformId: "lines", rowId, eventId: deleted.eventId, expectedRevision: 2 }] }, "admin", 400);
    assert.equal((await h.request(`/records/${record.record.id}`)).record.values.lines.length, 0);
  } finally { await h.db.query("UPDATE users SET active=true WHERE id=$1", [editor]); }
});

test("model review counts current organization-scope incompatibilities without rewriting historical records", async () => {
  const def = await h.definition("选人范围变更", schema(member("owner")));
  const record = await h.record(def.id, { owner: editor });
  await h.request(`/data-objects/${def.id}`, "PUT", { title: "选人范围变更", expectedRevision: 2, model: separateFormSchema(schema(member("owner", "member", { mode: "custom", employeeIds: [reviewer] })) as unknown as FormSchema).model });
  const preview = await h.request(`/data-objects/${def.id}/publish-preview`, "POST", { expectedRevision: 3 }, "admin", 201);
  assert.equal(preview.records[0].incompatible, 1); assert.match(preview.organizationCheck, /当前检查人/);
  assert.ok(preview.changes.changed[0].details.some((text: string) => text.includes(users.find(user => user.id === reviewer).name)));
  await h.request(`/data-objects/${def.id}/publish`, "POST", { expectedRevision: 3, impactToken: preview.token }, "admin", 201);
  const old = await h.request(`/records/${record.record.id}`);
  assert.equal(old.record.definitionVersion, 1); assert.equal(old.record.values.owner, editor);
});
