import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { harness, field, schema } from "./helpers";

const h = harness();
before(() => h.start());
after(() => h.close());
const password = "Synthetic-password-1!";
const create = (extra = {}) => ({
  requestId: randomUUID(),
  username: `qa-${randomUUID()}`,
  name: "账号验收成员",
  password,
  ...extra,
});
const save = (account: any, extra = {}, expected = 200) =>
  h.request(
    `/organization/accounts/${account.id}`,
    "PUT",
    {
      requestId: randomUUID(),
      expectedRevision: account.revision,
      name: account.name,
      active: account.active,
      ...extra,
    },
    "admin",
    expected,
  );

test("administrator creates a member account once, without granting data access or storing credential material in audit", async () => {
  const command = create();
  await h.request("/organization/accounts", "POST", command, "", 401);
  await h.request("/organization/accounts", "POST", command, "editor", 403);
  await h.request(
    "/organization/accounts",
    "POST",
    { ...command, role: "admin" },
    "admin",
    400,
  );
  const account = await h.request(
    "/organization/accounts",
    "POST",
    command,
    "admin",
    201,
  );
  assert.deepEqual(
    await h.request("/organization/accounts", "POST", command, "admin", 201),
    account,
  );
  assert.deepEqual(Object.keys(account).sort(), [
    "active",
    "id",
    "name",
    "revision",
    "role",
    "username",
  ]);
  assert.equal(account.role, "member");
  await h.request(
    "/organization/accounts",
    "POST",
    { ...command, requestId: randomUUID() },
    "admin",
    409,
  );
  await h.login(command.username, password);
  assert.equal(
    (await h.request("/auth/me", "GET", undefined, command.username)).id,
    account.id,
  );
  assert.deepEqual(
    await h.request("/definitions", "GET", undefined, command.username),
    [],
  );
  const events = (
    await h.db.query("SELECT * FROM account_events WHERE account_id=$1", [
      account.id,
    ])
  ).rows;
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].detail, {
    name: command.name,
    active: true,
    passwordChanged: true,
  });
  assert.ok(!JSON.stringify(events).includes(password));
  const stored = (
    await h.db.query("SELECT password_hash FROM users WHERE id=$1", [
      account.id,
    ])
  ).rows[0].password_hash;
  assert.notEqual(stored, password);
  await assert.rejects(
    h.db.query("DELETE FROM account_events WHERE account_id=$1", [account.id]),
  );
});

test("disabling revokes all sessions, retains identity and role grants, and enabling requires a fresh login", async () => {
  const command = create();
  let account = await h.request(
    "/organization/accounts",
    "POST",
    command,
    "admin",
    201,
  );
  const organization = await h.request("/organization");
  const groupId = randomUUID(),
    roleId = randomUUID();
  organization.spec.roleGroups.push({ id: groupId, name: "账号测试组" });
  organization.spec.roles.push({
    id: roleId,
    groupId,
    name: "资料员",
    description: "",
    memberIds: [account.id],
    departmentIds: [],
    includeChildren: false,
    archived: false,
  });
  await h.request("/organization", "PUT", {
    expectedRevision: organization.revision,
    spec: organization.spec,
  });
  const definition = await h.definition("账号授权验收", schema(field("name")));
  await h.request(`/definitions/${definition.id}/subject-grants`, "PUT", {
    subject: { kind: "role", id: roleId },
    expectedRevision: 0,
    read: true,
    create: true,
    edit: true,
    scope: "self",
    fields: { name: "edit" },
  });
  await h.login(command.username, password, "first-session");
  await h.login(command.username, password, "second-session");
  const record = await h.record(
    definition.id,
    { name: "账号停用仍保留" },
    "first-session",
  );
  account = await save(account, { active: false });
  for (const alias of ["first-session", "second-session"])
    await h.request("/auth/me", "GET", undefined, alias, 401);
  await h.request(
    "/auth/login",
    "POST",
    { username: command.username, password },
    "",
    401,
  );
  account = await save(account, { active: true });
  await h.request("/auth/me", "GET", undefined, "first-session", 401);
  await h.login(command.username, password, "fresh-session");
  assert.equal(
    (
      await h.request(
        `/records/${record.record.id}`,
        "GET",
        undefined,
        "fresh-session",
      )
    ).record.createdBy,
    account.id,
  );
  assert.deepEqual((await h.request("/organization")).spec, organization.spec);
  await h.restart();
  assert.equal(
    (await h.request("/auth/me", "GET", undefined, "fresh-session")).id,
    account.id,
  );
});

test("password reset is versioned, revokes sessions and cannot be replayed to undo a later account change", async () => {
  const command = create();
  let account = await h.request(
    "/organization/accounts",
    "POST",
    command,
    "admin",
    201,
  );
  await h.login(command.username, password, "old-password-session");
  const newPassword = "Synthetic-replacement-2!";
  const update = {
    requestId: randomUUID(),
    expectedRevision: account.revision,
    name: account.name,
    active: true,
    password: newPassword,
  };
  const path = `/organization/accounts/${account.id}`;
  account = await h.request(path, "PUT", update);
  await h.request("/auth/me", "GET", undefined, "old-password-session", 401);
  await h.request(
    "/auth/login",
    "POST",
    { username: command.username, password },
    "",
    401,
  );
  await h.login(command.username, newPassword, "new-password-session");
  await h.request(
    path,
    "PUT",
    { ...update, requestId: randomUUID(), name: "旧版本覆盖" },
    "admin",
    409,
  );
  account = await save(account, { active: false });
  assert.deepEqual(await h.request(path, "PUT", update), account);
  await h.request(
    path,
    "PUT",
    { ...update, password: "Different-password-3!" },
    "admin",
    409,
  );
  const events = (
    await h.db.query("SELECT * FROM account_events WHERE account_id=$1", [
      account.id,
    ])
  ).rows;
  assert.equal(events.length, 3);
  assert.ok(!JSON.stringify(events).includes(newPassword));
  assert.equal(
    (await h.db.query("SELECT * FROM sessions WHERE user_id=$1", [account.id]))
      .rowCount,
    0,
  );
  const admin = (await h.request("/organization")).users.find(
    (user: any) => user.username === "admin",
  );
  await save(admin, { active: false }, 400);
  await save({ ...account, id: randomUUID() }, {}, 404);
});

test("account edits rollback with failed audit and competing edits cannot silently overwrite each other", async () => {
  const command = create();
  const account = await h.request(
    "/organization/accounts",
    "POST",
    command,
    "admin",
    201,
  );
  const outcomes = await Promise.all(
    ["名字甲", "名字乙"].map((name) =>
      h.request(
        `/organization/accounts/${account.id}`,
        "PUT",
        { requestId: randomUUID(), expectedRevision: 1, name, active: true },
        "admin",
        [200, 409],
      ),
    ),
  );
  assert.equal(outcomes.filter((item) => item.revision === 2).length, 1);
  const updated = outcomes.find((item) => item.revision === 2);
  await h.login(command.username, password, "rollback-session");
  await h.db.query(
    "CREATE FUNCTION reject_account_audit() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'synthetic audit failure'; END; $$ LANGUAGE plpgsql",
  );
  await h.db.query(
    "CREATE TRIGGER fail_account_audit BEFORE INSERT ON account_events FOR EACH ROW EXECUTE FUNCTION reject_account_audit()",
  );
  try {
    await save(updated, { active: false }, 500);
  } finally {
    await h.db.query("DROP TRIGGER fail_account_audit ON account_events");
  }
  assert.equal(
    (await h.request("/auth/me", "GET", undefined, "rollback-session")).id,
    account.id,
  );
  assert.deepEqual(
    (await h.request("/organization")).users.find(
      (user: any) => user.id === account.id,
    ),
    updated,
  );
});

test("a login queued behind a password change verifies the committed password before creating a session", async () => {
  const command = create();
  const account = await h.request(
    "/organization/accounts",
    "POST",
    command,
    "admin",
    201,
  );
  const { passwordHash } =
    require("../src/core/auth/auth.service") as typeof import("../src/core/auth/auth.service");
  const tx = await h.db.pool.connect();
  let pending: Promise<any> | undefined;
  try {
    await tx.query("BEGIN");
    await tx.query("UPDATE users SET password_hash=$2 WHERE id=$1", [
      account.id,
      passwordHash("Changed-before-login-4!"),
    ]);
    pending = h.request(
      "/auth/login",
      "POST",
      { username: command.username, password },
      "",
      401,
    );
    let waiting = false;
    for (let i = 0; i < 100 && !waiting; i++) {
      waiting =
        (
          await h.db.query(
            "SELECT 1 FROM pg_stat_activity WHERE query LIKE 'SELECT * FROM users WHERE username=%' AND wait_event_type='Lock'",
          )
        ).rowCount! > 0;
      if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(waiting, "login must wait for the concurrent account change");
    await tx.query("COMMIT");
    await pending;
    assert.equal(
      (
        await h.db.query("SELECT * FROM sessions WHERE user_id=$1", [
          account.id,
        ])
      ).rowCount,
      0,
    );
  } finally {
    await tx.query("ROLLBACK");
    tx.release();
    await pending;
  }
});

test("account operations cannot target another workspace or create blank passwords", async () => {
  const { passwordHash } =
    require("../src/core/auth/auth.service") as typeof import("../src/core/auth/auth.service");
  const id = randomUUID();
  await h.db.query(
    "INSERT INTO users(id,workspace_id,username,name,role,password_hash) VALUES($1,'other',$2,'外部账号','member',$3)",
    [id, `foreign-${id}`, passwordHash(password)],
  );
  await save({ id, name: "越界修改", revision: 1, active: true }, {}, 404);
  await h.request(
    "/organization/accounts",
    "POST",
    create({ password: " ".repeat(16) }),
    "admin",
    400,
  );
  assert.equal(
    (
      await h.db.query("SELECT name,account_revision FROM users WHERE id=$1", [
        id,
      ])
    ).rows[0].name,
    "外部账号",
  );
  assert.equal(
    (await h.db.query("SELECT * FROM account_events WHERE account_id=$1", [id]))
      .rowCount,
    0,
  );
});

test("an administrator resetting their password keeps this authenticated session and revokes other sessions", async () => {
  const original = process.env.PLATFORM_ADMIN_PASSWORD!;
  await h.login("admin", original, "other-admin-session");
  let admin = (await h.request("/organization")).users.find(
    (user: any) => user.username === "admin",
  );
  try {
    admin = await save(admin, { password: "Synthetic-self-reset-5!" });
    assert.equal((await h.request("/auth/me")).id, admin.id);
    await h.request("/auth/me", "GET", undefined, "other-admin-session", 401);
    await h.request(
      "/auth/login",
      "POST",
      { username: "admin", password: original },
      "",
      401,
    );
  } finally {
    await save(admin, { password: original });
  }
});

test("server directory initialization, concurrent edits and audit failures preserve one authoritative snapshot", async () => {
  const path = "/organization/directory";
  assert.deepEqual(await h.request(path), { directory: null });
  assert.deepEqual(await h.request(path), { directory: null });
  assert.equal((await h.db.query("SELECT 1 FROM organization_directories")).rowCount, 0);
  const spec = { version: 1, name: "组织与成员", departments: [], employees: [], roles: [], roleGroups: [] };
  const command = { requestId: randomUUID(), namespace: randomUUID(), spec };
  await h.request(path, "GET", undefined, "editor", 403);
  await h.request(path, "POST", command, "editor", 403);
  const initial = await h.request(path, "POST", command, "admin", 201);
  assert.deepEqual(await h.request(path, "POST", command, "admin", 201), initial);
  await h.request(path, "POST", { ...command, namespace: randomUUID(), requestId: randomUUID() }, "admin", 409);
  const department = (id: string) => ({ id, name: id, parentId: null, managerIds: [], archived: false });
  const write = (before: any, after: any, expected = 200) => h.request(path, "PUT", { namespace: initial.namespace, requestId: randomUUID(), before, spec: after }, "admin", expected);
  await write(spec, { ...spec, departments: [department("department-a")] });
  let saved = await write(spec, { ...spec, departments: [department("department-b")] });
  assert.deepEqual(saved.spec.departments.map((item: any) => item.id).sort(), ["department-a", "department-b"]);
  const before = structuredClone(saved.spec), changed = structuredClone(before);
  changed.departments[0].name = "其他管理员保存的部门";
  saved = await write(before, changed);
  await write(before, { ...before, departments: before.departments.map((item: any, index: number) => index ? item : { ...item, name: "陈旧部门修改" }) }, 409);
  assert.deepEqual((await h.request(path)).directory, saved);
  const organization = await h.request("/organization");
  await h.db.query("CREATE FUNCTION reject_directory_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'directory audit failure'; END $$");
  await h.db.query("CREATE TRIGGER reject_directory_event BEFORE INSERT ON directory_events FOR EACH ROW EXECUTE FUNCTION reject_directory_event()");
  try {
    await write(saved.spec, { ...saved.spec, departments: [...saved.spec.departments, department("rolled-back")] }, 500);
    assert.deepEqual((await h.request(path)).directory, saved);
    assert.deepEqual(await h.request("/organization"), organization);
  } finally {
    await h.db.query("DROP TRIGGER reject_directory_event ON directory_events");
    await h.db.query("DROP FUNCTION reject_directory_event()");
  }
});

test("directory members require explicit account links and stale member details cannot create associations", async () => {
  const path = "/organization/directory", original = (await h.request(path)).directory;
  const account = (await h.request("/organization")).users.find((user: any) => user.username === "editor");
  const departmentId = original.spec.departments[0].id;
  const member = { id: "directory-member", name: account.name, number: "D001", email: "", phone: "", departmentIds: [departmentId], primaryDepartmentId: departmentId, position: "", status: "active", joinedAt: "" };
  const saved = await h.request(path, "PUT", { requestId: randomUUID(), namespace: original.namespace, before: original.spec, spec: { ...original.spec, employees: [member] } });
  const linkPath = `/organization/member-accounts?namespace=${saved.namespace}`;
  assert.deepEqual((await h.request(linkPath)).links, []);
  const command = { requestId: randomUUID(), accountId: account.id, accountRevision: account.revision, expectedRevision: 0, source: { namespace: saved.namespace, memberId: member.id, name: member.name, number: member.number } };
  await h.request("/organization/member-accounts", "PUT", { ...command, source: { ...command.source, number: "stale-number" } }, "admin", 409);
  assert.deepEqual((await h.request(linkPath)).links, []);
  const linked = await h.request("/organization/member-accounts", "PUT", command);
  assert.equal(linked.source.memberId, member.id);
  assert.equal(linked.account.id, account.id);
  assert.deepEqual(await h.request("/organization/member-accounts", "PUT", command), linked);
  await h.request("/organization/member-accounts", "PUT", { ...command, requestId: randomUUID() }, "admin", 409);
  const actorDepartment = (await h.request("/organization")).spec.assignments.find((item: any) => item.userId === account.id);
  assert.ok(actorDepartment.departmentIds.length);
});
