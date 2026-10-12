import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { FormSchema, MigrationIdentityChoice } from "@platform/contracts";
import { migrateAccess } from "../src/modules/migrations/migration-access";
import { field, schema } from "./helpers";
const model = () =>
  schema(
    field("note"),
    field("owner", "member"),
    field("department", "department"),
    field("lines", "subform", { children: [field("quantity", "number")] }),
  ) as unknown as FormSchema;
const choices = (): MigrationIdentityChoice[] => [
  {
    kind: "member",
    sourceId: "employee-old",
    mode: "existing",
    targetId: randomUUID(),
  },
  {
    kind: "department",
    sourceId: "department-old",
    mode: "existing",
    targetId: randomUUID(),
  },
  {
    kind: "role",
    sourceId: "role-old",
    mode: "historical",
    targetId: randomUUID(),
  },
];
const group = (extra: any = {}) => ({
  id: "g",
  name: "明细编辑",
  enabled: true,
  archived: false,
  identities: ["employee-old", "department-old", "role-old"],
  actions: ["view", "edit", "export", "print"],
  scope: "department",
  fields: { lines: "edit", quantity: "read", note: "hidden" },
  filters: [],
  ...extra,
});
const config = (groups = [group()]): any => ({
  membersEnabled: true,
  publicEnabled: false,
  allowMerged: false,
  filling: {
    enabled: false,
    startsAt: "2025-01-01T08:30:00+08:00",
    endsAt: "2025-02-01T17:00:00+08:00",
    limit: 50,
    allowRepeat: false,
  },
  groups,
});
const check = (raw: any, schemas = [model()], identities = choices()) => {
  const issues: any[] = [];
  return {
    ...migrateAccess(
      "form",
      raw,
      schemas,
      identities,
      (kind, message, groupId, fieldId) =>
        issues.push({ kind, message, groupId, fieldId }),
    ),
    issues,
  };
};
test("keeps group identities, action fields, archived state and original collection settings without flattening", () => {
  const identities = choices(),
    raw = config([
      group(),
      group({
        id: "old-group",
        enabled: false,
        archived: true,
        actions: ["create"],
        fields: {},
      }),
    ]),
    before = structuredClone(raw);
  const result = check(raw, [model()], identities);
  assert.deepEqual(result.issues, []);
  assert.equal(result.summary.executionReady, false);
  assert.deepEqual(raw, before);
  assert.deepEqual(result.config!.filling, raw.filling);
  assert.equal(result.config!.allowMerged, false);
  assert.equal(result.config!.membersEnabled, true);
  assert.equal(result.config!.publicEnabled, false);
  assert.equal(result.config!.selectionMode, "explicit-or-allowed-merge");
  assert.equal(result.config!.actionFieldMode, "same-record-scoped-group");
  assert.equal(
    result.config!.creationFieldMode,
    "published-page-and-start-node",
  );
  const saved = result.config!.groups;
  assert.deepEqual(
    saved.map((g) => g.id),
    ["g", "old-group"],
  );
  assert.deepEqual(
    saved[0].fields,
    Object.assign(Object.create(null), raw.groups[0].fields),
  );
  assert.deepEqual(saved[0].actions, raw.groups[0].actions);
  assert.equal(saved[0].departmentBasis, "record-created");
  assert.equal(saved[0].departmentIncludesChildren, false);
  assert.deepEqual(
    saved[0].subjects.map((s) => s.id),
    identities.map((i) => i.targetId),
  );
  assert.equal(saved[0].subjects[1].includeChildren, true);
  assert.equal(saved[0].subjects[2].historical, true);
  assert.deepEqual(saved[1].actions, ["create"]);
  assert.equal(saved[1].enabled, false);
  assert.equal(saved[1].archived, true);
  assert.equal(result.summary.groups[0].historicalSubjects, 1);
});
test("missing optional top-level settings retain the old defaults", () => {
  const result = check({});
  assert.equal(result.config!.membersEnabled, false);
  assert.equal(result.config!.publicEnabled, true);
  assert.equal(result.config!.allowMerged, true);
  assert.deepEqual(result.config!.filling, {
    enabled: true,
    startsAt: "",
    endsAt: "",
    limit: 0,
    allowRepeat: true,
  });
});
test("permissions on historical-only fields are retained; unknown references block the whole access configuration", () => {
  const raw = config([group({ fields: { oldOnly: "read" } })]);
  assert.ok(
    check(raw, [model(), schema(field("oldOnly")) as unknown as FormSchema])
      .config,
  );
  const bad = check(
    config([group(), group({ id: "bad", fields: { missing: "read" } })]),
  );
  assert.equal(bad.config, undefined);
  assert.equal(bad.summary.groups[0].checked, true);
  assert.equal(bad.summary.groups[1].checked, false);
  assert.equal(bad.issues[0].fieldId, "missing");
});
test("identity filter constants are mapped by kind, while literals and runtime sources remain intact and private", () => {
  const identities = choices(),
    filters = [
      {
        id: "f1",
        sourceFieldId: "owner",
        source: "constant",
        operator: "equals",
        value: "employee-old",
      },
      {
        id: "f2",
        sourceFieldId: "department",
        source: "constant",
        operator: "notEquals",
        value: "department-old",
      },
      {
        id: "f3",
        sourceFieldId: "note",
        source: "constant",
        operator: "contains",
        value: "内部筛选\n第二行",
      },
      {
        id: "f4",
        sourceFieldId: "department",
        source: "currentDepartment",
        operator: "equals",
        value: "",
      },
      {
        id: "f5",
        sourceFieldId: "owner",
        source: "currentUser",
        operator: "equals",
        value: "",
      },
    ];
  const result = check(
    config([group({ scope: "custom", filters })]),
    [model()],
    identities,
  );
  assert.deepEqual(result.issues, []);
  assert.equal(
    result.config!.groups[0].filters[0].value,
    identities[0].targetId,
  );
  assert.equal(
    result.config!.groups[0].filters[1].value,
    identities[1].targetId,
  );
  assert.deepEqual(result.config!.groups[0].filters.slice(2), filters.slice(2));
  assert.ok(!JSON.stringify(result.summary).includes("内部筛选"));
  assert.ok(!JSON.stringify(result.summary).includes(identities[0].targetId!));
});
test("unresolved or ambiguous subjects cannot become a partial policy, including inactive groups", () => {
  for (const identities of [
    choices().map((i) => ({ ...i, mode: "unresolved" as const })),
    [
      ...choices(),
      {
        kind: "role" as const,
        sourceId: "employee-old",
        mode: "existing" as const,
        targetId: randomUUID(),
      },
    ],
  ]) {
    const result = check(
      config([group({ enabled: false, archived: true })]),
      [model()],
      identities,
    );
    assert.equal(result.config, undefined);
    assert.equal(result.summary.checked, false);
    assert.ok(
      result.issues.some((i) => i.kind === "mapping" && i.groupId === "g"),
    );
  }
});
test("unresolved organization filter constants produce mapping issues without echoing constants", () => {
  const result = check(
    config([
      group({
        scope: "custom",
        filters: [
          {
            id: "f",
            sourceFieldId: "owner",
            source: "constant",
            operator: "equals",
            value: "secret-unknown-member",
          },
        ],
      }),
    ]),
  );
  assert.equal(result.config, undefined);
  assert.ok(
    result.issues.some((i) => i.kind === "mapping" && i.fieldId === "owner"),
  );
  assert.ok(!JSON.stringify(result.issues).includes("secret-unknown-member"));
});
test("invalid groups and unknown rules never widen scope or get silently discarded", () => {
  const cases = [
    group({ scope: "invalid" }),
    group({ actions: ["edit"] }),
    group({ actions: ["view", "view"] }),
    group({ actions: ["view", "execute"] }),
    group({ scope: "custom", filters: [] }),
    group({ name: "" }),
    group({ identities: [] }),
    group({ fields: { note: "owner" } }),
    group({ futureRule: false }),
    group({
      filters: [
        {
          id: "f",
          sourceFieldId: "quantity",
          operator: "notEmpty",
          source: "constant",
          value: "",
        },
      ],
    }),
    group({
      filters: [
        {
          id: "f",
          sourceFieldId: "note",
          operator: "equals",
          source: "field",
          value: "note",
        },
      ],
    }),
    group({
      filters: [
        {
          id: "f",
          sourceFieldId: "owner",
          operator: "contains",
          source: "constant",
          value: "employee-old",
        },
      ],
    }),
  ];
  for (const bad of cases) {
    const result = check(config([bad]));
    assert.equal(result.config, undefined, JSON.stringify(bad));
    assert.equal(result.summary.checked, false);
    assert.ok(result.issues.length);
  }
  assert.equal(
    check(config([group({ scope: "bad" })])).summary.groups[0].scope,
    null,
  );
});
test("ambiguous historical organization types cannot reinterpret filter constants", () => {
  const raw = config([
    group({
      filters: [
        {
          id: "f",
          sourceFieldId: "owner",
          operator: "equals",
          source: "constant",
          value: "employee-old",
        },
      ],
    }),
  ]);
  for (const otherType of ["text", "department"])
    assert.equal(
      check(raw, [
        model(),
        schema(field("owner", otherType)) as unknown as FormSchema,
      ]).config,
      undefined,
    );
});
test("duplicate group IDs, oversized lists and malformed collection settings block rather than truncate", () => {
  const duplicate = check(config([group(), group()]));
  assert.equal(duplicate.config, undefined);
  assert.equal(
    duplicate.summary.groups.every((g) => !g.checked),
    true,
  );
  const cases = [
    config(Array.from({ length: 101 }, (_, i) => group({ id: `g-${i}` }))),
    { ...config(), membersEnabled: "yes" },
    { ...config(), filling: { limit: 1.1 } },
    { ...config(), filling: { startsAt: "2025-02-01", endsAt: "2025-01-01" } },
    { ...config(), customRootRule: true },
    null,
  ];
  for (const raw of cases) {
    const result = check(raw);
    assert.equal(result.config, undefined);
    assert.equal(result.summary.checked, false);
    assert.ok(result.issues.length);
  }
  assert.equal(check(null).summary.membersEnabled, null);
});

test("runtime identity sources cannot silently compare new IDs against unconverted text or a different identity kind", () => {
  for (const sourceFieldId of ["note", "department"]) {
    const result = check(
      config([
        group({
          filters: [
            {
              id: "f",
              sourceFieldId,
              operator: "equals",
              source: "currentUser",
              value: "",
            },
          ],
        }),
      ]),
    );
    assert.equal(result.config, undefined);
    assert.ok(result.issues.some((i) => i.message.includes("身份类型不一致")));
  }
});
test("refuses to activate a native group when local member import execution has not been migrated", () => {
  const raw = config([group({ actions: ["view", "import"] })]),
    before = JSON.stringify(raw),
    result = check(raw);
  assert.equal(result.summary.checked, false);
  assert.equal(result.config, undefined);
  assert.ok(result.issues.some((x) => x.message.includes("未支持的操作")));
  assert.equal(JSON.stringify(raw), before);
});
