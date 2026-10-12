import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { harness, field, schema } from "./helpers";
const h = harness(); let admin: string, editor: string;
const organization = { scope: { mode: "all", departmentIds: [], employeeIds: [], roleIds: [], fieldId: "", includeChildren: true }, defaultMode: "none", defaultIds: [] };
const member = (id: string, type = "member") => field(id, type, { organization });
const source = () => ({ namespace: randomUUID(), applicationId: "historical-fixture", applicationName: "历史归属验收", fingerprint: "a".repeat(64), identities: [{ kind: "member", sourceId: "past-person", name: "原经办人", active: false, found: true }, { kind: "member", sourceId: "hidden-person", name: "不可见原人员", active: false, found: true }, { kind: "department", sourceId: "past-department", name: "原业务部门", active: false, found: true }, { kind: "role", sourceId: "past-role", name: "原审核角色", active: false, found: true }], counts: { forms: 1, versions: 1, records: 1, rows: 1, issues: 0 } });
async function batch() {
  let value = await h.request("/migration-batches", "POST", { requestId: randomUUID(), source: source() }, "admin", 201);
  value = await h.request(`/migration-batches/${value.id}`, "PUT", { requestId: randomUUID(), expectedRevision: value.revision, sourceFingerprint: value.source.fingerprint, choices: value.choices.map((item: any) => ({ ...item, mode: "historical" })) });
  return value;
}
async function confirmation(value: any) {
  const review = await h.request(`/migration-batches/${value.id}/review`, "POST", { expectedRevision: value.revision, sourceFingerprint: value.source.fingerprint }, "admin", 201);
  return { requestId: randomUUID(), expectedRevision: value.revision, sourceFingerprint: value.source.fingerprint, token: review.token };
}
async function confirmed() { const value = await batch(); return h.request(`/migration-batches/${value.id}/confirm-identities`, "POST", await confirmation(value), "admin", 201); }
const target = (value: any, id = "past-person") => value.choices.find((item: any) => item.sourceId === id).targetId;
async function fixture() {
  const identity = await confirmed(), definition = await h.definition("原身份记录", schema(field("note"), member("owner"), member("secret"), member("department", "department"), field("lines", "subform", { children: [member("handler")] })));
  const record = await h.record(definition.id, { note: "历史值", lines: [{}] });
  const values = { ...record.record.values, owner: target(identity), secret: target(identity, "hidden-person"), department: target(identity, "past-department"), lines: record.record.values.lines.map((row: any) => ({ ...row, handler: target(identity) })) };
  // Controlled database fixture exercises runtime behavior; this is not an application-import endpoint.
  await h.db.query("UPDATE records SET values=$2,created_by=$3 WHERE id=$1", [record.record.id, values, target(identity)]);
  return { identity, definition, record: record.record, values, page: (await h.request(`/pages?definitionId=${definition.id}`))[0] };
}
before(async () => { await h.start(); const users = await h.request("/users"); admin = users.find((u: any) => u.username === "admin").id; editor = users.find((u: any) => u.username === "editor").id; });
after(() => h.close());

test("confirmation retains immutable historical identities without creating users, grants, tasks or records", async () => {
  const b = await batch(), counts = async () => (await h.db.query("SELECT (SELECT count(*) FROM users) AS users,(SELECT count(*) FROM records) AS records,(SELECT count(*) FROM grants) AS grants,(SELECT count(*) FROM tasks) AS tasks")).rows[0], before = await counts();
  assert.equal((await h.db.query("SELECT 1 FROM historical_identities WHERE source_namespace=$1", [b.source.namespace])).rowCount, 0);
  const body = await confirmation(b), saved = await h.request(`/migration-batches/${b.id}/confirm-identities`, "POST", body, "admin", 201);
  const rows = (await h.db.query("SELECT * FROM historical_identities WHERE source_namespace=$1", [b.source.namespace])).rows;
  assert.equal(rows.length, 4); assert.equal((await h.db.query("SELECT 1 FROM record_principals WHERE historical_id=ANY($1::uuid[])", [rows.map(row => row.id)])).rowCount, 2);
  assert.deepEqual(await counts(), before);
  await h.request(`/migration-batches/${b.id}/confirm-identities`, "POST", body, "admin", 201);
  await h.request(`/migration-batches/${b.id}/reopen`, "POST", { requestId: randomUUID(), expectedRevision: saved.revision }, "admin", 201);
  assert.deepEqual((await h.db.query("SELECT * FROM historical_identities WHERE source_namespace=$1", [b.source.namespace])).rows, rows);
  await assert.rejects(h.db.query("UPDATE historical_identities SET name='改名' WHERE id=$1", [target(b)]), /immutable/i);
  await assert.rejects(h.db.query("DELETE FROM record_principals WHERE id=$1", [target(b)]), /immutable/i);
});

test("historical creators remain distinct from the operator across reads, edits, task detail and restart", async () => {
  const f = await fixture();
  let result = await h.request(`/pages/${f.page.id}/records/${f.record.id}`);
  assert.equal(result.record.createdBy, target(f.identity)); assert.notEqual(result.record.createdBy, admin);
  assert.deepEqual(result.creator, { id: target(f.identity), kind: "member", name: "原经办人", active: false, historical: true });
  assert.equal(result.identities.find((i: any) => i.id === target(f.identity, "past-department")).name, "原业务部门");
  const changed = await h.request(`/records/${f.record.id}`, "PATCH", { requestId: randomUUID(), changes: [{ fieldId: "note", expectedRevision: 1, value: "当前人员补充" }] });
  assert.equal(changed.record.values.owner, target(f.identity)); assert.equal(changed.record.createdBy, target(f.identity));
  assert.equal((await h.db.query("SELECT actor_id FROM record_events WHERE record_id=$1 ORDER BY revision DESC LIMIT 1", [f.record.id])).rows[0].actor_id, admin);
  const process = await h.request("/processes", "POST", { requestId: randomUUID(), bindings: { record: f.record.id }, spec: { title: "处理旧记录", tasks: [{ id: "check", title: "核对", assigneeId: admin, recordBinding: "record", dependsOn: [] }] } }, "admin", 201);
  const task = await h.request(`/processes/${process.id}/tasks/${process.tasks[0].id}/record`);
  assert.equal(task.creator.historical, true); assert.equal(task.creator.id, target(f.identity));
  await h.restart(); result = await h.request(`/records/${f.record.id}`); assert.equal(result.creator.name, "原经办人"); assert.equal(result.record.values.note, "当前人员补充");
});

test("historical catalog is excluded from current candidates, authentication, authorization and assignments", async () => {
  const f = await fixture(), past = target(f.identity);
  const organization = await h.request("/organization"); assert.equal(organization.users.some((u: any) => u.id === past), false);
  assert.equal(organization.spec.departments.some((d: any) => d.id === target(f.identity, "past-department")), false);
  const options = await h.request(`/pages/${f.page.id}/organization-options`, "POST", { pageVersion: 1, recordId: f.record.id, fieldId: "owner" }, "admin", 201);
  assert.equal(options.options.some((o: any) => o.id === past), false);
  await assert.rejects(h.db.query("INSERT INTO sessions VALUES($1,$2,now()+interval '1 hour')", [randomUUID(), past]), /foreign key/i);
  await h.request(`/definitions/${f.definition.id}/grants`, "PUT", { userId: past, read: true, create: true, edit: true, scope: "all", fields: { note: "edit" } }, "admin", 400);
  await h.request(`/definitions/${f.definition.id}/subject-grants`, "PUT", { subject: { kind: "role", id: target(f.identity, "past-role") }, expectedRevision: 0, read: true, create: true, edit: true, scope: "all", fields: { note: "edit" } }, "admin", 400);
  await h.request(`/pages/${f.page.id}/records`, "POST", { requestId: randomUUID(), pageVersion: 1, values: { owner: past } }, "admin", 400);
  await h.request(`/records/${f.record.id}`, "PATCH", { requestId: randomUUID(), rows: [{ action: "add", subformId: "lines", expectedRevision: 1, values: { handler: past } }] }, "admin", 400);
  const orgChange = structuredClone(organization.spec); orgChange.assignments.push({ userId: past, departmentIds: [], primaryDepartmentId: null });
  await h.request("/organization", "PUT", { expectedRevision: organization.revision, spec: orgChange }, "admin", 400);
  const response = await h.request("/processes", "POST", { requestId: randomUUID(), bindings: { record: f.record.id }, spec: { title: "禁止历史待办", tasks: [{ id: "check", title: "核对", assigneeId: past, recordBinding: "record", dependsOn: [] }] } }, "admin", 400);
  assert.ok(response.message);
});

test("record scopes and hidden fields cannot leak archived names or treat the importer as creator", async () => {
  const f = await fixture(), grant = { userId: editor, read: true, create: false, edit: false, scope: "self", fields: { note: "read", owner: "hidden", secret: "hidden", department: "hidden", lines: "hidden", handler: "hidden" } };
  await h.grant(f.definition.id, grant);
  assert.deepEqual(await h.request(`/definitions/${f.definition.id}/records`, "GET", undefined, "editor"), []);
  await h.request(`/records/${f.record.id}`, "GET", undefined, "editor", 403);
  await h.grant(f.definition.id, { ...grant, scope: "all", fields: { ...grant.fields, owner: "read" } });
  const visible = await h.request(`/records/${f.record.id}`, "GET", undefined, "editor");
  assert.equal(visible.identities.length, 1); assert.equal(visible.identities[0].historical, true);
  assert.equal(JSON.stringify(visible).includes("不可见原人员"), false); assert.equal(JSON.stringify(visible).includes("原业务部门"), false);
  assert.equal(visible.creator.id, target(f.identity));
});

test("wrong-kind and foreign-workspace creators fail; archived names never cross workspace boundaries", async () => {
  const f = await fixture();
  await assert.rejects(h.db.query("UPDATE records SET created_by=$2 WHERE id=$1", [f.record.id, target(f.identity, "past-department")]), /foreign key/i);
  await assert.rejects(h.db.query("UPDATE records SET workspace_id='foreign' WHERE id=$1", [f.record.id]), /foreign key/i);
  const foreign = randomUUID(), namespace = randomUUID(), foreignBatch = randomUUID();
  await h.db.query("INSERT INTO migration_batches(id,workspace_id,source_namespace,source_application_id,source,created_by) VALUES($1,'foreign',$2,'foreign',$3,$4)", [foreignBatch, namespace, {}, admin]);
  await h.db.query("INSERT INTO migration_identity_keys VALUES('foreign',$1,'member','foreign',$2)", [namespace, foreign]);
  await h.db.query("INSERT INTO historical_identities(id,workspace_id,source_namespace,kind,source_id,name,first_batch_id) VALUES($1,'foreign',$2,'member','foreign','外部不可见姓名',$3)", [foreign, namespace, foreignBatch]);
  await h.db.query("UPDATE records SET values=jsonb_set(values,'{owner}',to_jsonb($2::text)) WHERE id=$1", [f.record.id, foreign]);
  assert.equal(JSON.stringify(await h.request(`/records/${f.record.id}`)).includes("外部不可见姓名"), false);
  await assert.rejects(h.db.query("UPDATE records SET created_by=$2 WHERE id=$1", [f.record.id, foreign]), /foreign key/i);
});

test("confirmation audit failure rolls back both historical names and creator principals", async () => {
  const b = await batch(), body = await confirmation(b);
  await h.db.query("CREATE FUNCTION reject_history_confirmation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='confirm_identities' THEN RAISE EXCEPTION 'confirmation fault'; END IF; RETURN NEW; END $$");
  await h.db.query("CREATE TRIGGER reject_history_confirmation BEFORE INSERT ON migration_batch_events FOR EACH ROW EXECUTE FUNCTION reject_history_confirmation()");
  try { await h.request(`/migration-batches/${b.id}/confirm-identities`, "POST", body, "admin", 500); } finally { await h.db.query("DROP TRIGGER reject_history_confirmation ON migration_batch_events"); }
  assert.equal((await h.db.query("SELECT 1 FROM historical_identities WHERE source_namespace=$1", [b.source.namespace])).rowCount, 0);
  assert.equal((await h.db.query("SELECT 1 FROM record_principals WHERE id=$1", [target(b)])).rowCount, 0);
  assert.equal((await h.request(`/migration-batches/${b.id}`)).state, "draft");
  await h.request(`/migration-batches/${b.id}/confirm-identities`, "POST", body, "admin", 201);
  assert.equal((await h.db.query("SELECT 1 FROM record_principals WHERE id=$1", [target(b)])).rowCount, 1);
});


test("upgrade backfills earlier confirmed historical identities and preserves existing creator IDs", async () => {
  const client = await h.db.pool.connect(), upgradeSchema = `platform_history_${randomUUID().replaceAll('-', '')}`;
  const account = randomUUID(), namespace = randomUUID(), b = randomUUID(), past = randomUUID(), department = randomUUID();
  const app = randomUUID(), definition = randomUUID(), record = randomUUID(), directory = resolve(__dirname, '../../migrations');
  try {
    await client.query(`CREATE SCHEMA "${upgradeSchema}"`); await client.query(`SET search_path="${upgradeSchema}"`);
    for (const name of (await readdir(directory)).filter(name => /^\d{3}-/.test(name) && name < '014-').sort()) await client.query(await readFile(resolve(directory, name), 'utf8'));
    await client.query("INSERT INTO users(id,workspace_id,username,name,role,password_hash) VALUES($1,'local','legacy','原账号','admin','test-only')", [account]);
    await client.query("INSERT INTO applications(id,workspace_id,title) VALUES($1,'local','原应用')", [app]);
    const form = schema(field('note'));
    await client.query("INSERT INTO definitions(id,workspace_id,title,draft,model_draft,application_id,latest_version) VALUES($1,'local','原表单',$2,$3,$4,1)", [definition, form, {version:1,fields:[]}, app]);
    await client.query("INSERT INTO definition_versions(definition_id,version,title,schema) VALUES($1,1,'原表单',$2)", [definition, form]);
    await client.query("INSERT INTO records(id,workspace_id,definition_id,definition_version,values,cell_revisions,created_by) VALUES($1,'local',$2,1,$3,$4,$5)", [record, definition, {note:'原值'}, {note:1}, account]);
    await client.query("INSERT INTO migration_identity_keys VALUES('local',$1,'member','past',$2),('local',$1,'department','department',$3)", [namespace,past,department]);
    await client.query("INSERT INTO migration_batches(id,workspace_id,source_namespace,source_application_id,source,choices,state,created_by,confirmed_at) VALUES($1,'local',$2,'legacy',$3,$4,'identities_confirmed',$5,now())", [b, namespace, {identities:[{kind:'member',sourceId:'past',name:'旧版已确认人员'},{kind:'department',sourceId:'department',name:'旧版已确认部门'}]}, JSON.stringify([{kind:'member',sourceId:'past',mode:'historical',targetId:past},{kind:'department',sourceId:'department',mode:'historical',targetId:department}]), account]);
    await client.query(await readFile(resolve(directory,'014-historical-identities.sql'),'utf8'));
    assert.equal((await client.query('SELECT count(*) FROM historical_identities')).rows[0].count,'2');
    assert.equal((await client.query('SELECT count(*) FROM record_principals')).rows[0].count,'2');
    assert.equal((await client.query('SELECT created_by FROM records WHERE id=$1',[record])).rows[0].created_by,account);
    assert.equal((await client.query('SELECT count(*) FROM users')).rows[0].count,'1');
    await client.query('UPDATE records SET created_by=$2 WHERE id=$1',[record,past]);
    assert.equal((await client.query('SELECT created_by FROM records WHERE id=$1',[record])).rows[0].created_by,past);
  } finally {
    await client.query('RESET search_path');
    if (!/^platform_history_[a-f0-9]+$/.test(upgradeSchema)) throw new Error('Unsafe cleanup');
    await client.query(`DROP SCHEMA "${upgradeSchema}" CASCADE`); client.release();
  }
});
