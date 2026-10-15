import { seedWorkspace, newAccessGroup } from "./fixtures/workspace";
// @vitest-environment jsdom
// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp, h, nextTick, reactive } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createMemoryHistory, createRouter } from "vue-router";
import {
  identifySubformRows,
  subformOperationErrors,
  newSubformPermissions,
  subformPermissions,
} from "@platform/contracts";
import {
  copy,
  createField,
  emptySchema,
  parseSchema,
  type FormValues,
} from "../src/domain/form";
import {
  defaultAccess,
  memberSchema,
  } from "../src/domain/access";
import {
  newForm,
  type FormEntry,
} from "../src/domain/workspace";

import FormRuntime from "../src/features/forms/components/FormRuntime.vue";
import FormFields from "../src/features/forms/components/FormFields.vue";
let pinia = createPinia();
const cleanup: (() => void)[] = [];
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  pinia = createPinia();
  setActivePinia(pinia);
});
afterEach(() => {
  cleanup.splice(0).forEach((fn) => fn());
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});
function fixture() {
  const schema = emptySchema();
  schema.settings.cacheDraft = false;
  schema.fields = [
    createField("subform", {
      id: "lines",
      label: "明细",
      children: [
        createField("text", { id: "item", label: "商品" }),
        createField("number", { id: "qty", label: "数量", defaultValue: 7 }),
      ],
      defaultRows: [
        { item: "A", qty: 11 },
        { item: "B", qty: 22 },
      ],
    }),
  ];
  const baseline = identifySubformRows(schema.fields, {
    lines: copy(schema.fields[0]!.defaultRows!),
  });
  return { schema, field: schema.fields[0]!, baseline };
}
async function mount(component: any, props: Record<string, unknown>) {
  const host = document.createElement("div");
  document.body.append(host);
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/", component: { render: () => null } }],
  });
  await router.push("/");
  await router.isReady();
  const app = createApp({ render: () => h(component, props) });
  app.use(pinia).use(router).mount(host);
  cleanup.push(() => app.unmount());
  await nextTick();
  return host;
}
function memberFixture() {
  const { schema, field, baseline } = fixture(),
    data = seedWorkspace(),
    form = newForm("oa", "行权限验收"),
    group = newAccessGroup(schema, "manage");
  group.identities = ["zhang"];
  form.schema = copy(schema);
  form.published = {
    version: 1,
    title: form.title,
    schema: copy(schema),
    workflow: copy(form.workflow),
    publishedAt: "2026-10-11",
  };
  form.versions = [copy(form.published)];
  data.forms.push(form);
  data.formAccess = {
    ...data.formAccess,
    [form.id]: { ...defaultAccess(), membersEnabled: true, groups: [group] },
  };
  const entry: FormEntry = {
    id: "permission-entry",
    formId: form.id,
    definitionVersion: 1,
    status: "submitted",
    createdBy: "zhang",
    createdAt: "2026-10-11",
    values: copy(baseline),
    history: [],
  };
  data.entries.push(entry);
  return { schema, field, baseline, data, form, group, entry };
}
it("creates four enabled permissions but does not expand historical insertion when parsing", () => {
  const { schema, field } = fixture();
  expect(field.subformPermissions).toEqual(newSubformPermissions());
  delete field.subformPermissions;
  const parsed = parseSchema(schema).fields[0]!;
  expect(parsed.subformPermissions).toBeUndefined();
  expect(subformPermissions(parsed.subformPermissions)).toEqual({
    ...newSubformPermissions(),
    insert: false,
  });
});
it("does not add row permission metadata to forms without subforms", () => {
  const schema = emptySchema();
  schema.fields = [createField("text", { id: "name" })];
  expect(
    Object.hasOwn(newAccessGroup(schema, "manage"), "subformPermissions"),
  ).toBe(false);
});
it.each([
  ["add", { lines: [{ _rowId: "new", item: "C", qty: 0 }] }, "不可新增或插入"],
  ["insert", null, "不可插入"],
  ["editExisting", null, "不可编辑已有"],
  ["deleteExisting", { lines: [] }, "不可删除已有"],
] as const)(
  "enforces %s in shared value replacement",
  (operation, input, message) => {
    const { field, baseline } = fixture();
    field.subformPermissions = {
      ...newSubformPermissions(),
      [operation]: false,
    };
    let before = baseline,
      next: FormValues = input || {};
    if (operation === "add") {
      before = { lines: [] };
      field.subformPermissions.insert = false;
    }
    if (operation === "insert")
      next = {
        lines: [
          (baseline.lines as FormValues[])[0],
          { _rowId: "new", item: "C", qty: 0 },
          (baseline.lines as FormValues[])[1],
        ],
      };
    if (operation === "editExisting")
      next = {
        lines: [
          { ...(baseline.lines as FormValues[])[0], qty: 99 },
          (baseline.lines as FormValues[])[1],
        ],
      };
    expect(
      subformOperationErrors([field], before, next, baseline)[0]?.message,
    ).toContain(message);
    expect(baseline.lines).toHaveLength(2);
  },
);
it("keeps hand-added rows editable and removable while generated rows are protected", () => {
  const { field, baseline } = fixture();
  field.subformPermissions = {
    add: true,
    insert: false,
    editExisting: false,
    deleteExisting: false,
  };
  const before = {
    lines: [
      ...(baseline.lines as FormValues[]),
      { _rowId: "manual", item: "C", qty: 0 },
    ],
  };
  expect(
    subformOperationErrors(
      [field],
      before,
      {
        lines: [
          ...(baseline.lines as FormValues[]),
          { _rowId: "manual", item: "D", qty: 3 },
        ],
      },
      baseline,
    ),
  ).toEqual([]);
  expect(subformOperationErrors([field], before, baseline, baseline)).toEqual(
    [],
  );
});
it("keeps record grants independent from filling switches, with parents and actions clamped first", () => {
  const { schema, group } = memberFixture();
  schema.fields[0]!.subformPermissions = {
    add: false,
    insert: false,
    editExisting: false,
    deleteExisting: false,
  };
  group.subformPermissions = { lines: newSubformPermissions() };
  expect(
    memberSchema(schema, [group], true).fields[0]!.subformPermissions,
  ).toEqual(newSubformPermissions());
  group.fields.lines = "read";
  expect(
    Object.values(
      memberSchema(schema, [group], true).fields[0]!.subformPermissions!,
    ),
  ).toEqual([false, false, false, false]);
  group.fields.lines = "edit";
  group.actions = ["view"];
  expect(
    Object.values(
      memberSchema(schema, [group], true).fields[0]!.subformPermissions!,
    ),
  ).toEqual([false, false, false, false]);
});
it("rejects ambiguous old row replacements when restricted row operations cannot be identified", () => {
  const { field, baseline } = fixture();
  field.subformPermissions!.insert = false;
  const rows = copy(baseline.lines as FormValues[]).map(
    ({ _rowId, ...value }) => value,
  );
  rows.splice(1, 0, { item: "C", qty: 0 });
  expect(
    subformOperationErrors([field], baseline, { lines: rows })[0]?.message,
  ).toContain("重新打开记录");
  expect(
    subformOperationErrors([field], baseline, {
      lines: (baseline.lines as FormValues[]).map(
        ({ _rowId, ...value }) => value,
      ),
    }),
  ).toEqual([]);
});
it("renders generated rows readonly and new rows editable with their own delete control", async () => {
  const { schema, field } = fixture();
  field.subformPermissions = {
    add: true,
    insert: false,
    editExisting: false,
    deleteExisting: false,
  };
  const host = await mount(FormRuntime, {
    schema,
    formId: "test",
  });
  expect(
    host.querySelector<HTMLInputElement>('[aria-label="明细 第1行 商品"]')!
      .disabled,
  ).toBe(true);
  expect(host.querySelectorAll('[aria-label^="删除明细"]').length).toBe(0);
  host.querySelector<HTMLButtonElement>(".subform-add")!.click();
  await nextTick();
  expect(
    host.querySelector<HTMLInputElement>('[aria-label="明细 第3行 商品"]')!
      .disabled,
  ).toBe(false);
  expect(host.querySelectorAll('[aria-label^="删除明细"]').length).toBe(1);
});
it("copies or inserts with a new identity and leaves readonly columns at their defaults", async () => {
  const { schema, field, baseline } = fixture();
  field.children[1]!.editable = false;
  const values = reactive(copy(baseline));
  const host = await mount(FormFields, {
    schema,
    fields: schema.fields,
    values,
    existingRows: baseline,
    onChange: (id: string, value: unknown) => (values[id] = value),
  });
  host
    .querySelector<HTMLButtonElement>('[aria-label="明细第1行操作"]')!
    .click();
  await nextTick();
  const button = Array.from(
    document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
  ).find((button) => button.textContent?.trim() === "复制到下一行")!;
  button.click();
  await nextTick();
  const rows = values.lines as FormValues[];
  expect(rows).toHaveLength(3);
  expect(rows[1]).toMatchObject({ item: "A", qty: 7 });
  expect(rows[1]!._rowId).not.toBe(rows[0]!._rowId);
  expect(rows[2]!._rowId).toBe((baseline.lines as FormValues[])[1]!._rowId);
});
it("lets an insertion-only empty subform create and remove its first manual row", async () => {
  const { schema, field } = fixture();
  field.defaultRows = [];
  field.subformPermissions = {
    add: false,
    insert: true,
    editExisting: false,
    deleteExisting: false,
  };
  const host = await mount(FormRuntime, {
    schema,
    formId: "empty-insert",
  });
  const insert = host.querySelector<HTMLButtonElement>(".subform-add")!;
  expect(insert.textContent).toContain("插入明细");
  insert.click();
  await nextTick();
  expect(
    host.querySelector<HTMLInputElement>('[aria-label="明细 第1行 商品"]')!
      .disabled,
  ).toBe(false);
  expect(host.querySelector(".subform-add")).toBeNull();
  host
    .querySelector<HTMLButtonElement>('[aria-label="删除明细第1行"]')!
    .click();
  await nextTick();
  expect(host.querySelector(".subform-add")!.textContent).toContain("插入明细");
});
