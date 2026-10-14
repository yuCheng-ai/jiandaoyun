import { separateFormSchema, type FormSchema } from "@platform/contracts";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Pool } from "pg";
import { savePermissionGroup } from "./helpers";
const permissionGroup = (id: string, group: any) =>
  savePermissionGroup(request, id, group);

process.env.DATABASE_SCHEMA = `platform_test_${randomUUID().replaceAll("-", "")}`;
const { createApp } = require("../src/app") as typeof import("../src/app");
const { config } = require("../src/core/config/config") as typeof import("../src/core/config/config");
const { Database } =
  require("../src/core/database/database") as typeof import("../src/core/database/database");
const { passwordHash } = require("../src/core/auth/auth.service") as typeof import("../src/core/auth/auth.service");
let app: INestApplication,
  base = "",
  admin = "",
  editor = "",
  reviewer = "",
  users: any[],
  def: string,
  record: any,
  processId: string;
const basic = (id: string, type = "text", extra: any = {}) => ({
  id,
  type,
  label: id,
  visible: true,
  editable: true,
  required: false,
  unique: false,
  masked: false,
  defaultValue: "",
  precision: 2,
  maxLength: 200,
  children: [],
  ...extra,
});
const schema = {
  version: 1,
  settings: { rules: [] },
  fields: [
    basic("name", "text", { required: true }),
    basic("state"),
    basic("secret"),
    basic("lines", "subform", {
      children: [
        basic("quantity", "number", { min: 0 }),
        basic("checked", "number"),
        basic("cost", "number"),
      ],
    }),
  ],
};
async function request(
  path: string,
  method = "GET",
  body?: unknown,
  cookie = admin,
  expected = 200,
) {
  const response = await fetch(`${base}/api${path}`, {
    method,
    headers: {
      Origin: config.origin,
      "Content-Type": "application/json",
      Cookie: cookie,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = (await response.json()) as any;
  assert.equal(
    response.status,
    expected,
    `${method} ${path}: ${JSON.stringify(value)}`,
  );
  return value;
}
async function login(username: string) {
  const response = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { Origin: config.origin, "Content-Type": "application/json" },
    body: JSON.stringify({
      username,
      password: process.env[`PLATFORM_${username.toUpperCase()}_PASSWORD`],
    }),
  });
  assert.equal(response.status, 201);
  const cookie = response.headers.get("set-cookie")!;
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  return cookie.split(";")[0]!;
}
const grant = (userId: string, fields: any, extra: any = {}) => ({
  id: "member_" + userId,
  subjects: [{ kind: "member", id: userId }],
  scope: "all",
  fields,
  actions: ["view", "create", "edit"],
  ...extra,
});
const all = {
  name: "edit",
  state: "edit",
  secret: "edit",
  lines: "edit",
  quantity: "edit",
  checked: "edit",
  cost: "edit",
};
before(async () => {
  app = await createApp();
  await app.listen(0, "127.0.0.1");
  base = await app.getUrl();
  admin = await login("admin");
  editor = await login("editor");
  reviewer = await login("reviewer");
  users = await request("/users");
});
after(async () => {
  await app?.close();
  const cleanup = new Pool({ connectionString: config.databaseUrl });
  if (!/^platform_test_[a-f0-9]+$/.test(config.schema))
    throw new Error("Unsafe test cleanup schema");
  await cleanup.query(`DROP SCHEMA "${config.schema}" CASCADE`);
  await cleanup.end();
});
test("authentication, origin validation and administrator boundaries", async () => {
  await request("/definitions", "GET", undefined, "", 401);
  await request("/users", "GET", undefined, editor, 403);
  await request(
    "/data-objects",
    "POST",
    { title: "伪造管理员", model: separateFormSchema(schema as unknown as FormSchema).model, role: "admin" },
    editor,
    403,
  );
  const response = await fetch(`${base}/api/auth/logout`, {
    method: "POST",
    headers: { Cookie: admin, Origin: "https://untrusted.example" },
  });
  assert.equal(response.status, 403);
});
test("server rejects malformed data models", async () => {
  await request("/data-objects", "POST", {
    title: "重复字段",
    model: separateFormSchema({ ...schema, fields: [basic("a"), basic("a")] } as unknown as FormSchema).model,
  }, admin, 409);
  for (const invalid of [
    { ...schema, fields: [basic("a", "text", { unique: true })] },
    { ...schema, fields: [basic("a", "text", { defaultLink: { enabled: true, formId: "source", fieldId: "field", match: "all", filters: [] } })] },
    { ...schema, fields: [basic("a", "number", { defaultFormula: true, expression: "UNKNOWN_FUNCTION(1, 2)" })] },
  ])
    await request(
      "/data-objects",
      "POST",
      { title: "不支持", model: separateFormSchema(invalid as unknown as FormSchema).model },
      admin,
      400,
    );
});
test("create, publish and immutable database versions", async () => {
  const result = await request(
    "/data-objects",
    "POST",
    { title: "通用协作", model: separateFormSchema(schema as unknown as FormSchema).model },
    admin,
    201,
  );
  def = result.id;
  await request(
    `/data-objects/${def}/publish`,
    "POST",
    { expectedRevision: 1 },
    admin,
    201,
  );
  await request(
    `/data-objects/${def}/publish`,
    "POST",
    { expectedRevision: 1 },
    admin,
    409,
  );
  await assert.rejects(
    app
      .get(Database)
      .query(
        "UPDATE definition_versions SET title='tampered' WHERE definition_id=$1",
        [def],
      ),
    /immutable/,
  );
});
test("record creation is transactional, idempotent and supplies stable row identities", async () => {
  const command = {
    version: 1,
    requestId: randomUUID(),
    values: {
      name: "样本",
      state: "待核对",
      secret: "隐藏业务值",
      lines: [{ quantity: 2, checked: 0, cost: 180 }],
    },
  };
  const [one, two] = await Promise.all([
    request(`/definitions/${def}/records`, "POST", command, admin, 201),
    request(`/definitions/${def}/records`, "POST", command, admin, 201),
  ]);
  record = one.record;
  assert.equal(record.id, two.record.id);
  assert.match(record.values.lines[0]._rowId, /^[a-f0-9-]{36}$/);
  await request(
    `/definitions/${def}/records`,
    "POST",
    { ...command, values: { name: "不同内容" } },
    admin,
    409,
  );
  await request(
    `/definitions/${def}/records`,
    "POST",
    {
      version: 1,
      requestId: randomUUID(),
      values: { name: "非法", lines: [{ _rowId: randomUUID(), quantity: 1 }] },
    },
    admin,
    400,
  );
  await request(
    `/definitions/${def}/records`,
    "POST",
    {
      version: 1,
      requestId: randomUUID(),
      values: { name: "非法", lines: [{ quantity: -1 }] },
    },
    admin,
    400,
  );
  assert.equal((await request(`/definitions/${def}/records`)).length, 1);
});
test("column policies mask schema, values and revision metadata; policy updates apply immediately", async () => {
  await permissionGroup(
    def,
    grant(users.find((u) => u.username === "editor").id, {
      name: "edit",
      state: "read",
      lines: "edit",
      quantity: "edit",
      checked: "read",
    }),
  );
  await permissionGroup(
    def,
    grant(users.find((u) => u.username === "reviewer").id, {
      name: "read",
      state: "edit",
      lines: "edit",
      quantity: "read",
      checked: "edit",
    }),
  );
  const visible = await request(
    `/records/${record.id}`,
    "GET",
    undefined,
    editor,
  );
  assert.equal(visible.record.values.secret, undefined);
  assert.equal(visible.record.values.lines[0].cost, undefined);
  assert.ok(!JSON.stringify(visible).includes("隐藏业务值"));
  assert.ok(!JSON.stringify(visible.definition.schema).includes('"cost"'));
  assert.ok(
    !Object.keys(visible.record.cellRevisions).some(
      (k) => k.includes("cost") || k === "secret",
    ),
  );
  await request(`/records/${record.id}/events`, "GET", undefined, editor, 403);
});
test("forged actors, hidden columns, readonly columns and invalid row ids cannot be updated", async () => {
  for (const change of [
    { fieldId: "secret", value: "泄漏", expectedRevision: 1 },
    { fieldId: "state", value: "非法", expectedRevision: 1 },
    {
      subformId: "lines",
      rowId: record.values.lines[0]._rowId,
      fieldId: "cost",
      value: 1,
      expectedRevision: 1,
    },
  ])
    await request(
      `/records/${record.id}`,
      "PATCH",
      {
        requestId: randomUUID(),
        changes: [change],
        actorId: users.find((u) => u.role === "admin").id,
      },
      editor,
      403,
    );
  await request(
    `/records/${record.id}`,
    "PATCH",
    {
      requestId: randomUUID(),
      changes: [
        {
          subformId: "lines",
          rowId: randomUUID(),
          fieldId: "quantity",
          value: 3,
          expectedRevision: 1,
        },
      ],
    },
    editor,
    400,
  );
});
test("different columns concurrently merge; same column conflicts without losing input or data", async () => {
  const rowId = record.values.lines[0]._rowId;
  await Promise.all([
    request(
      `/records/${record.id}`,
      "PATCH",
      {
        requestId: randomUUID(),
        changes: [
          {
            subformId: "lines",
            rowId,
            fieldId: "quantity",
            value: 3,
            expectedRevision: 1,
          },
        ],
      },
      editor,
    ),
    request(
      `/records/${record.id}`,
      "PATCH",
      {
        requestId: randomUUID(),
        changes: [
          {
            subformId: "lines",
            rowId,
            fieldId: "checked",
            value: 2,
            expectedRevision: 1,
          },
        ],
      },
      reviewer,
    ),
  ]);
  let detail = await request(`/records/${record.id}`);
  assert.equal(detail.record.values.lines[0].quantity, 3);
  assert.equal(detail.record.values.lines[0].checked, 2);
  assert.equal(detail.record.values.lines[0]._rowId, rowId);
  await request(
    `/records/${record.id}`,
    "PATCH",
    {
      requestId: randomUUID(),
      changes: [
        {
          subformId: "lines",
          rowId,
          fieldId: "quantity",
          value: 99,
          expectedRevision: 1,
        },
      ],
    },
    editor,
    409,
  );
  const mutation = {
    requestId: randomUUID(),
    changes: [{ fieldId: "name", value: "更新", expectedRevision: 1 }],
  };
  await request(`/records/${record.id}`, "PATCH", mutation, editor);
  await request(`/records/${record.id}`, "PATCH", mutation, editor);
  detail = await request(`/records/${record.id}`);
  assert.equal(detail.record.cellRevisions.name, 2);
});
test("a mixed valid and forbidden patch rolls back every field and its audit", async () => {
  const before = await request(`/records/${record.id}`);
  await request(
    `/records/${record.id}`,
    "PATCH",
    {
      requestId: randomUUID(),
      changes: [
        { fieldId: "name", value: "不应保存", expectedRevision: 2 },
        { fieldId: "secret", value: "非法", expectedRevision: 1 },
      ],
    },
    editor,
    403,
  );
  const after = await request(`/records/${record.id}`);
  assert.deepEqual(before.record, after.record);
  assert.equal((await request(`/records/${record.id}/events`)).length, 4);
});
test("publishing V2 preserves V1 records and forbids reusing IDs for different types", async () => {
  const next = { ...schema, fields: [...schema.fields, basic("newField")] };
  await request(`/data-objects/${def}`, "PUT", {
    title: "通用协作 V2",
    model: separateFormSchema(next as unknown as FormSchema).model,
    expectedRevision: 2,
  });
  await request(
    `/data-objects/${def}/publish`,
    "POST",
    { expectedRevision: 3 },
    admin,
    201,
  );
  const old = await request(`/records/${record.id}`);
  assert.equal(old.definition.version, 1);
  assert.equal(old.definition.schema.fields.length, 4);
  await request(
    `/data-objects/${def}`,
    "PUT",
    {
      title: "非法",
      model: separateFormSchema({ ...schema, fields: [basic("name", "number")] } as unknown as FormSchema).model,
      expectedRevision: 4,
    },
    admin,
    400,
  );
});
test("cross-workspace IDs and self-only scopes are enforced", async () => {
  const db = app.get(Database);
  const foreign = randomUUID();
  await db.query(
    "INSERT INTO users(id,workspace_id,username,name,role,password_hash) VALUES($1,'foreign','foreign','外部','admin',$2)",
    [foreign, passwordHash("not-used-password")],
  );
  const { PlatformService } =
    require("../src/modules/pages/platform.service") as typeof import("../src/modules/pages/platform.service");
  await assert.rejects(
    app
      .get(PlatformService)
      .detail(
        {
          id: foreign,
          workspaceId: "foreign",
          username: "foreign",
          name: "外部",
          role: "admin",
        },
        record.id,
      ),
    /记录不存在/,
  );
  const user = users.find((u) => u.username === "editor");
  await permissionGroup(def, grant(user.id, all, { scope: "self" }));
  assert.equal(
    (await request(`/definitions/${def}/records`, "GET", undefined, editor))
      .length,
    0,
  );
  await request(`/records/${record.id}`, "GET", undefined, editor, 403);
  await permissionGroup(def, grant(user.id, all, {}));
});
test("two generic process configurations reuse record bindings, parallel tasks, joins and cross-record waits", async () => {
  const editorId = users.find((u) => u.username === "editor").id,
    reviewerId = users.find((u) => u.username === "reviewer").id;
  const relatedDef = await request(
    "/data-objects",
    "POST",
    {
      title: "关联确认",
      model: separateFormSchema({
        ...schema,
        fields: [basic("name", "text", { required: true }), basic("state")],
      } as unknown as FormSchema).model,
    },
    admin,
    201,
  );
  await request(
    `/data-objects/${relatedDef.id}/publish`,
    "POST",
    { expectedRevision: 1 },
    admin,
    201,
  );
  for (const userId of [editorId, reviewerId])
    await permissionGroup(
      relatedDef.id,
      grant(userId, { name: "edit", state: "edit" }),
    );
  const related = await request(
    `/definitions/${relatedDef.id}/records`,
    "POST",
    {
      version: 1,
      requestId: randomUUID(),
      values: { name: "关联单", state: "未完成" },
    },
    admin,
    201,
  );
  assert.notEqual(related.record.definitionId, record.definitionId);
  const payload = {
    requestId: randomUUID(),
    bindings: { main: record.id, related: related.record.id },
    spec: {
      title: "协作核对",
      tasks: [
        {
          id: "prepare",
          title: "准备",
          assigneeId: editorId,
          recordBinding: "main",
          dependsOn: [],
        },
        {
          id: "check",
          title: "核对",
          assigneeId: reviewerId,
          recordBinding: "related",
          dependsOn: [],
        },
        {
          id: "finish",
          title: "汇总",
          assigneeId: editorId,
          recordBinding: "main",
          dependsOn: ["prepare", "check"],
          waitFor: {
            recordBinding: "related",
            fieldId: "state",
            equals: "已完成",
          },
        },
      ],
    },
  };
  const process = await request("/processes", "POST", payload, admin, 201);
  processId = process.id;
  assert.equal(
    (await request("/processes", "POST", payload, admin, 201)).id,
    process.id,
  );
  const task = (key: string) =>
    process.tasks.find((t: any) => t.key === key).id;
  const complete = (key: string, cookie: string, status = 201) =>
    request(
      `/processes/${process.id}/tasks/${task(key)}/complete`,
      "POST",
      {},
      cookie,
      status,
    );
  await complete("finish", editor, 409);
  await complete("check", editor, 403);
  await complete("prepare", editor);
  await complete("prepare", editor);
  await complete("check", reviewer);
  await complete("finish", editor, 409);
  await request(
    `/records/${related.record.id}`,
    "PATCH",
    {
      requestId: randomUUID(),
      changes: [{ fieldId: "state", expectedRevision: 1, value: "已完成" }],
    },
    reviewer,
  );
  assert.equal((await complete("finish", editor)).status, "completed");
  // Different process topology and business labels, identical engine, no scenario branches.
  const second = await request(
    "/processes",
    "POST",
    {
      requestId: randomUUID(),
      bindings: { request: related.record.id },
      spec: {
        title: "资料交接",
        tasks: [
          {
            id: "handover",
            title: "交接",
            assigneeId: editorId,
            recordBinding: "request",
            dependsOn: [],
          },
          {
            id: "accept",
            title: "接收",
            assigneeId: reviewerId,
            recordBinding: "request",
            dependsOn: ["handover"],
          },
        ],
      },
    },
    admin,
    201,
  );
  assert.equal(second.tasks.filter((t: any) => t.status === "ready").length, 1);
  const handover = second.tasks.find((t: any) => t.key === "handover").id;
  const accept = second.tasks.find((t: any) => t.key === "accept").id;
  await request(
    `/processes/${second.id}/tasks/${accept}/complete`,
    "POST",
    {},
    reviewer,
    409,
  );
  await request(
    `/processes/${second.id}/tasks/${handover}/complete`,
    "POST",
    {},
    editor,
    201,
  );
  assert.equal(
    (
      await request(
        `/processes/${second.id}/tasks/${accept}/complete`,
        "POST",
        {},
        reviewer,
        201,
      )
    ).status,
    "completed",
  );
  const cyclic = structuredClone(payload);
  cyclic.requestId = randomUUID();
  cyclic.spec.tasks[0]!.dependsOn = ["finish"];
  await request("/processes", "POST", cyclic, admin, 400);
});
test("application restart preserves sessions, versioned records, task progress and idempotency history", async () => {
  await app.close();
  app = await createApp();
  await app.listen(0, "127.0.0.1");
  base = await app.getUrl();
  const detail = await request(`/records/${record.id}`);
  assert.equal(detail.record.values.name, "更新");
  assert.equal(detail.definition.version, 1);
  const process = await request(`/processes/${processId}`);
  assert.equal(process.status, "completed");
  assert.ok(process.tasks.every((t: any) => t.status === "completed"));
  await request("/auth/logout", "POST", {}, editor, 201);
  await request("/auth/me", "GET", undefined, editor, 401);
});
