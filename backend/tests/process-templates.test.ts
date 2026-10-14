import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { ProcessTemplateSpec } from "@platform/contracts";
import { field, harness, schema, type TestPermissionGroup } from "./helpers";
const h = harness();
let main: any, auxiliary: any, mainPage: any, auxiliaryPage: any, mainRecord: any, auxiliaryRecord: any, editor: any, reviewer: any, appId: string, published: any, processView: any, secondaryProcess: any;
const mainSchema = schema(field("name"), field("decision"), field("private"), field("lines", "subform", { children: [field("item"), field("quantity", "number"), field("outcome")] }));
const auxiliarySchema = schema(field("name"), field("state"));
const grant = (user: any, fields: any): TestPermissionGroup => ({
  id: "member_" + user.id,
  subjects: [{ kind: "member", id: user.id }],
  scope: "all",
  fields,
  actions: ["view", "edit"],
});
const editorFields = { name: "read", decision: "hidden", private: "hidden", lines: "edit", item: "read", quantity: "edit", outcome: "edit" };
const reviewerFields = { name: "read", decision: "edit", private: "hidden", lines: "read", item: "read", quantity: "read", outcome: "read" };
function spec(): ProcessTemplateSpec {
  return {
    title: "明细办理与资料核对",
    startTaskIds: ["lines", "check"],
    endTaskIds: ["finish"],
    bindings: [
      {
        id: "business",
        title: "业务单据",
        definitionId: main.id,
        definitionVersion: 1,
      },
      {
        id: "support",
        title: "辅助资料",
        definitionId: auxiliary.id,
        definitionVersion: 1,
      },
    ],
    tasks: [
      {
        id: "lines",
        title: "办理明细",
        recordBinding: "business",
        assigneeId: editor.id,
        pageId: mainPage.id,
        pageVersion: 1,
        subformId: "lines",
        requiredFields: ["outcome"],
        dependsOn: [],
      },
      {
        id: "check",
        title: "核对资料",
        recordBinding: "support",
        assigneeId: reviewer.id,
        pageId: auxiliaryPage.id,
        pageVersion: 1,
        requiredFields: [],
        dependsOn: [],
      },
      {
        id: "finish",
        title: "汇总确认",
        recordBinding: "business",
        assigneeId: reviewer.id,
        pageId: mainPage.id,
        pageVersion: 1,
        requiredFields: ["decision"],
        dependsOn: ["lines", "check"],
        waitFor: {
          recordBinding: "support",
          fieldId: "state",
          equals: "可确认",
        },
      },
    ],
  };
}
async function save(specification: ProcessTemplateSpec) { return h.request("/process-templates", "POST", { requestId: randomUUID(), applicationId: appId, spec: specification }, "admin", 201); }
async function publish(specification: ProcessTemplateSpec) {
  const draft = await save(specification); return h.request(`/process-templates/${draft.id}/publish`, "POST", { expectedRevision: draft.revision }, "admin", 201);
}
const path = (template = published) => `/process-templates/${template.id}/versions/${template.version}`;
const bindings = () => ({ business: mainRecord.record.id, support: auxiliaryRecord.record.id });
const taskPath = (task: any, current = processView) => `/processes/${current.id}/tasks/${task.id}`;
const waitFor = async (condition: () => Promise<boolean>) => {
  const deadline = Date.now() + 12000;
  while (!(await condition())) { if (Date.now() > deadline) assert.fail("background task refresh did not settle"); await new Promise(resolve => setTimeout(resolve, 100)); }
};
before(async () => {
  await h.start();
  const users = await h.request("/users"); editor = users.find((u: any) => u.username === "editor"); reviewer = users.find((u: any) => u.username === "reviewer");
  main = await h.definition("业务单据", mainSchema); auxiliary = await h.definition("辅助资料", auxiliarySchema);
  mainPage = (await h.request(`/pages?definitionId=${main.id}`))[0]; auxiliaryPage = (await h.request(`/pages?definitionId=${auxiliary.id}`))[0];
  appId = (await h.request(`/data-objects/${main.id}/draft`)).applicationId;
  mainRecord = await h.record(main.id, { name: "协作业务", decision: "", private: "不应泄露", lines: [{ item: "A", quantity: 1, outcome: "" }, { item: "B", quantity: 2, outcome: "" }] });
  auxiliaryRecord = await h.record(auxiliary.id, { name: "辅助单据", state: "待核对" });
  await h.permissionGroup(main.id, grant(editor, editorFields));
  await h.permissionGroup(main.id, grant(reviewer, reviewerFields));
  await h.permissionGroup(
    auxiliary.id,
    grant(reviewer, { name: "read", state: "edit" }),
  );
});
after(() => h.close());

test("template drafts, revision conflicts, admin boundaries and immutable published versions", async () => {
  const blank = await save({ title: "未完成草稿", bindings: [], tasks: [] });
  await h.request(`/process-templates/${blank.id}/publish`, "POST", { expectedRevision: blank.revision }, "admin", 400);
  const draft = await save(spec());
  await h.request(`/process-templates/${draft.id}`, "PUT", { expectedRevision: 0, spec: spec() }, "admin", 409);
  published = await h.request(`/process-templates/${draft.id}/publish`, "POST", { expectedRevision: draft.revision }, "admin", 201);
  assert.equal(published.version, 1);
  await assert.rejects(h.db.query("UPDATE process_template_versions SET spec='{}' WHERE template_id=$1", [published.id]), /immutable/);
  const list = await h.request(`/process-templates?applicationId=${appId}`);
  assert.equal(list.find((t: any) => t.id === published.id).hasDraftChanges, false);
  await h.request(`/process-templates/${draft.id}`, "PUT", { expectedRevision: 2, spec: { ...spec(), title: "后续草稿" } });
  assert.equal((await h.request(path())).spec.title, "明细办理与资料核对");
});
test("publication rejects cycles, out-of-scope required fields and mismatched processing pages", async () => {
  const cases = [spec(), spec(), spec(), spec()];
  cases[0]!.tasks[0]!.dependsOn = ["finish"];
  cases[1]!.tasks[0]!.requiredFields = ["decision"];
  cases[2]!.tasks[0]!.pageId = auxiliaryPage.id;
  cases[3]!.tasks[2]!.waitFor = { recordBinding: "business", subformId: "lines", fieldId: "quantity", equals: 1 };
  for (const invalid of cases) { const draft = await save(invalid); await h.request(`/process-templates/${draft.id}/publish`, "POST", { expectedRevision: draft.revision }, "admin", 400); }
});
test("preview expands current rows, parallel nodes and dependencies joining all predecessor tasks", async () => {
  const preview = await h.request(`${path()}/preview`, "POST", { bindings: bindings() }, "admin", 201);
  assert.equal(preview.tasks.length, 4);
  assert.deepEqual(preview.tasks.slice(0, 2).map((t: any) => t.rowId), mainRecord.record.values.lines.map((r: any) => r._rowId));
  assert.equal(preview.tasks[3].dependsOn.length, 3);
  assert.equal(preview.tasks[2].recordId, auxiliaryRecord.record.id);
  await h.request(`${path()}/preview`, "POST", { bindings: { business: auxiliaryRecord.record.id, support: mainRecord.record.id } }, "admin", 409);
  const candidates = await h.request(`${path()}/records?bindingId=business`); assert.ok(candidates.some((r: any) => r.id === mainRecord.record.id));
  await h.request(`${path()}/preview`, "POST", { bindings: bindings() }, "editor", 403);
});
test("start checks preview revisions and idempotently persists the pinned template", async () => {
  const preview = await h.request(`${path()}/preview`, "POST", { bindings: bindings() }, "admin", 201);
  auxiliaryRecord = await h.request(`/records/${auxiliaryRecord.record.id}`, "PATCH", { requestId: randomUUID(), changes: [{ fieldId: "state", value: "核对中", expectedRevision: 1 }] });
  await h.request(`${path()}/start`, "POST", { ...preview, requestId: randomUUID() }, "admin", 409);
  const current = await h.request(`${path()}/preview`, "POST", { bindings: bindings() }, "admin", 201), body = { ...current, requestId: randomUUID() };
  processView = await h.request(`${path()}/start`, "POST", body, "admin", 201);
  const again = await h.request(`${path()}/start`, "POST", body, "admin", 201);
  assert.equal(processView.events[0].action, "started"); assert.equal(again.id, processView.id); assert.equal(processView.templateVersion, 1); assert.equal(processView.title, "明细办理与资料核对");
  assert.deepEqual(processView.summary, { total: 4, completed: 0, ready: 3, waiting: 1, blocked: 0 });
  assert.equal((await h.db.query("SELECT count(*)::int AS n FROM tasks WHERE process_id=$1", [processView.id])).rows[0].n, 4);
});
test("task data returns only assigned row and authorized columns, with server-enforced write scope", async () => {
  const own = await h.request(`/processes/${processView.id}`, "GET", undefined, "editor"); assert.equal(own.tasks.length, 2);
  const task = own.tasks[0], data = await h.request(`${taskPath(task)}/record`, "GET", undefined, "editor");
  assert.equal(data.record.values.lines.length, 1); assert.equal(data.record.values.lines[0]._rowId, task.rowId);
  assert.equal(data.record.values.private, undefined); assert.equal(data.record.values.decision, undefined);
  assert.ok(!Object.keys(data.record.cellRevisions).some(key => key.includes(own.tasks[1].rowId)));
  assert.deepEqual(data.rowActions.lines, { add: false, remove: false, insert: false, editExisting: true });
  await h.request(`${taskPath(task)}/record`, "GET", undefined, "reviewer", 403);
  for (const change of [ { fieldId: "name", value: "越权", expectedRevision: 1 }, { subformId: "lines", rowId: own.tasks[1].rowId, fieldId: "quantity", value: 8, expectedRevision: 1 } ]) {
    await h.request(`${taskPath(task)}/record`, "PATCH", { requestId: randomUUID(), changes: [change] }, "editor", 403);
  }
  await h.request(`${taskPath(task)}/record`, "PATCH", { requestId: randomUUID(), rows: [{ action: "add", subformId: "lines", expectedRevision: 1, values: { item: "C", quantity: 2, outcome: "" } }] }, "editor", 403);
});
test("partial task save preserves other rows; required fields gate completion; retries do not duplicate events", async () => {
  const task = processView.tasks[0];
  const body = { requestId: randomUUID(), changes: [{ subformId: "lines", rowId: task.rowId, fieldId: "quantity", value: 5, expectedRevision: 1 }] };
  const [first, repeated] = await Promise.all([h.request(`${taskPath(task)}/record`, "PATCH", body, "editor"), h.request(`${taskPath(task)}/record`, "PATCH", body, "editor")]);
  assert.equal(first.record.revision, repeated.record.revision);
  assert.equal((await h.db.query("SELECT count(*)::int AS n FROM process_events WHERE task_id=$1 AND action='record-saved'", [task.id])).rows[0].n, 1);
  await h.request(`${taskPath(task)}/complete`, "POST", {}, "editor", 400);
  await h.request(`${taskPath(task)}/record`, "PATCH", { requestId: randomUUID(), changes: [{ subformId: "lines", rowId: task.rowId, fieldId: "outcome", value: "已处理", expectedRevision: 1 }] }, "editor");
  await h.request(`${taskPath(task)}/complete`, "POST", {}, "editor", 201);
  await h.request(`${taskPath(task)}/complete`, "POST", {}, "editor", 201);
  const retry = await h.request(`${taskPath(task)}/record`, "PATCH", body, "editor"); assert.equal(retry.task.writable, false);
  const data = await h.request(`/records/${mainRecord.record.id}`); assert.equal(data.record.values.lines[1].quantity, 2); assert.equal(data.record.values.lines[1].outcome, "");
  await h.request(`${taskPath(task)}/record`, "PATCH", { requestId: randomUUID(), changes: [{ subformId: "lines", rowId: task.rowId, fieldId: "quantity", value: 6, expectedRevision: 2 }] }, "editor", 409);
});
test("references prevent row deletion and waiting tasks are read-only", async () => {
  const row = (await h.request(`/records/${mainRecord.record.id}`)).record;
  const expectedCells = Object.fromEntries(Object.entries(row.cellRevisions).filter(([key]) => key.includes(processView.tasks[0].rowId)));
  await h.request(`/records/${row.id}`, "PATCH", { requestId: randomUUID(), rows: [{ action: "remove", subformId: "lines", rowId: processView.tasks[0].rowId, expectedRevision: row.rowRevisions.lines, expectedCells }] }, "admin", 409);
  const finish = processView.tasks[3], data = await h.request(`${taskPath(finish)}/record`, "GET", undefined, "reviewer");
  assert.equal(data.access.edit, false); assert.equal(data.task.writable, false);
  await h.request(`${taskPath(finish)}/record`, "PATCH", { requestId: randomUUID(), changes: [{ fieldId: "decision", value: "提前完成", expectedRevision: 1 }] }, "reviewer", 409);
});
test("permission loss blocks pending task and current authorization recovery unblocks it", async () => {
  await h.permissionGroup(
    main.id,
    grant(editor, { ...editorFields, outcome: "hidden" }),
  );
  let result = await h.request(`/processes/${processView.id}`); assert.equal(result.tasks[1].status, "blocked"); assert.match(result.tasks[1].reason, /无法查看/);
  await h.request(`${taskPath(result.tasks[1])}/record`, "GET", undefined, "editor", 403);
  await h.permissionGroup(main.id, grant(editor, editorFields));
  result = await h.request(`/processes/${processView.id}`); assert.equal(result.tasks[1].status, "ready");
  assert.ok(result.events.some((e: any) => e.action === "blocked"));
});
test("parallel work joins before a cross-record condition, and background worker resumes after restart", async () => {
  const second = processView.tasks[1], check = processView.tasks[2], finish = processView.tasks[3];
  await h.request(`${taskPath(second)}/record`, "PATCH", { requestId: randomUUID(), changes: [{ subformId: "lines", rowId: second.rowId, fieldId: "outcome", value: "已处理", expectedRevision: 1 }] }, "editor");
  await h.request(`${taskPath(second)}/complete`, "POST", {}, "editor", 201);
  await h.request(`${taskPath(check)}/complete`, "POST", {}, "reviewer", 201);
  let view = await h.request(`/processes/${processView.id}`); assert.equal(view.tasks[3].status, "waiting"); assert.equal(view.tasks[3].reason, "等待业务条件满足");
  await h.restart();
  await h.request(`/records/${auxiliaryRecord.record.id}`, "PATCH", { requestId: randomUUID(), changes: [{ fieldId: "state", value: "可确认", expectedRevision: 2 }] });
  // Observe persisted state without calling GET /processes (which also reconciles).
  await waitFor(async () => (await h.db.query("SELECT status FROM tasks WHERE id=$1", [finish.id])).rows[0].status === "ready");
  assert.equal((await h.db.query("SELECT count(*)::int AS n FROM tasks WHERE process_id=$1", [processView.id])).rows[0].n, 4);
  await h.request(`${taskPath(finish)}/complete`, "POST", {}, "reviewer", 400);
  await h.request(`${taskPath(finish)}/record`, "PATCH", { requestId: randomUUID(), changes: [{ fieldId: "decision", value: "确认完成", expectedRevision: 1 }] }, "reviewer");
  view = await h.request(`${taskPath(finish)}/complete`, "POST", {}, "reviewer", 201);
  assert.equal(view.status, "completed"); assert.equal(view.summary.completed, 4);
  assert.equal((await h.db.query("SELECT count(*)::int AS n FROM process_events WHERE process_id=$1 AND action='completed'", [view.id])).rows[0].n, 4);
});
test("a second configuration handles same-row waits independently and never grants assignment-based access", async () => {
  const config = spec();
  config.title = "逐项核验";
  config.bindings = [config.bindings[0]!];
  config.tasks = [config.tasks[0]!];
  config.startTaskIds = ["lines"];
  config.endTaskIds = ["lines"];
  config.tasks[0]!.waitFor = { recordBinding: "business", subformId: "lines", fieldId: "quantity", equals: 5 };
  const template = await publish(config);
  const preview = await h.request(`${path(template)}/preview`, "POST", { bindings: { business: mainRecord.record.id } }, "admin", 201);
  const result = await h.request(`${path(template)}/start`, "POST", { ...preview, requestId: randomUUID() }, "admin", 201);
  secondaryProcess = result; assert.deepEqual(result.tasks.map((t: any) => t.status), ["ready", "waiting"]);
  await h.permissionGroup(main.id, {
    ...grant(editor, editorFields),
    enabled: false,
  });
  await h.request(`${path(template)}/preview`, "POST", { bindings: { business: mainRecord.record.id } }, "admin", 403);
  await h.permissionGroup(main.id, grant(editor, editorFields));
});
test("a transient background reconciliation failure is persisted and the next successful check clears it", async () => {
  await h.db.query("CREATE FUNCTION test_process_refresh_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected refresh failure'; END $$");
  await h.db.query("CREATE TRIGGER test_process_refresh_failure BEFORE UPDATE OF status ON processes FOR EACH ROW EXECUTE FUNCTION test_process_refresh_failure()");
  try {
    await waitFor(async () => !!(await h.db.query("SELECT refresh_error FROM processes WHERE id=$1", [secondaryProcess.id])).rows[0].refresh_error);
  } finally { await h.db.query("DROP TRIGGER test_process_refresh_failure ON processes"); }
  await waitFor(async () => !(await h.db.query("SELECT refresh_error FROM processes WHERE id=$1", [secondaryProcess.id])).rows[0].refresh_error);
  assert.equal((await h.db.query("SELECT count(*)::int AS n FROM tasks WHERE process_id=$1", [secondaryProcess.id])).rows[0].n, 2);
});
test("a task creation failure rolls back the process and idempotency receipt, permitting a safe retry", async () => {
  const preview = await h.request(`${path()}/preview`, "POST", { bindings: bindings() }, "admin", 201), requestId = randomUUID();
  await h.db.query("CREATE FUNCTION test_task_create_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.task_key='task_1_2' THEN RAISE EXCEPTION 'injected task creation failure'; END IF; RETURN NEW; END $$");
  await h.db.query("CREATE TRIGGER test_task_create_failure BEFORE INSERT ON tasks FOR EACH ROW EXECUTE FUNCTION test_task_create_failure()");
  try { await h.request(`${path()}/start`, "POST", { ...preview, requestId }, "admin", 500); }
  finally { await h.db.query("DROP TRIGGER test_task_create_failure ON tasks"); }
  assert.equal((await h.db.query("SELECT count(*)::int AS n FROM processes WHERE request_id=$1", [requestId])).rows[0].n, 0);
  assert.equal((await h.db.query("SELECT count(*)::int AS n FROM commands WHERE request_id=$1", [requestId])).rows[0].n, 0);
  const result = await h.request(`${path()}/start`, "POST", { ...preview, requestId }, "admin", 201); assert.equal(result.tasks.length, 4);
});
test("runtime task order follows the configured node order beyond nine nodes", async () => {
  const source = spec(), first = source.tasks[0]!;
  source.bindings = [source.bindings[0]!];
  source.tasks = Array.from({ length: 12 }, (_, index) => ({ ...first, id: `node_${index + 1}`, title: `步骤 ${index + 1}`, subformId: undefined, requiredFields: [], dependsOn: [] }));
  source.startTaskIds = source.tasks.map((task) => task.id);
  source.endTaskIds = source.tasks.map((task) => task.id);
  const template = await publish(source), bindings = { business: mainRecord.record.id };
  const preview = await h.request(`${path(template)}/preview`, "POST", { bindings }, "admin", 201);
  const process = await h.request(`${path(template)}/start`, "POST", { ...preview, requestId: randomUUID() }, "admin", 201);
  assert.deepEqual(process.tasks.map((task: any) => task.title), source.tasks.map(task => task.title));
});
