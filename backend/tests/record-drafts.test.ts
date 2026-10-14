import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pageForModel, type RecordPermissionGroup } from "@platform/contracts";
import { harness, field, schema } from "./helpers";
const h = harness(); let editor: string, reviewer: string, admin: string;
const layout = () => schema(field("title", "text", { required: true }), field("quantity", "number", { required: true, min: 1 }), field("lines", "subform", { required: true, children: [field("item", "text", { required: true })] }));
async function setup() {
  const definition = await h.definition("草稿业务", layout()), page = (await h.request(`/pages?definitionId=${definition.id}`))[0];
  const policy: Pick<RecordPermissionGroup, "scope" | "fields" | "actions"> = {
    scope: "all",
    fields: { title: "edit", quantity: "edit", lines: "edit", item: "edit" },
    actions: ["view", "create"],
  };
  await h.permissionGroup(definition.id, {
    id: "member_" + editor,
    subjects: [{ kind: "member", id: editor }],
    ...policy,
  });
  await h.permissionGroup(definition.id, {
    id: "member_" + reviewer,
    subjects: [{ kind: "member", id: reviewer }],
    ...policy,
    actions: ["view", "create", "edit"],
  });
  return { definition, page, policy };
}
const draft = (f: any, values = {}, user = "editor") => h.request(`/pages/${f.page.id}/records`, "POST", { requestId: randomUUID(), pageVersion: 1, state: "draft", values }, user, 201);
const content = { title: "完整业务", quantity: 2, lines: [{ item: "明细" }] };
const submit = (f: any, d: any, extra = {}, expected = 201, user = "editor") => h.request(`/pages/${f.page.id}/records/${d.record.id}/submit`, "POST", { requestId: randomUUID(), pageVersion: 1, expectedRevision: d.record.revision, ...extra }, user, expected);
before(async () => { await h.start(); const users = await h.request("/users"); [admin, editor, reviewer] = ["admin", "editor", "reviewer"].map(name => users.find((u: any) => u.username === name).id); });
after(() => h.close());

test("partial drafts persist under the published version and stay out of active lists", async () => {
  const f = await setup(), d = await draft(f);
  assert.equal(d.record.state, "draft"); assert.equal(d.record.createdBy, editor); assert.equal(d.access.edit, true);
  assert.deepEqual(await h.request(`/definitions/${f.definition.id}/records`), []);
  assert.equal((await h.request(`/definitions/${f.definition.id}/records?state=draft`, "GET", undefined, "editor"))[0].id, d.record.id);
  await h.restart(); const restored = await h.request(`/pages/${f.page.id}/records/${d.record.id}`, "GET", undefined, "editor");
  assert.equal(restored.record.state, "draft"); assert.deepEqual(restored.record.values, d.record.values);
  await h.request(`/pages/${f.page.id}/records`, "POST", { requestId: randomUUID(), pageVersion: 1, values: {} }, "editor", 400);
  await h.request(`/pages/${f.page.id}/records`, "POST", { requestId: randomUUID(), pageVersion: 1, state: "approved", values: content }, "editor", 400);
});

test("create-only members can resume and atomically submit their own draft but cannot edit submitted data", async () => {
  const f = await setup(), d = await draft(f), requestId = randomUUID();
  const body = { requestId, changes: [{ fieldId: "title", expectedRevision: 1, value: content.title }, { fieldId: "quantity", expectedRevision: 1, value: content.quantity }], rows: [{ action: "add", subformId: "lines", expectedRevision: 1, values: { item: "明细" } }] };
  const result = await submit(f, d, body), retried = await submit(f, d, body);
  assert.equal(result.record.state, "active"); assert.equal(result.record.createdBy, editor); assert.equal(result.access.edit, false);
  assert.deepEqual(retried.record, result.record); assert.equal(result.record.values.lines.length, 1);
  assert.equal((await h.request(`/definitions/${f.definition.id}/records`, "GET", undefined, "editor"))[0].id, d.record.id);
  assert.deepEqual(await h.request(`/definitions/${f.definition.id}/records?state=draft`, "GET", undefined, "editor"), []);
  await h.request(`/records/${d.record.id}`, "PATCH", { requestId: randomUUID(), changes: [{ fieldId: "title", expectedRevision: 2, value: "越权" }] }, "editor", 403);
  const events = (await h.db.query("SELECT actor_id,changes FROM record_events WHERE record_id=$1 ORDER BY revision", [d.record.id])).rows;
  assert.equal(events[0].changes.action, "draft-create"); assert.equal(events.at(-1).changes.action, "submit-draft"); assert.equal(events.every(row => row.actor_id === editor), true);
});

test("failed submission rolls back pending edits, rows and commands; stale record revisions cannot submit", async () => {
  const f = await setup(), d = await draft(f), requestId = randomUUID();
  await submit(f, d, { requestId, changes: [{ fieldId: "title", expectedRevision: 1, value: "不能部分保存" }] }, 400);
  const preserved = await h.request(`/records/${d.record.id}`, "GET", undefined, "editor"); assert.deepEqual(preserved.record, d.record);
  assert.equal((await h.db.query("SELECT 1 FROM commands WHERE actor_id=$1 AND request_id=$2", [editor, requestId])).rowCount, 0);
  await h.request(`/records/${d.record.id}`, "PATCH", { requestId: randomUUID(), changes: [{ fieldId: "title", expectedRevision: 1, value: "继续填写" }] }, "editor");
  await submit(f, d, {}, 409);
  assert.equal((await h.request(`/records/${d.record.id}`, "GET", undefined, "editor")).record.state, "draft");
});

test("read-all policies do not reveal other members' drafts and revoked creation stops further draft writes", async () => {
  const f = await setup(), d = await draft(f);
  assert.deepEqual(await h.request(`/definitions/${f.definition.id}/records?state=draft`, "GET", undefined, "reviewer"), []);
  await h.request(`/records/${d.record.id}`, "GET", undefined, "reviewer", 403);
  await h.request(`/records/${d.record.id}`, "PATCH", { requestId: randomUUID(), changes: [{ fieldId: "title", expectedRevision: 1, value: "他人草稿" }] }, "reviewer", 403);
  await submit(f, d, {}, 403, "reviewer");
  await h.permissionGroup(f.definition.id, {
    id: "member_" + editor,
    subjects: [{ kind: "member", id: editor }],
    ...f.policy,
    actions: ["view", "edit"],
  });
  await h.request(`/records/${d.record.id}`, "GET", undefined, "editor", 403);
  await h.request(`/records/${d.record.id}`, "PATCH", { requestId: randomUUID(), changes: [{ fieldId: "title", expectedRevision: 1, value: "撤权后" }] }, "editor", 403);
  await submit(f, d, {}, 403);
});

test("drafts never enter direct processes, wait bindings or published-template candidates", async () => {
  const f = await setup(), d = await draft(f, content), active = await h.record(f.definition.id, content);
  const spec = { title: "业务处理", tasks: [{ id: "work", title: "办理", assigneeId: admin, recordBinding: "business", dependsOn: [] }] };
  await h.request("/processes", "POST", { requestId: randomUUID(), spec, bindings: { business: d.record.id } }, "admin", 409);
  await h.request("/processes", "POST", { requestId: randomUUID(), spec: { ...spec, tasks: [{ ...spec.tasks[0], waitFor: { recordBinding: "waiting", fieldId: "title", equals: content.title } }] }, bindings: { business: active.record.id, waiting: d.record.id } }, "admin", 409);
  const object = await h.request(`/data-objects/${f.definition.id}/draft`);
  const template = await h.request(
    "/process-templates",
    "POST",
    {
      requestId: randomUUID(),
      applicationId: object.applicationId,
      spec: {
        title: "草稿排除",
        startTaskIds: ["work"],
        endTaskIds: ["work"],
        bindings: [
          {
            id: "business",
            title: "业务",
            definitionId: f.definition.id,
            definitionVersion: 1,
          },
        ],
        tasks: [
          {
            ...spec.tasks[0],
            pageId: f.page.id,
            pageVersion: 1,
            requiredFields: [],
          },
        ],
      },
    },
    "admin",
    201,
  );
  await h.request(`/process-templates/${template.id}/publish`, "POST", { expectedRevision: template.revision }, "admin", 201);
  const candidates = await h.request(`/process-templates/${template.id}/versions/1/records?bindingId=business`);
  assert.equal(candidates.some((row: any) => row.id === d.record.id), false);
  await h.request(`/process-templates/${template.id}/versions/1/preview`, "POST", { bindings: { business: d.record.id } }, "admin", 409);
});

test("drafts cannot be relation sources or targets, including direct link requests", async () => {
  const f = await setup(), target = await setup(), sourceDraft = await draft(f, content), targetDraft = await draft(target, content), active = await h.record(f.definition.id, content);
  const relation = await h.relation({ title: "业务引用", sourceDefinitionId: f.definition.id, targetDefinitionId: target.definition.id, cardinality: "many", inverseCardinality: "many", labelFieldId: "title", columns: ["title"], filters: [], mappings: [], valueMode: "live" });
  const candidates = await h.request(`/records/${active.record.id}/relations/${relation.id}/candidates`);
  assert.equal(candidates.items.some((row: any) => row.recordId === targetDraft.record.id), false);
  await h.request(`/records/${sourceDraft.record.id}/relations/${relation.id}/candidates`, "GET", undefined, "admin", 409);
  await h.request(`/records/${active.record.id}/relations/${relation.id}/links`, "POST", { requestId: randomUUID(), targetRecordId: targetDraft.record.id, expectedCells: active.record.cellRevisions }, "admin", 404);
});

test("incomplete draft rows remain editable and restorable without relaxing value type rules", async () => {
  const f = await setup(), d = await draft(f, { lines: [{}] });
  await h.request(`/records/${d.record.id}`, "PATCH", { requestId: randomUUID(), changes: [{ fieldId: "quantity", expectedRevision: 1, value: "not a number" }] }, "editor", 400);
  const row = d.record.values.lines[0], cell = `lines/${row._rowId}/item`;
  await h.request(`/records/${d.record.id}`, "PATCH", { requestId: randomUUID(), rows: [{ action: "remove", subformId: "lines", expectedRevision: 1, rowId: row._rowId, expectedCells: { [cell]: 1 } }] }, "editor");
  const deleted = await h.request(`/records/${d.record.id}/removed-rows`, "GET", undefined, "editor"); assert.equal(deleted[0].restorable, true);
  const restored = await h.request(`/records/${d.record.id}`, "PATCH", { requestId: randomUUID(), rows: [{ action: "restore", subformId: "lines", expectedRevision: 2, rowId: row._rowId, eventId: deleted[0].eventId }] }, "editor");
  assert.equal(restored.record.values.lines[0]._rowId, row._rowId); assert.equal(restored.record.state, "draft");
});

test("page-required fields remain optional in a saved draft and are checked against the explicit page on submission", async () => {
  const definition = await h.definition("页面补全", schema(field("note")));
  const object = await h.request(`/data-objects/${definition.id}/draft`), pageSchema = pageForModel(object.model);
  pageSchema.controls[0]!.properties.required = true;
  const page = await h.request("/pages", "POST", { title: "必填办理页", definitionId: definition.id, definitionVersion: 1, baseDefinitionRevision: object.revision, additions: [], schema: pageSchema }, "admin", 201);
  await h.request(`/pages/${page.id}/publish`, "POST", { expectedRevision: page.revision }, "admin", 201);
  const f = { definition, page }, d = await draft(f, {}, "admin");
  await submit(f, d, {}, 400, "admin");
  await submit(f, d, { pageVersion: 99 }, 404, "admin");
  assert.deepEqual((await h.request(`/records/${d.record.id}`)).record, d.record);
  const result = await submit(f, d, { changes: [{ fieldId: "note", expectedRevision: 1, value: "已补全" }] }, 201, "admin");
  assert.equal(result.record.state, "active");
});

test("submission audit failure rolls back the state transition, pending values and idempotency command", async () => {
  const f = await setup(), d = await draft(f, content), requestId = randomUUID();
  await h.db.query("CREATE FUNCTION reject_draft_submit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.changes->>'action'='submit-draft' THEN RAISE EXCEPTION 'submission audit failure'; END IF; RETURN NEW; END $$");
  await h.db.query("CREATE TRIGGER reject_draft_submit BEFORE INSERT ON record_events FOR EACH ROW EXECUTE FUNCTION reject_draft_submit()");
  const body = { requestId, changes: [{ fieldId: "title", expectedRevision: 1, value: "事务提交" }] };
  try { await submit(f, d, body, 500); }
  finally { await h.db.query("DROP TRIGGER reject_draft_submit ON record_events"); await h.db.query("DROP FUNCTION reject_draft_submit()"); }
  assert.deepEqual((await h.request(`/records/${d.record.id}`, "GET", undefined, "editor")).record, d.record);
  assert.equal((await h.db.query("SELECT 1 FROM record_events WHERE record_id=$1", [d.record.id])).rowCount, 1);
  assert.equal((await h.db.query("SELECT 1 FROM commands WHERE actor_id=$1 AND request_id=$2", [editor, requestId])).rowCount, 0);
  const retried = await submit(f, d, body);
  assert.equal(retried.record.state, "active"); assert.equal(retried.record.values.title, "事务提交");
});
