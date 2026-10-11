import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type {
  MigrationBatch,
  MigrationOrganizationSource,
  MigrationOrganizationReview,
} from "@platform/contracts";
import { harness, field, schema } from "./helpers";
const h = harness();
let editor: any;
before(async () => {
  await h.start();
  editor = (await h.request("/users")).find(
    (u: any) => u.username === "editor",
  );
});
after(() => h.close());
async function setup() {
  const current = await h.request("/organization"),
    root = randomUUID(),
    child = randomUUID(),
    group = randomUUID(),
    role = randomUUID();
  const spec = structuredClone(current.spec);
  spec.departments.push(
    {
      id: root,
      name: `根${root.slice(0, 6)}`,
      parentId: null,
      archived: false,
      managerIds: [],
    },
    {
      id: child,
      name: `子${child.slice(0, 6)}`,
      parentId: null,
      archived: false,
      managerIds: [],
    },
  );
  spec.roleGroups.push({ id: group, name: `组${group.slice(0, 6)}` });
  spec.roles.push({
    id: role,
    groupId: group,
    name: `角色${role.slice(0, 6)}`,
    description: "保留目标说明",
    memberIds: [],
    departmentIds: [],
    includeChildren: false,
    archived: false,
  });
  await h.request("/organization", "PUT", {
    expectedRevision: current.revision,
    spec,
  });
  let batch: MigrationBatch = await h.request(
    "/migration-batches",
    "POST",
    {
      requestId: randomUUID(),
      source: {
        namespace: randomUUID(),
        applicationId: "old-app",
        applicationName: "旧组织测试",
        fingerprint: "b".repeat(64),
        counts: { forms: 0, versions: 0, records: 0, rows: 0, issues: 0 },
        identities: [
          {
            kind: "member",
            sourceId: "member",
            name: "原成员",
            found: true,
            active: true,
          },
          {
            kind: "member",
            sourceId: "history",
            name: "已离职",
            found: true,
            active: false,
          },
          {
            kind: "department",
            sourceId: "root",
            name: "原根部门",
            found: true,
            active: true,
          },
          {
            kind: "department",
            sourceId: "child",
            name: "原子部门",
            found: true,
            active: true,
          },
          {
            kind: "role",
            sourceId: "role",
            name: "原角色",
            found: true,
            active: true,
          },
        ],
      },
    },
    "admin",
    201,
  );
  const targets: Record<string, string> = {
    member: editor.id,
    root,
    child,
    role,
  };
  batch = await h.request(`/migration-batches/${batch.id}`, "PUT", {
    requestId: randomUUID(),
    expectedRevision: batch.revision,
    sourceFingerprint: batch.source.fingerprint,
    choices: batch.choices.map((item) => ({
      ...item,
      mode: item.sourceId === "history" ? "historical" : "existing",
      targetId: targets[item.sourceId],
    })),
  });
  const review = await h.request(
    `/migration-batches/${batch.id}/review`,
    "POST",
    {
      expectedRevision: batch.revision,
      sourceFingerprint: batch.source.fingerprint,
    },
    "admin",
    201,
  );
  batch = await h.request(
    `/migration-batches/${batch.id}/confirm-identities`,
    "POST",
    {
      requestId: randomUUID(),
      expectedRevision: batch.revision,
      sourceFingerprint: batch.source.fingerprint,
      token: review.token,
    },
    "admin",
    201,
  );
  const source: MigrationOrganizationSource = {
    fingerprint: batch.source.fingerprint,
    departments: [
      { id: "root", parentId: null, managerIds: ["member"] },
      { id: "child", parentId: "root", managerIds: [] },
    ],
    roles: [
      {
        id: "role",
        memberIds: ["member"],
        departmentIds: ["child"],
        includeChildren: true,
      },
    ],
    assignments: [
      {
        userId: "member",
        departmentIds: ["child"],
        primaryDepartmentId: "child",
      },
      { userId: "history", departmentIds: [], primaryDepartmentId: null },
    ],
  };
  const inspect = (value = source) =>
    h.request(
      `/migration-batches/${batch.id}/organization-preview`,
      "POST",
      { expectedRevision: batch.revision, source: value },
      "admin",
      201,
    ) as Promise<MigrationOrganizationReview>;
  const command = (review: MigrationOrganizationReview, value = source) => ({
    requestId: randomUUID(),
    expectedRevision: batch.revision,
    source: value,
    token: review.token,
  });
  const apply = (body: unknown, expected = 201) =>
    h.request(
      `/migration-batches/${batch.id}/organization-import`,
      "POST",
      body,
      "admin",
      expected,
    );
  return { batch, source, inspect, command, apply, root, child, group, role };
}
test("explicit import updates hierarchy and membership atomically, preserves names/groups and makes existing role grants effective", async () => {
  const x = await setup(),
    before = await h.request("/organization");
  const def = await h.definition(
    "角色授权验证",
    schema(field("name"), field("secret")),
  );
  await h.request(`/definitions/${def.id}/subject-grants`, "PUT", {
    expectedRevision: 0,
    subject: { kind: "role", id: x.role },
    read: true,
    edit: true,
    create: false,
    scope: "all",
    fields: { name: "edit", secret: "hidden" },
  });
  const record = await h.record(def.id, { name: "保持记录", secret: "不可读" });
  await h.request(
    `/records/${record.record.id}`,
    "GET",
    undefined,
    "editor",
    403,
  );
  const review = await x.inspect();
  assert.deepEqual(review.blockers, []);
  assert.equal(review.historical, 1);
  assert.equal(review.changes.length, 4);
  assert.deepEqual(await h.request("/organization"), before);
  const body = x.command(review);
  const result = await x.apply(body);
  const after = await h.request("/organization");
  assert.equal(after.revision, before.revision + 1);
  assert.equal(
    after.spec.departments.find((d: any) => d.id === x.child).parentId,
    x.root,
  );
  assert.deepEqual(
    after.spec.assignments.find((d: any) => d.userId === editor.id)
      .departmentIds,
    [x.child],
  );
  assert.equal(
    after.spec.roles.find((r: any) => r.id === x.role).groupId,
    x.group,
  );
  assert.equal(
    after.spec.roles.find((r: any) => r.id === x.role).description,
    "保留目标说明",
  );
  assert.deepEqual(after.users, before.users);
  const detail = await h.request(
    `/records/${record.record.id}`,
    "GET",
    undefined,
    "editor",
  );
  assert.equal(detail.record.values.name, "保持记录");
  assert.equal(detail.record.values.secret, undefined);
  assert.equal(detail.access.fields.name, "edit");
  const appliedBatch = await h.request(`/migration-batches/${x.batch.id}`);
  const identityReview = await h.request(
    `/migration-batches/${x.batch.id}/review`,
    "POST",
    {
      expectedRevision: appliedBatch.revision,
      sourceFingerprint: appliedBatch.source.fingerprint,
    },
    "admin",
    201,
  );
  assert.equal(identityReview.confirmationCurrent, true);
  const unchanged = await h.request(`/migration-batches/${x.batch.id}/organization-preview`, 'POST', { expectedRevision: appliedBatch.revision, source: x.source }, 'admin', 201);
  assert.deepEqual(unchanged.changes, []);
  await h.request(`/migration-batches/${x.batch.id}/organization-import`, 'POST', { requestId: randomUUID(), expectedRevision: appliedBatch.revision, source: x.source, token: unchanged.token }, 'admin', 400);
  assert.deepEqual(await x.apply(body), result);
  assert.deepEqual(await h.request("/organization"), after);
  const events = (
    await h.db.query(
      "SELECT detail FROM migration_batch_events WHERE batch_id=$1 AND action='import_organization'",
      [x.batch.id],
    )
  ).rows;
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].detail.organizationSource, x.source);
  await assert.rejects(
    h.db.query("DELETE FROM migration_batch_events WHERE batch_id=$1", [
      x.batch.id,
    ]),
    /immutable/i,
  );
  await h.restart();
  assert.deepEqual((await h.request("/organization")).spec, after.spec);
});
test("rejects missing/foreign references, historical identities in active relations, cycles and inactive target differences without writes", async () => {
  const x = await setup(),
    before = await h.request("/organization");
  const missing = structuredClone(x.source);
  missing.departments.pop();
  await h.request(
    `/migration-batches/${x.batch.id}/organization-preview`,
    "POST",
    { expectedRevision: x.batch.revision, source: missing },
    "admin",
    400,
  );
  const foreign = structuredClone(x.source);
  foreign.roles[0]!.memberIds.push(randomUUID());
  assert.ok(
    (await x.inspect(foreign)).blockers.some((s) => s.includes("未包含")),
  );
  const history = structuredClone(x.source);
  history.roles[0]!.memberIds.push("history");
  const invalid = await x.inspect(history);
  assert.ok(invalid.blockers.some((s) => s.includes("未关联当前")));
  await x.apply(x.command(invalid, history), 409);
  const cycle = structuredClone(x.source);
  cycle.departments[0]!.parentId = "child";
  assert.ok((await x.inspect(cycle)).blockers.some((s) => s.includes("循环")));
  assert.deepEqual(await h.request("/organization"), before);
  await h.db.query("UPDATE users SET active=false WHERE id=$1", [editor.id]);
  const disabled = await x.inspect();
  assert.ok(disabled.blockers.some((s) => s.includes("状态不同")));
  await x.apply(x.command(disabled), 409);
  await h.db.query("UPDATE users SET active=true WHERE id=$1", [editor.id]);
});
test("stale source, changed preview payload and concurrent organization edit cannot be applied", async () => {
  const x = await setup(),
    review = await x.inspect();
  await x.apply(
    x.command(review, { ...x.source, fingerprint: "c".repeat(64) }),
    409,
  );
  const changed = structuredClone(x.source);
  changed.roles[0]!.includeChildren = false;
  await x.apply(x.command(review, changed), 409);
  const org = await h.request("/organization");
  await h.request("/organization", "PUT", {
    expectedRevision: org.revision,
    spec: org.spec,
  });
  await x.apply(x.command(review), 409);
  assert.equal((await h.request("/organization")).revision, org.revision + 1);
});
test("admin/workspace boundaries and audit failure roll back organization, batch and command together", async () => {
  const x = await setup(),
    review = await x.inspect(),
    body = x.command(review),
    before = await h.request("/organization");
  await h.request(
    `/migration-batches/${x.batch.id}/organization-preview`,
    "POST",
    { expectedRevision: x.batch.revision, source: x.source },
    "editor",
    403,
  );
  await h.request(
    `/migration-batches/${x.batch.id}/organization-import`,
    "POST",
    body,
    "editor",
    403,
  );
  await h.db.query(
    "ALTER TABLE migration_batch_events ADD CONSTRAINT test_reject_organization CHECK(action <> 'import_organization') NOT VALID",
  );
  try {
    await x.apply(body, 500);
  } finally {
    await h.db.query(
      "ALTER TABLE migration_batch_events DROP CONSTRAINT test_reject_organization",
    );
  }
  assert.deepEqual(await h.request("/organization"), before);
  assert.equal(
    (await h.request(`/migration-batches/${x.batch.id}`)).revision,
    x.batch.revision,
  );
  assert.equal(
    (
      await h.db.query("SELECT 1 FROM commands WHERE request_id=$1", [
        body.requestId,
      ])
    ).rowCount,
    0,
  );
  await x.apply(body);
  await h.db.query(
    "UPDATE migration_batches SET workspace_id='other' WHERE id=$1",
    [x.batch.id],
  );
  await h.request(
    `/migration-batches/${x.batch.id}/organization-preview`,
    "POST",
    { expectedRevision: x.batch.revision, source: x.source },
    "admin",
    404,
  );
});
test("concurrent imports cannot overwrite a newly applied organization", async () => {
  const x = await setup(),
    review = await x.inspect();
  const results = await Promise.all([
    x
      .apply(x.command(review), 201)
      .then(() => "saved")
      .catch((e) => String(e)),
    x
      .apply(x.command(review), 201)
      .then(() => "saved")
      .catch((e) => String(e)),
  ]);
  assert.equal(results.filter((r) => r === "saved").length, 1);
  assert.ok(results.some((r) => r.includes("409")));
});
