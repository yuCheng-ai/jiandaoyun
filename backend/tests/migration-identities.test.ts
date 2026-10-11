import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { MigrationBatch, MigrationIdentitySource, MigrationSourceIdentity } from "@platform/contracts";
import { harness } from "./helpers";
const h = harness(); let admin: any, editor: any;
const identity = (sourceId: string, kind: MigrationSourceIdentity["kind"] = "member") => ({ sourceId, kind, name: "同名人员", found: true, active: true });
const source = (identities = [identity("old-a")], namespace: string = randomUUID(), applicationId: string = randomUUID()): MigrationIdentitySource => ({ namespace, applicationId, applicationName: "旧应用", fingerprint: "a".repeat(64), identities, counts: { forms: 1, versions: 2, records: 4, rows: 3, issues: 1 } });
const create = (s = source()) => h.request("/migration-batches", "POST", { requestId: randomUUID(), source: s }, "admin", 201) as Promise<MigrationBatch>;
const save = (b: MigrationBatch, choices = b.choices.map(item => ({ ...item, mode: "historical" }))) => h.request(`/migration-batches/${b.id}`, "PUT", { requestId: randomUUID(), expectedRevision: b.revision, sourceFingerprint: b.source.fingerprint, choices }) as Promise<MigrationBatch>;
const review = (b: MigrationBatch) => h.request(`/migration-batches/${b.id}/review`, "POST", { expectedRevision: b.revision, sourceFingerprint: b.source.fingerprint }, "admin", 201);
const confirm = async (b: MigrationBatch) => h.request(`/migration-batches/${b.id}/confirm-identities`, "POST", { requestId: randomUUID(), expectedRevision: b.revision, sourceFingerprint: b.source.fingerprint, token: (await review(b)).token }, "admin", 201) as Promise<MigrationBatch>;
before(async () => { await h.start(); const users = await h.request("/users"); admin = users.find((u: any) => u.username === "admin"); editor = users.find((u: any) => u.username === "editor"); });
after(() => h.close());

test("admin-only batches start unresolved, retain metadata only and isolate namespaces/workspaces", async () => {
  const s = source();
  await h.request("/migration-batches", "POST", { requestId: randomUUID(), source: s }, "editor", 403);
  const b = await create({ ...s, credentials: "must-not-retain", records: [{ secret: "must-not-retain" }] } as any);
  assert.deepEqual(b.choices, [{ kind: "member", sourceId: "old-a", mode: "unresolved" }]);
  assert.ok(!JSON.stringify(b).includes("must-not-retain"));
  await h.request(`/migration-batches/${b.id}`, "GET", undefined, "editor", 403);
  assert.equal((await h.request(`/migration-batches?namespace=${randomUUID()}`)).length, 0);
  assert.equal((await h.request(`/migration-batches?namespace=${s.namespace}`)).length, 1);
  await h.db.query("UPDATE migration_batches SET workspace_id='other-workspace' WHERE id=$1", [b.id]);
  await h.request(`/migration-batches/${b.id}`, "GET", undefined, "admin", 404);
  await h.request(`/migration-batches/${b.id}/events`, "GET", undefined, "admin", 404);
  assert.equal((await h.request(`/migration-batches?namespace=${s.namespace}`)).length, 0);
});
test("retry is idempotent, revisions prevent overwrites and audit is immutable", async () => {
  const payload = { requestId: randomUUID(), source: source() };
  const b = await h.request("/migration-batches", "POST", payload, "admin", 201);
  assert.equal((await h.request("/migration-batches", "POST", payload, "admin", 201)).id, b.id);
  await h.request("/migration-batches", "POST", { ...payload, source: { ...payload.source, applicationName: "不同请求" } }, "admin", 409);
  const body = { requestId: randomUUID(), expectedRevision: b.revision, sourceFingerprint: b.source.fingerprint, choices: b.choices.map((item: any) => ({ ...item, mode: "historical", targetId: admin.id })) };
  const saved = await h.request(`/migration-batches/${b.id}`, "PUT", body);
  assert.notEqual(saved.choices[0].targetId, admin.id);
  assert.deepEqual(await h.request(`/migration-batches/${b.id}`, "PUT", body), saved);
  await h.request(`/migration-batches/${b.id}`, "PUT", { ...body, requestId: randomUUID() }, "admin", 409);
  assert.equal((await h.request(`/migration-batches/${b.id}/events`)).length, 2);
  await assert.rejects(h.db.query("DELETE FROM migration_batch_events WHERE batch_id=$1", [b.id]), /immutable|不可|cannot/i);
});
test("unresolved, wrong-kind and duplicate targets cannot be confirmed", async () => {
  let b = await create(source([identity("a"), identity("b"), identity("dept", "department")]));
  assert.equal((await review(b)).counts.unresolved, 3);
  b = await save(b, b.choices.map(item => ({ ...item, mode: "existing", targetId: admin.id })));
  const result = await review(b); assert.ok(result.blockers.some((s: string) => s.includes("同一目标"))); assert.ok(result.blockers.some((s: string) => s.includes("不存在")));
  await h.request(`/migration-batches/${b.id}/confirm-identities`, "POST", { requestId: randomUUID(), expectedRevision: b.revision, sourceFingerprint: b.source.fingerprint, token: result.token }, "admin", 409);
  await h.request(`/migration-batches/${b.id}`, "PUT", { requestId: randomUUID(), expectedRevision: b.revision, sourceFingerprint: b.source.fingerprint, choices: [] }, "admin", 400);
});
test("historical reservations persist across applications and confirmations do not create accounts or grants", async () => {
  const namespace = randomUUID(), beforeOrg = await h.request("/organization");
  const before = (await h.db.query("SELECT (SELECT count(*) FROM definitions) AS definitions,(SELECT count(*) FROM records) AS records,(SELECT count(*) FROM grants) AS grants")).rows[0];
  let a = await save(await create(source([identity("same")], namespace))), b = await save(await create(source([identity("same")], namespace)));
  assert.equal(a.choices[0]!.targetId, b.choices[0]!.targetId);
  a = await confirm(a); b = await confirm(b);
  assert.equal((await review(a)).confirmationCurrent, true); assert.equal((await review(b)).confirmationCurrent, true);
  assert.deepEqual(await h.request("/organization"), beforeOrg);
  assert.deepEqual((await h.db.query("SELECT (SELECT count(*) FROM definitions) AS definitions,(SELECT count(*) FROM records) AS records,(SELECT count(*) FROM grants) AS grants")).rows[0], before);
  await h.restart(); assert.equal((await h.request(`/migration-batches/${a.id}`)).state, "identities_confirmed");
});
test("cross-application conflicts block differing mappings and target reuse; reopening permits correction", async () => {
  const namespace = randomUUID(); let a = await create(source([identity("same")], namespace));
  a = await save(a, [{ ...a.choices[0]!, mode: "existing", targetId: editor.id }]); a = await confirm(a);
  let b = await save(await create(source([identity("same")], namespace)));
  assert.ok((await review(b)).blockers.some((s: string) => s.includes("已确认的对应不同")));
  let c = await create(source([identity("another")], namespace)); c = await save(c, [{ ...c.choices[0]!, mode: "existing", targetId: editor.id }]);
  assert.ok((await review(c)).blockers.some((s: string) => s.includes("另一来源身份")));
  await h.request(`/migration-batches/${a.id}`, "PUT", { requestId: randomUUID(), expectedRevision: a.revision, sourceFingerprint: a.source.fingerprint, choices: a.choices }, "admin", 409);
  a = await h.request(`/migration-batches/${a.id}/reopen`, "POST", { requestId: randomUUID(), expectedRevision: a.revision }, "admin", 201);
  assert.deepEqual((await review(b)).blockers, []); assert.equal(a.state, "draft");
});
test("source refresh keeps stable choices, adds unresolved references and requires new review", async () => {
  let b = await save(await create()); const oldTarget = b.choices[0]!.targetId;
  b = await h.request(`/migration-batches/${b.id}/source`, "POST", { requestId: randomUUID(), expectedRevision: b.revision, source: { ...b.source, fingerprint: "b".repeat(64), identities: [...b.source.identities, identity("new")] } }, "admin", 201);
  assert.equal(b.choices.find(c => c.sourceId === "old-a")!.targetId, oldTarget);
  assert.equal(b.choices.find(c => c.sourceId === "new")!.mode, "unresolved");
  await h.request(`/migration-batches/${b.id}/review`, "POST", { expectedRevision: b.revision, sourceFingerprint: "a".repeat(64) }, "admin", 409);
  await h.request(`/migration-batches/${b.id}/source`, "POST", { requestId: randomUUID(), expectedRevision: b.revision, source: { ...b.source, namespace: randomUUID() } }, "admin", 400);
});
test("organization changes invalidate reviews, and a stopped target is explicit without granting access", async () => {
  let b = await create(); b = await save(b, [{ ...b.choices[0]!, mode: "existing", targetId: editor.id }]); const old = await review(b);
  const org = await h.request("/organization"); await h.request("/organization", "PUT", { expectedRevision: org.revision, spec: org.spec });
  await h.request(`/migration-batches/${b.id}/confirm-identities`, "POST", { requestId: randomUUID(), expectedRevision: b.revision, sourceFingerprint: b.source.fingerprint, token: old.token }, "admin", 409);
  await h.db.query("UPDATE users SET active=false WHERE id=$1", [editor.id]); const next = await review(b);
  assert.equal(next.items[0].targetActive, false); assert.ok(next.items[0].warnings[0].includes("停用"));
  await h.db.query("UPDATE users SET active=true WHERE id=$1", [editor.id]);
});
test("audit failure rolls back batch, reservation and idempotency command together", async () => {
  await h.db.query("CREATE FUNCTION reject_migration_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit failure'; END $$");
  await h.db.query("CREATE TRIGGER reject_migration_audit BEFORE INSERT ON migration_batch_events FOR EACH ROW EXECUTE FUNCTION reject_migration_audit()");
  const body = { requestId: randomUUID(), source: source() };
  try { await h.request("/migration-batches", "POST", body, "admin", 500); } finally { await h.db.query("DROP TRIGGER reject_migration_audit ON migration_batch_events"); }
  assert.equal((await h.db.query("SELECT 1 FROM migration_batches WHERE source_namespace=$1", [body.source.namespace])).rowCount, 0);
  assert.equal((await h.db.query("SELECT 1 FROM migration_identity_keys WHERE source_namespace=$1", [body.source.namespace])).rowCount, 0);
  await h.request("/migration-batches", "POST", body, "admin", 201);
});
test("concurrent conflicting confirmations serialize across application batches", async () => {
  const namespace = randomUUID().toUpperCase(); let a = await create(source([identity("shared")], namespace)), b = await create(source([identity("shared")], namespace));
  a = await save(a, [{ ...a.choices[0]!, mode: "existing", targetId: admin.id.toUpperCase() }]); b = await save(b);
  const [ra, rb] = await Promise.all([review(a), review(b)]); assert.deepEqual(ra.blockers, []); assert.deepEqual(rb.blockers, []);
  const results = await Promise.allSettled([a, b].map((batch, index) => h.request(`/migration-batches/${batch.id}/confirm-identities`, "POST", { requestId: randomUUID(), expectedRevision: batch.revision, sourceFingerprint: batch.source.fingerprint, token: [ra, rb][index].token }, "admin", 201)));
  assert.equal(results.filter(item => item.status === "fulfilled").length, 1);
  const failed = results.find(item => item.status === "rejected") as PromiseRejectedResult; assert.match(String(failed.reason), /409/);
  const batches = await h.request(`/migration-batches?namespace=${namespace}`); assert.equal(batches.filter((item: any) => item.state === "identities_confirmed").length, 1);
});
