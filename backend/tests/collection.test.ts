import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { harness, field, schema } from "./helpers";
const h = harness();
let editor: string, reviewer: string;
before(async () => {
  await h.start();
  const users = await h.request("/users");
  editor = users.find((u: any) => u.username === "editor").id;
  reviewer = users.find((u: any) => u.username === "reviewer").id;
});
after(() => h.close());
const open = {
  enabled: true,
  startsAt: "",
  endsAt: "",
  limit: 0,
  allowRepeat: true,
};
const rulesPath = (id: string) => `/definitions/${id}/collection-rules`;
async function setup() {
  const def = await h.definition(
    "收集规则验收",
    schema(
      field("name", "text", { required: true }),
      field("quantity", "number"),
    ),
  );
  for (const userId of [editor, reviewer])
    await h.request(`/definitions/${def.id}/grants`, "PUT", {
      userId,
      read: true,
      create: true,
      edit: true,
      scope: "self",
      fields: { name: "edit", quantity: "edit" },
    });
  const page = (await h.request(`/pages?definitionId=${def.id}`))[0];
  return { def, page };
}
async function configure(
  id: string,
  delta: Record<string, unknown>,
  expected?: number,
) {
  const saved = await h.request(rulesPath(id));
  return h.request(rulesPath(id), "PUT", {
    expectedRevision: expected ?? saved.revision,
    rules: { ...saved.rules, ...delta },
  });
}
const create = (
  id: string,
  values: unknown = { name: "提交" },
  user = "editor",
  expected: number | number[] = 201,
  state?: "draft",
  requestId = randomUUID(),
) =>
  h.request(
    `/definitions/${id}/records`,
    "POST",
    { requestId, version: 1, values, ...(state ? { state } : {}) },
    user,
    expected,
  );

test("existing objects default to unrestricted collection; only administrators see configuration, totals and audit", async () => {
  const { def, page } = await setup();
  assert.deepEqual(await h.request(rulesPath(def.id)), {
    revision: 0,
    rules: open,
    submittedRecords: 0,
  });
  for (const path of [rulesPath(def.id), `${rulesPath(def.id)}/events`])
    await h.request(path, "GET", undefined, "editor", 403);
  await h.request(
    rulesPath(def.id),
    "PUT",
    { expectedRevision: 0, rules: open },
    "editor",
    403,
  );
  const created = await create(def.id);
  assert.equal(created.record.state, "active");
  for (const path of [
    `/definitions/${def.id}`,
    `/pages/${page.id}/form?version=1`,
  ]) {
    const value = await h.request(path, "GET", undefined, "editor");
    assert.equal(value.collection.accepting, true);
    assert.deepEqual(Object.keys(value.collection).sort(), [
      "accepting",
      "checkedAt",
      "code",
    ]);
  }
  assert.equal((await h.request(rulesPath(def.id))).submittedRecords, 1);
});

test("paused collection permits preserving drafts and processing existing records; rejected submission rolls back fields, events and commands", async () => {
  const { def, page } = await setup();
  const active = await create(def.id);
  await configure(def.id, { enabled: false });
  const denied = await h.request(
    `/pages/${page.id}/records`,
    "POST",
    { requestId: randomUUID(), pageVersion: 1, values: { name: "暂停期间" } },
    "editor",
    409,
  );
  assert.equal(denied.collection.code, "paused");
  await h.request(
    `/records/${active.record.id}`,
    "PATCH",
    {
      requestId: randomUUID(),
      changes: [{ fieldId: "name", expectedRevision: 1, value: "继续处理" }],
    },
    "editor",
  );
  const draft = await create(def.id, {}, "editor", 201, "draft");
  assert.equal(draft.collection.code, "paused");
  assert.equal(draft.record.state, "draft");
  assert.equal(
    (await h.request(`/records/${draft.record.id}`, "GET", undefined, "editor"))
      .collection.code,
    "paused",
  );
  const body = {
    requestId: randomUUID(),
    pageVersion: 1,
    expectedRevision: 1,
    changes: [{ fieldId: "name", expectedRevision: 1, value: "续填后提交" }],
  };
  const response = await h.request(
    `/pages/${page.id}/records/${draft.record.id}/submit`,
    "POST",
    body,
    "editor",
    409,
  );
  assert.equal(response.collection.code, "paused");
  const unchanged = await h.request(
    `/records/${draft.record.id}`,
    "GET",
    undefined,
    "editor",
  );
  assert.equal(unchanged.record.values.name, "");
  assert.equal(unchanged.record.revision, 1);
  assert.equal(
    (
      await h.db.query("SELECT 1 FROM commands WHERE request_id=$1", [
        body.requestId,
      ])
    ).rowCount,
    0,
  );
  assert.equal(
    (
      await h.db.query("SELECT 1 FROM record_events WHERE record_id=$1", [
        draft.record.id,
      ])
    ).rowCount,
    1,
  );
  await configure(def.id, { enabled: true });
  const submitted = await h.request(
    `/pages/${page.id}/records/${draft.record.id}/submit`,
    "POST",
    body,
    "editor",
    201,
  );
  assert.equal(submitted.record.id, draft.record.id);
  assert.equal(submitted.record.values.name, "续填后提交");
});

test("all versions and pages share one atomic quota across concurrent users; drafts never reserve a place", async () => {
  const { def, page } = await setup();
  const original = await h.request(`/pages/${page.id}/draft`);
  const second = await h.request(
    "/pages",
    "POST",
    {
      title: "第二收集入口",
      definitionId: def.id,
      definitionVersion: 1,
      schema: original.schema,
    },
    "admin",
    201,
  );
  await h.request(
    `/pages/${second.id}/publish`,
    "POST",
    { expectedRevision: second.revision },
    "admin",
    201,
  );
  const draft = await h.request(`/definitions/${def.id}`, "PUT", {
    expectedRevision: def.revision,
    title: "收集规则验收新版",
    schema: schema(
      field("name", "text", { required: true }),
      field("quantity", "number"),
    ),
  });
  await h.request(
    `/definitions/${def.id}/publish`,
    "POST",
    { expectedRevision: draft.revision },
    "admin",
    201,
  );
  await create(def.id, {}, "editor", 201, "draft");
  await configure(def.id, { limit: 3 });
  const responses = await Promise.all(
    Array.from({ length: 12 }, (_, i) => {
      const pageId = i % 2 ? page.id : second.id;
      return i % 3 === 0
        ? h.request(
            `/definitions/${def.id}/records`,
            "POST",
            {
              requestId: randomUUID(),
              version: (i % 2) + 1,
              values: { name: `直接入口${i}` },
            },
            i % 2 ? "editor" : "reviewer",
            [201, 409],
          )
        : h.request(
            `/pages/${pageId}/records`,
            "POST",
            {
              requestId: randomUUID(),
              pageVersion: 1,
              values: { name: `页面入口${i}` },
            },
            i % 2 ? "editor" : "reviewer",
            [201, 409],
          );
    }),
  );
  assert.equal(responses.filter((r) => r.record).length, 3);
  assert.equal(
    responses.filter((r) => r.collection?.code === "full").length,
    9,
  );
  const config = await h.request(rulesPath(def.id));
  assert.equal(config.submittedRecords, 3);
  assert.equal(
    (
      await h.db.query(
        "SELECT 1 FROM records WHERE definition_id=$1 AND state='draft'",
        [def.id],
      )
    ).rowCount,
    1,
  );
  const commands = (
    await h.db.query(
      "SELECT count(*)::int AS count FROM commands c JOIN records r ON r.id=c.resource_id WHERE r.definition_id=$1",
      [def.id],
    )
  ).rows[0].count;
  assert.equal(commands, 4); // One draft and three submissions, no failed-command reservations.
});

test("repeat limits use the original filling member, across permission groups, drafts and administrator submission", async () => {
  const { def, page } = await setup();
  await h.request(`/definitions/${def.id}/permission-groups`, "PUT", {
    expectedRevision: 0,
    mode: "groups",
    allowMerged: false,
    groups: ["a", "b"].map((id) => ({
      id,
      name: id,
      enabled: true,
      archived: false,
      subjects: [
        { kind: "member", id: editor },
        { kind: "member", id: reviewer },
      ],
      actions: ["create"],
      scope: "all",
      filters: [],
      fields: { name: "edit" },
    })),
  });
  await configure(def.id, { allowRepeat: false });
  const drafts = await Promise.all(
    ["a", "b"].map((group) =>
      h.request(
        `/pages/${page.id}/records`,
        "POST",
        {
          requestId: randomUUID(),
          pageVersion: 1,
          state: "draft",
          values: { name: group },
        },
        "editor",
        201,
        { "X-Platform-Access-Groups": JSON.stringify({ [def.id]: group }) },
      ),
    ),
  );
  const results = await Promise.all(
    drafts.map((d, i) =>
      h.request(
        `/pages/${page.id}/records/${d.record.id}/submit`,
        "POST",
        { requestId: randomUUID(), pageVersion: 1, expectedRevision: 1 },
        "editor",
        [201, 409],
        {
          "X-Platform-Access-Groups": JSON.stringify({
            [def.id]: i ? "b" : "a",
          }),
        },
      ),
    ),
  );
  assert.equal(results.filter((r) => r.record).length, 1);
  assert.equal(
    results.filter((r) => r.collection?.code === "repeated").length,
    1,
  );
  const pending = drafts.find(
    (d) => !results.some((r) => r.record?.id === d.record.id),
  )!;
  const admin = await h.request(
    `/records/${pending.record.id}/submit`,
    "POST",
    { requestId: randomUUID(), expectedRevision: 1 },
    "admin",
    409,
  );
  assert.equal(admin.collection.code, "repeated");
  assert.equal(
    (await h.request(`/records/${pending.record.id}`)).record.state,
    "draft",
  );
  const other = await h.request(
    `/pages/${page.id}/records`,
    "POST",
    { requestId: randomUUID(), pageVersion: 1, values: { name: "另一填写人" } },
    "reviewer",
    201,
    { "X-Platform-Access-Groups": JSON.stringify({ [def.id]: "a" }) },
  );
  assert.equal(other.record.state, "active");
});

test("success retries still acknowledge the original result after quota is full and collection is paused; failed requests can be retried after reopening", async () => {
  const { def } = await setup();
  await configure(def.id, { limit: 1 });
  const requestId = randomUUID(),
    body = { requestId, version: 1, values: { name: "唯一提交" } };
  const initial = await h.request(
    `/definitions/${def.id}/records`,
    "POST",
    body,
    "editor",
    201,
  );
  await configure(def.id, { enabled: false });
  const retry = await h.request(
    `/definitions/${def.id}/records`,
    "POST",
    body,
    "editor",
    201,
  );
  assert.equal(retry.record.id, initial.record.id);
  await h.request(
    `/definitions/${def.id}/records`,
    "POST",
    { ...body, values: { name: "不同内容" } },
    "editor",
    409,
  );
  const failed = {
    requestId: randomUUID(),
    version: 1,
    values: { name: "暂停后再提交" },
  };
  await h.request(
    `/definitions/${def.id}/records`,
    "POST",
    failed,
    "editor",
    409,
  );
  await configure(def.id, { enabled: true, limit: 2 });
  await h.request(
    `/definitions/${def.id}/records`,
    "POST",
    failed,
    "editor",
    201,
  );
  assert.equal((await h.request(rulesPath(def.id))).submittedRecords, 2);
});

test("collection counts non-archived formal records across versions; existing records cannot be edited to evade repeat checks", async () => {
  const { def } = await setup();
  await configure(def.id, { limit: 1, allowRepeat: false });
  const first = await create(def.id);
  await h.request(
    `/records/${first.record.id}/archive`,
    "POST",
    { requestId: randomUUID(), expectedRevision: first.record.revision },
    "admin",
    201,
  );
  assert.equal((await h.request(rulesPath(def.id))).submittedRecords, 0);
  const next = await create(def.id);
  assert.notEqual(next.record.id, first.record.id);
  await configure(def.id, { limit: 0 });
  const rejected = await create(
    def.id,
    { name: "不能改提交者规避" },
    "editor",
    409,
  );
  assert.equal(rejected.collection.code, "repeated");
});

test("time windows normalize explicit offsets and reject invalid dates, unknown settings, missing flags, inverted ranges and unsafe limits", async () => {
  const { def } = await setup();
  for (const delta of [
    { startsAt: "2026-02-30T00:00:00Z" },
    { startsAt: "2026-10-09T08:00" },
    { startsAt: "2026-10-09T24:00:00Z" },
    { startsAt: "2027-01-01T00:00:00Z", endsAt: "2026-01-01T00:00:00Z" },
    { limit: -1 },
    { limit: 0.1 },
    { limit: Number.MAX_SAFE_INTEGER + 1 },
    { publicEnabled: true },
    { allowRepeat: undefined },
  ])
    await h.request(
      rulesPath(def.id),
      "PUT",
      { expectedRevision: 0, rules: { ...open, ...delta } },
      "admin",
      400,
    );
  assert.equal((await h.request(rulesPath(def.id))).revision, 0);
  const future = new Date(Date.now() + 86400000).toISOString();
  await configure(def.id, { startsAt: future });
  assert.equal(
    (await create(def.id, undefined, "admin", 409)).collection.code,
    "not-started",
  );
  const saved = await configure(def.id, {
    startsAt: "2020-01-01T08:00:00+08:00",
    endsAt: "2020-02-01T08:00:00+08:00",
  });
  assert.equal(saved.rules.startsAt, "2020-01-01T00:00:00.000Z");
  assert.equal(
    (await create(def.id, undefined, "editor", 409)).collection.code,
    "ended",
  );
});

test("deadline is checked against the database clock after waiting for the quota lock", async () => {
  const { def } = await setup();
  const deadline = new Date(Date.now() + 1200).toISOString();
  await configure(def.id, { endsAt: deadline });
  const lock = await h.db.pool.connect();
  await lock.query("BEGIN");
  await lock.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    `collection/${def.id}`,
  ]);
  const pending = create(
    def.id,
    { name: "期限前发起但期限后到达提交" },
    "editor",
    409,
  );
  try {
    let waiting = false;
    for (let i = 0; i < 30; i++) {
      const row = (
        await h.db.query(
          "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory' AND xact_start < $1::timestamptz AND query LIKE '%pg_advisory_xact_lock%') AS waiting",
          [deadline],
        )
      ).rows[0];
      if (row.waiting) {
        waiting = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(
      waiting,
      true,
      "The request must be waiting inside a transaction started before the deadline",
    );
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, Date.parse(deadline) - Date.now() + 30)),
    );
  } finally {
    await lock.query("ROLLBACK");
    lock.release();
  }
  const denied = await pending;
  assert.equal(denied.collection.code, "ended");
  assert.ok(Date.parse(denied.collection.checkedAt) >= Date.parse(deadline));
});

test("concurrent configuration changes require a new revision; immutable audit and configuration commit or roll back together", async () => {
  const { def } = await setup();
  const responses = await Promise.all(
    [false, true].map((enabled) =>
      h.request(
        rulesPath(def.id),
        "PUT",
        { expectedRevision: 0, rules: { ...open, enabled } },
        "admin",
        [200, 409],
      ),
    ),
  );
  assert.equal(responses.filter((r) => r.revision).length, 1);
  assert.equal((await h.request(`${rulesPath(def.id)}/events`)).length, 1);
  await assert.rejects(
    h.db.query(
      "UPDATE collection_rule_events SET rules=$1 WHERE definition_id=$2",
      [open, def.id],
    ),
    /immutable/i,
  );
  await h.db.query(
    "CREATE FUNCTION fail_collection_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit failure'; END $$",
  );
  await h.db.query(
    "CREATE TRIGGER fail_collection_event BEFORE INSERT ON collection_rule_events FOR EACH ROW EXECUTE FUNCTION fail_collection_event()",
  );
  try {
    await h.request(
      rulesPath(def.id),
      "PUT",
      { expectedRevision: 1, rules: { ...open, limit: 5 } },
      "admin",
      500,
    );
  } finally {
    await h.db.query(
      "DROP TRIGGER fail_collection_event ON collection_rule_events",
    );
    await h.db.query("DROP FUNCTION fail_collection_event()");
  }
  assert.equal((await h.request(rulesPath(def.id))).revision, 1);
  assert.equal((await h.request(`${rulesPath(def.id)}/events`)).length, 1);
  await configure(def.id, { limit: 2 });
});

test("status does not bypass creation permission or workspace boundaries, and configured rules survive restart without touching records", async () => {
  const { def } = await setup();
  await h.request(`/definitions/${def.id}/grants`, "PUT", {
    userId: reviewer,
    read: true,
    create: false,
    edit: false,
    scope: "self",
    fields: { name: "read" },
  });
  await h.request(
    `/definitions/${def.id}/collection-status`,
    "GET",
    undefined,
    "reviewer",
    403,
  );
  const foreign = await setup();
  await h.db.query(
    "UPDATE definitions SET workspace_id='other-workspace' WHERE id=$1",
    [foreign.def.id],
  );
  await h.request(rulesPath(foreign.def.id), "GET", undefined, "admin", 404);
  await h.request(
    `/definitions/${foreign.def.id}/collection-status`,
    "GET",
    undefined,
    "editor",
    404,
  );
  const record = await create(def.id);
  const saved = await configure(def.id, { limit: 1 });
  await h.restart();
  assert.deepEqual(await h.request(rulesPath(def.id)), saved);
  assert.equal(
    (await h.request(`/records/${record.record.id}`)).record.revision,
    1,
  );
  assert.equal(
    (
      await h.request(
        `/definitions/${def.id}/collection-status`,
        "GET",
        undefined,
        "editor",
      )
    ).code,
    "full",
  );
  assert.equal(
    (
      await h.db.query(
        "SELECT 1 FROM migration_history WHERE name='018-collection-rules.sql'",
      )
    ).rowCount,
    1,
  );
});
