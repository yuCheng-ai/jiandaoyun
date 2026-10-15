import { separateFormSchema, type FormSchema } from "@platform/contracts";
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { harness, field, schema } from "./helpers";
const h = harness();
let editor: any, reviewer: any;
before(async () => {
  await h.start();
  const users = await h.request("/users");
  editor = users.find((u: any) => u.username === "editor");
  reviewer = users.find((u: any) => u.username === "reviewer");
});
after(() => h.close());
const group = (id: string, extra: any = {}) => ({
  id,
  name: id,
  enabled: true,
  archived: false,
  subjects: [{ kind: "member", id: editor.id }],
  actions: ["view"],
  scope: "all",
  filters: [],
  fields: {
    name: "read",
    amount: "read",
    secret: "hidden",
    lines: "read",
    a: "read",
    b: "read",
  },
  relations: {},
  ...extra,
});
const create = () =>
  h.definition(
    "权限组运行验收",
    schema(
      field("name"),
      field("amount", "number"),
      field("secret"),
      field("lines", "subform", { children: [field("a"), field("b")] }),
    ),
  );
const save = (
  id: string,
  groups: any[],
  allowMerged = false,
  revision = 0,
  mode = "groups",
) =>
  h.request(`/definitions/${id}/permission-groups`, "PUT", {
    expectedRevision: revision,
    mode,
    allowMerged,
    groups,
  });
const selected = (id: string, selection: string) => ({
  "X-Platform-Access-Groups": JSON.stringify({ [id]: selection }),
});
const request = (
  path: string,
  id: string,
  selection: string,
  expected = 200,
  method = "GET",
  body?: any,
  user = "editor",
) => h.request(path, method, body, user, expected, selected(id, selection));
const record = (id: string, name = "ready") =>
  h.record(id, {
    name,
    amount: 7,
    secret: "内部内容",
    lines: [{ a: "A", b: "B" }],
  });
test("record selection headers stay out of authentication and directory while every record entry validates them", async () => {
  const malformed = { "X-Platform-Access-Groups": "[]" };
  const identity = await h.request("/auth/me", "GET", undefined, "editor", 200, malformed);
  assert.equal(identity.id, editor.id);
  assert.equal(Object.hasOwn(identity, "accessGroups"), false);
  await h.request("/organization", "GET", undefined, "admin", 200, malformed);

  const id = randomUUID();
  const paths = [
    "/applications",
    "/definitions",
    `/definitions/${id}/permission-groups/options`,
    `/definitions/${id}/collection-rules`,
    `/records/${id}`,
    "/relations",
    "/processes",
    "/process-templates",
  ];
  for (const path of paths) {
    const error = await h.request(path, "GET", undefined, "editor", 400, malformed);
    assert.equal(error.message, "权限组选择格式不合法");
  }
  await h.request(`/pages/${id}/records`, "POST", {}, "editor", 400, malformed);
  await h.request("/definitions", "GET", undefined, "anonymous", 401, malformed);

  const tooMany = Object.fromEntries(Array.from({ length: 51 }, () => [randomUUID(), "group"]));
  for (const choices of [
    { invalid: "group" },
    { [id]: "" },
    { [id]: "x".repeat(201) },
    { [id]: "x".repeat(12000) },
    tooMany,
  ]) {
    await h.request("/definitions", "GET", undefined, "editor", 400, {
      "X-Platform-Access-Groups": JSON.stringify(choices),
    });
  }
});

test("group options describe administrator bypass without a second authorization mode", async () => {
  const def = await create();
  const adminOptions = await h.request(`/definitions/${def.id}/permission-groups/options`);
  assert.equal(adminOptions.administrator, true);
  assert.equal(Object.hasOwn(adminOptions, "mode"), false);
  assert.deepEqual(adminOptions.groups, []);

  await save(def.id, [group("member-view")]);
  const memberOptions = await h.request(
    `/definitions/${def.id}/permission-groups/options`,
    "GET",
    undefined,
    "editor",
  );
  assert.equal(memberOptions.administrator, false);
  assert.deepEqual(memberOptions.groups.map((item: any) => item.id), ["member-view"]);
  const rec = await record(def.id);
  const denied = await request(`/records/${rec.record.id}`, def.id, "forged", 403);
  assert.equal(denied.statusCode, 403);
});
test("merged fields clamp each group operation and parent before union; forged or ineligible selections fail", async () => {
  const def = await create(),
    rec = await record(def.id),
    row = rec.record.values.lines[0];
  await save(
    def.id,
    [
      group("view-all", {
        fields: { lines: "edit", a: "edit", b: "edit", secret: "read" },
      }),
      group("edit-child", {
        actions: ["view", "edit"],
        fields: { lines: "read", a: "edit", b: "hidden" },
      }),
    ],
    true,
  );
  const detail = await request(`/records/${rec.record.id}`, def.id, "*");
  assert.equal(detail.access.fields.a, "read");
  assert.equal(detail.access.fields.lines, "read");
  const narrowed = await request(`/records/${rec.record.id}`, def.id, "edit-child");
  assert.equal(narrowed.record.values.secret, undefined);
  assert.equal(narrowed.access.groupSelection.selection, "edit-child");
  await request(`/records/${rec.record.id}`, def.id, "*", 403, "PATCH", {
    requestId: randomUUID(),
    changes: [
      {
        subformId: "lines",
        rowId: row._rowId,
        fieldId: "a",
        expectedRevision: 1,
        value: "不能写",
      },
    ],
  });
  await request(`/records/${rec.record.id}`, def.id, "missing", 403);
  await request(
    `/records/${rec.record.id}`,
    def.id,
    "view-all",
    403,
    "GET",
    undefined,
    "reviewer",
  );
  const out = await request(`/records/${rec.record.id}`, def.id, "*");
  assert.equal(out.record.values.lines[0].a, "A");
});
test("output masks come only from groups allowing that operation on that record", async () => {
  const def = await create(),
    rec = await record(def.id);
  await save(
    def.id,
    [
      group("view", { fields: { name: "read", secret: "read" } }),
      group("export", {
        actions: ["view", "export"],
        fields: { name: "read" },
      }),
      group("print", {
        actions: ["view", "print"],
        fields: { amount: "read" },
      }),
    ],
    true,
  );
  const view = await request(`/records/${rec.record.id}`, def.id, "*");
  assert.equal(view.record.values.secret, "内部内容");
  const csv = await request(
    `/records/${rec.record.id}/output/export`,
    def.id,
    "*",
  );
  assert.deepEqual(csv.record.values, { name: "ready" });
  assert.equal(csv.access.edit, false);
  const print = await request(
    `/records/${rec.record.id}/output/print`,
    def.id,
    "*",
  );
  assert.deepEqual(print.record.values, { amount: 7 });
  await request(`/records/${rec.record.id}/output/export`, def.id, "view", 403);
});
test("custom filters agree between list, detail and write; SQL inputs stay parameterized", async () => {
  const def = await create(),
    visible = await record(def.id, "allowed' OR true --"),
    hidden = await record(def.id, "other");
  await save(def.id, [
    group("filtered", {
      actions: ["view", "edit"],
      scope: "custom",
      filters: [
        {
          id: "f",
          sourceFieldId: "name",
          operator: "equals",
          source: "constant",
          value: "allowed' OR true --",
        },
      ],
      fields: { name: "read", amount: "edit" },
    }),
  ]);
  const list = await h.request(
    `/definitions/${def.id}/records`,
    "GET",
    undefined,
    "editor",
  );
  assert.deepEqual(
    list.map((r: any) => r.id),
    [visible.record.id],
  );
  await h.request(
    `/records/${hidden.record.id}`,
    "GET",
    undefined,
    "editor",
    403,
  );
  await h.request(
    `/records/${hidden.record.id}`,
    "PATCH",
    {
      requestId: randomUUID(),
      changes: [{ fieldId: "amount", expectedRevision: 1, value: 9 }],
    },
    "editor",
    403,
  );
  const changed = await h.request(
    `/records/${visible.record.id}`,
    "PATCH",
    {
      requestId: randomUUID(),
      changes: [{ fieldId: "amount", expectedRevision: 1, value: 9 }],
    },
    "editor",
  );
  assert.equal(changed.record.values.amount, 9);
});
test("filters run before the first 100 results and unknown numeric values cannot break numeric filtering", async () => {
  const def = await create(),
    visible = await record(def.id, "keep");
  await h.db.query(
    'INSERT INTO records(id,workspace_id,definition_id,definition_version,values,cell_revisions,created_by) SELECT gen_random_uuid(),\'local\',$1,1,\'{"name":"skip","amount":null,"lines":[]}\'::jsonb,\'{}\'::jsonb,$2 FROM generate_series(1,105)',
    [def.id, reviewer.id],
  );
  await save(def.id, [
    group("numbers", {
      scope: "custom",
      filters: [
        {
          id: "f",
          sourceFieldId: "amount",
          operator: "greater",
          source: "constant",
          value: "6",
        },
      ],
    }),
  ]);
  assert.deepEqual(
    (
      await h.request(
        `/definitions/${def.id}/records`,
        "GET",
        undefined,
        "editor",
      )
    ).map((r: any) => r.id),
    [visible.record.id],
  );
});
test("config revisions, audit immutability and actor/workspace checks guard authorization changes", async () => {
  const def = await create();
  const cfg = await save(def.id, [group("one")]);
  await h.request(
    `/definitions/${def.id}/permission-groups`,
    "GET",
    undefined,
    "editor",
    403,
  );
  await h.request(
    `/definitions/${def.id}/permission-groups`,
    "PUT",
    {
      expectedRevision: 0,
      mode: "groups",
      allowMerged: false,
      groups: [group("two")],
    },
    "admin",
    409,
  );
  await assert.rejects(
    h.db.query(
      "DELETE FROM record_permission_group_events WHERE definition_id=$1",
      [def.id],
    ),
    /immutable/,
  );
  const rec = await record(def.id);
  await h.db.query("UPDATE definitions SET workspace_id='other' WHERE id=$1", [
    def.id,
  ]);
  await h.request(
    `/definitions/${def.id}/permission-groups/options`,
    "GET",
    undefined,
    "editor",
    404,
  );
  await h.db.query("UPDATE definitions SET workspace_id='local' WHERE id=$1", [
    def.id,
  ]);
  await save(def.id, [group("one", { enabled: false })], false, cfg.revision);
  await request(`/records/${rec.record.id}`, def.id, "one", 403);
});
test("unknown or unimplemented rules fail explicitly without replacing the saved configuration", async () => {
  const def = await create();
  for (const bad of [
    group("edit-without-view", { actions: ["create", "edit"] }),
    group("unknown", { actions: ["view"], extraRule: true }),
    group("empty", { scope: "custom" }),
    group("text-number", {
      filters: [
        {
          id: "f",
          sourceFieldId: "name",
          operator: "greater",
          source: "constant",
          value: "1",
        },
      ],
    }),
  ])
    await h.request(
      `/definitions/${def.id}/permission-groups`,
      "PUT",
      {
        expectedRevision: 0,
        mode: "groups",
        allowMerged: false,
        groups: [bad],
      },
      "admin",
      400,
    );
  assert.equal(
    (await h.request(`/definitions/${def.id}/permission-groups`)).revision,
    0,
  );
  await h.request("/definitions", "GET", undefined, "editor", 400, {
    "X-Platform-Access-Groups": "[]",
  });
});

test("a scoped edit can hand off the record without returning its content or rolling back the save", async () => {
  const def = await create(),
    rec = await record(def.id);
  const page = (await h.request(`/pages?definitionId=${def.id}`))[0];
  await save(def.id, [
    group("handling", {
      actions: ["view", "edit"],
      scope: "custom",
      filters: [
        {
          id: "pending",
          sourceFieldId: "name",
          operator: "equals",
          source: "constant",
          value: "ready",
        },
      ],
      fields: { name: "edit" },
    }),
  ]);
  const body = {
    pageVersion: 1,
    requestId: randomUUID(),
    changes: [{ fieldId: "name", expectedRevision: 1, value: "done" }],
  };
  const receipt = await h.request(
    `/pages/${page.id}/records/${rec.record.id}`,
    "PATCH",
    body,
    "editor",
  );
  assert.equal(receipt.accessLost, true);
  assert.deepEqual(receipt.record.values, {});
  assert.deepEqual(receipt.definition.schema.fields, []);
  assert.equal(receipt.access.read, false);
  assert.equal(receipt.record.revision, 2);
  assert.equal(
    (await h.request(`/records/${rec.record.id}`)).record.values.name,
    "done",
  );
  assert.deepEqual(
    await h.request(
      `/definitions/${def.id}/records`,
      "GET",
      undefined,
      "editor",
    ),
    [],
  );
  await h.request(`/records/${rec.record.id}`, "GET", undefined, "editor", 403);
  const retried = await h.request(`/pages/${page.id}/records/${rec.record.id}`, "PATCH", body, "editor");
  assert.equal(retried.accessLost, true);
  assert.deepEqual(retried.record.values, {});
  assert.equal(
    (await h.request(`/records/${rec.record.id}`)).record.revision,
    2,
  );
});
test("custom comparison SQL agrees with direct record authorization for empty values, arrays and numeric boundaries", async () => {
  const def = await h.definition(
    "筛选一致性",
    schema(
      field("name"),
      field("amount", "number"),
      field("tags", "multiselect", {
        options: [
          { id: "a", label: "甲" },
          { id: "b", label: "乙" },
        ],
        choiceSource: {
          mode: "manual",
          formId: "",
          labelFieldId: "",
          valueFieldId: "",
          filters: [],
          sort: "none",
          deduplicate: true,
        },
      }),
    ),
  );
  const values = [
    { name: "alpha", amount: 0, tags: ["a"] },
    { name: "beta", amount: -2, tags: ["b"] },
    { name: "", amount: 8, tags: [] },
    { name: "alphabet", amount: 3, tags: ["a", "b"] },
  ];
  const rows = [];
  for (const value of values) rows.push(await h.record(def.id, value));
  let rev = 0;
  for (const [field, operator, value] of [
    ["name", "equals", "alpha"],
    ["name", "notEquals", "alpha"],
    ["name", "contains", "alpha"],
    ["name", "notEmpty", ""],
    ["tags", "equals", "a"],
    ["tags", "notEquals", "b"],
    ["tags", "contains", "a"],
    ["tags", "notEmpty", ""],
    ["amount", "greater", "0"],
    ["amount", "less", "0"],
  ]) {
    const cfg = await save(
      def.id,
      [
        group("filter", {
          fields: { name: "read" },
          scope: "custom",
          filters: [
            {
              id: "f",
              sourceFieldId: field,
              operator,
              source: "constant",
              value,
            },
          ],
        }),
      ],
      false,
      rev,
    );
    rev = cfg.revision;
    const list = new Set(
      (
        await h.request(
          `/definitions/${def.id}/records`,
          "GET",
          undefined,
          "editor",
        )
      ).map((r: any) => r.id),
    );
    for (const row of rows)
      await h.request(
        `/records/${row.record.id}`,
        "GET",
        undefined,
        "editor",
        list.has(row.record.id) ? 200 : 403,
      );
  }
});
test("relation candidates filter permission scopes before paging and never use a view-only group to widen output", async () => {
  const source = await h.definition("来源", schema(field("name"))),
    target = await create();
  const src = await h.record(source.id, { name: "来源" }),
    visible = await record(target.id, "ready");
  await record(target.id, "private");
  const relation = await h.relation({
    title: "资料",
    sourceDefinitionId: source.id,
    targetDefinitionId: target.id,
    cardinality: "many",
    inverseCardinality: "many",
    labelFieldId: "name",
    columns: ["amount", "secret"],
    filters: [],
    mappings: [],
    valueMode: "live",
  });
  await h.permissionGroup(source.id, {
    id: "member_" + editor.id,
    subjects: [{ kind: "member", id: editor.id }],
    scope: "all",
    fields: { name: "edit" },
    relations: { [relation.id]: "edit" },
    actions: ["view", "edit"],
  });
  await save(target.id, [
    group("allowed", {
      fields: { name: "read", amount: "read" },
      scope: "custom",
      filters: [
        {
          id: "f",
          sourceFieldId: "name",
          operator: "equals",
          source: "constant",
          value: "ready",
        },
      ],
    }),
  ]);
  const result = await h.request(
    `/records/${src.record.id}/relations/${relation.id}/candidates`,
    "GET",
    undefined,
    "editor",
  );
  assert.deepEqual(
    result.items.map((r: any) => r.recordId),
    [visible.record.id],
  );
  assert.equal(result.items[0].values.secret, undefined);
});
test("permission-group config and immutable audit roll back together on audit failure", async () => {
  const def = await create();
  await h.db.query(
    "CREATE FUNCTION fail_group_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'group-audit-test'; END $$",
  );
  await h.db.query(
    "CREATE TRIGGER fail_group_audit BEFORE INSERT ON record_permission_group_events FOR EACH ROW EXECUTE FUNCTION fail_group_audit()",
  );
  try {
    await h.request(
      `/definitions/${def.id}/permission-groups`,
      "PUT",
      {
        expectedRevision: 0,
        mode: "groups",
        allowMerged: false,
        groups: [group("one")],
      },
      "admin",
      500,
    );
  } finally {
    await h.db.query(
      "DROP TRIGGER fail_group_audit ON record_permission_group_events",
    );
  }
  assert.equal(
    (await h.request(`/definitions/${def.id}/permission-groups`)).revision,
    0,
  );
});

test("department eligibility follows current membership while record scope keeps its creation snapshot", async () => {
  const original = await h.request("/organization"),
    admin = (await h.request("/users")).find(
      (u: any) => u.username === "admin",
    );
  const parent = randomUUID(),
    child = randomUUID(),
    other = randomUUID(),
    roleGroup = randomUUID(),
    role = randomUUID();
  const spec = {
    departments: [
      { id: parent, name: "业务部", parentId: null, archived: false },
      { id: child, name: "业务组", parentId: parent, archived: false },
      { id: other, name: "其他部", parentId: null, archived: false },
    ],
    roleGroups: [{ id: roleGroup, name: "岗位" }],
    roles: [
      {
        id: role,
        groupId: roleGroup,
        name: "办理",
        description: "",
        memberIds: [],
        departmentIds: [parent],
        includeChildren: true,
        archived: false,
      },
    ],
    assignments: [
      {
        userId: admin.id,
        departmentIds: [parent],
        primaryDepartmentId: parent,
      },
      { userId: editor.id, departmentIds: [child], primaryDepartmentId: child },
      {
        userId: reviewer.id,
        departmentIds: [other],
        primaryDepartmentId: other,
      },
    ],
  };
  let org = await h.request("/organization", "PUT", {
    expectedRevision: original.revision,
    spec,
  });
  const def = await create(),
    rec = await record(def.id);
  let cfg = await save(def.id, [
    group("department", {
      subjects: [{ kind: "department", id: parent, includeChildren: false }],
      scope: "department",
    }),
  ]);
  await h.request(
    `/definitions/${def.id}/permission-groups/options`,
    "GET",
    undefined,
    "editor",
    403,
  );
  cfg = await save(
    def.id,
    [
      group("department", {
        subjects: [{ kind: "department", id: parent, includeChildren: true }],
        scope: "department",
      }),
    ],
    false,
    cfg.revision,
  );
  assert.equal(
    (
      await h.request(
        `/definitions/${def.id}/permission-groups/options`,
        "GET",
        undefined,
        "editor",
      )
    ).groups.length,
    1,
  );
  await h.request(`/records/${rec.record.id}`, "GET", undefined, "editor", 403);
  const moved = structuredClone(spec);
  moved.assignments[1] = {
    userId: editor.id,
    departmentIds: [parent],
    primaryDepartmentId: parent,
  };
  moved.assignments[0] = {
    userId: admin.id,
    departmentIds: [other],
    primaryDepartmentId: other,
  };
  org = await h.request("/organization", "PUT", {
    expectedRevision: org.revision,
    spec: moved,
  });
  assert.equal(
    (await h.request(`/records/${rec.record.id}`, "GET", undefined, "editor"))
      .record.id,
    rec.record.id,
  );
  cfg = await save(
    def.id,
    [group("role", { subjects: [{ kind: "role", id: role }], scope: "all" })],
    false,
    cfg.revision,
  );
  await h.request(`/records/${rec.record.id}`, "GET", undefined, "editor");
  moved.assignments[1] = {
    userId: editor.id,
    departmentIds: [other],
    primaryDepartmentId: other,
  };
  await h.request("/organization", "PUT", {
    expectedRevision: org.revision,
    spec: moved,
  });
  await h.request(`/records/${rec.record.id}`, "GET", undefined, "editor", 403);
});
test("identity filter runtime sources use the authenticated member and primary department", async () => {
  const org = await h.request("/organization"),
    primary = org.spec.assignments.find(
      (a: any) => a.userId === editor.id,
    ).primaryDepartmentId;
  const def = await h.definition(
    "身份范围",
    schema(
      field("name"),
      field("owner", "member", {
        organization: {
          scope: {
            mode: "all",
            departmentIds: [],
            roleIds: [],
            employeeIds: [],
            includeChildren: true,
            fieldId: "",
          },
          defaultMode: "none",
          defaultIds: [],
        },
      }),
      field("dept", "department", {
        organization: {
          scope: {
            mode: "all",
            departmentIds: [],
            roleIds: [],
            employeeIds: [],
            includeChildren: true,
            fieldId: "",
          },
          defaultMode: "none",
          defaultIds: [],
        },
      }),
    ),
  );
  const own = await h.record(def.id, {
      name: "own",
      owner: editor.id,
      dept: primary,
    }),
    other = await h.record(def.id, {
      name: "other",
      owner: reviewer.id,
      dept: primary,
    });
  await save(def.id, [
    group("identities", {
      fields: { name: "read" },
      scope: "custom",
      filters: [
        {
          id: "person",
          sourceFieldId: "owner",
          source: "currentUser",
          operator: "equals",
          value: "",
        },
        {
          id: "dept",
          sourceFieldId: "dept",
          source: "currentDepartment",
          operator: "equals",
          value: "",
        },
      ],
    }),
  ]);
  assert.deepEqual(
    (
      await h.request(
        `/definitions/${def.id}/records`,
        "GET",
        undefined,
        "editor",
      )
    ).map((r: any) => r.id),
    [own.record.id],
  );
  await h.request(
    `/records/${other.record.id}`,
    "GET",
    undefined,
    "editor",
    403,
  );
  const spec = structuredClone(org.spec);
  spec.assignments = spec.assignments.filter(
    (a: any) => a.userId !== editor.id,
  );
  await h.request("/organization", "PUT", {
    expectedRevision: org.revision,
    spec,
  });
  assert.deepEqual(
    await h.request(
      `/definitions/${def.id}/records`,
      "GET",
      undefined,
      "editor",
    ),
    [],
  );
  await h.request(`/records/${own.record.id}`, "GET", undefined, "editor", 403);
});
test("model publication reviews group dependencies and rejects a stale permission review", async () => {
  const def = await create();
  await save(def.id, [
    group("scope", {
      scope: "custom",
      filters: [
        {
          id: "f",
          sourceFieldId: "name",
          operator: "equals",
          source: "constant",
          value: "ready",
        },
      ],
    }),
  ]);
  const draft = await h.request(`/data-objects/${def.id}/draft`);
  const updated = await h.request(`/data-objects/${def.id}`, "PUT", {
    expectedRevision: draft.revision,
    title: "改名",
    model: draft.model,
  });
  const preview = await h.request(
    `/data-objects/${def.id}/publish-preview`,
    "POST",
    { expectedRevision: updated.revision },
    "admin",
    201,
  );
  assert.ok(
    preview.references.some(
      (ref: any) => ref.kind === "permission" && ref.title === "权限组 · scope",
    ),
  );
  await save(def.id, [group("scope", { fields: { name: "read" } })], false, 1);
  await h.request(
    `/data-objects/${def.id}/publish`,
    "POST",
    { expectedRevision: updated.revision, impactToken: preview.token },
    "admin",
    409,
  );
});
test("an inactive historical filter cannot be reactivated after its scope field is removed", async () => {
  const def = await create(),
    inactive = group("historical", {
      enabled: false,
      scope: "custom",
      filters: [
        {
          id: "f",
          sourceFieldId: "name",
          source: "constant",
          operator: "notEquals",
          value: "closed",
        },
      ],
    });
  await save(def.id, [inactive]);
  // 先发布移除控件的页面，再验证历史权限筛选本身是否阻止模型变更。
  const page = (await h.request(`/pages?definitionId=${def.id}`))[0];
  const currentPage = await h.request(`/pages/${page.id}/draft`);
  const nextPage = await h.request(`/pages/${page.id}`, "PUT", {
    ...currentPage,
    expectedRevision: currentPage.revision,
    schema: {
      ...currentPage.schema,
      controls: currentPage.schema.controls.filter(
        (control: any) => control.binding?.fieldId !== "name",
      ),
    },
  });
  await h.request(
    `/pages/${page.id}/publish`,
    "POST",
    { expectedRevision: nextPage.revision },
    "admin",
    201,
  );
  const update = await h.request(`/data-objects/${def.id}`, "PUT", {
    expectedRevision: 2,
    title: "历史范围",
    model: separateFormSchema(schema(
      field("amount", "number"),
      field("secret"),
      field("lines", "subform", { children: [field("a"), field("b")] }),
    ) as unknown as FormSchema).model,
  });
  const preview = await h.request(
    `/data-objects/${def.id}/publish-preview`,
    "POST",
    { expectedRevision: update.revision },
    "admin",
    201,
  );
  await h.request(
    `/data-objects/${def.id}/publish`,
    "POST",
    { expectedRevision: update.revision, impactToken: preview.token },
    "admin",
    201,
  );
  await h.request(
    `/definitions/${def.id}/permission-groups`,
    "PUT",
    {
      expectedRevision: 1,
      mode: "groups",
      allowMerged: false,
      groups: [{ ...inactive, enabled: true }],
    },
    "admin",
    400,
  );
  assert.equal(
    (await h.request(`/definitions/${def.id}/permission-groups`)).revision,
    1,
  );
});
