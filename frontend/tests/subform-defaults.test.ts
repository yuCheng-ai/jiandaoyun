// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from "vitest";
import { createApp, h, nextTick, reactive } from "vue";
import { createPinia } from "pinia";
import { composeFormSchema, separateFormSchema } from "@platform/contracts";
import {
  createField,
  copy,
  duplicateField,
  emptySchema,
  parseSchema,
  defaultValues,
  type FormValues,
} from "../src/domain/form";
import { newForm, seedWorkspace } from "../src/domain/workspace";
import {
  linkedDefault,
  runtimeDefaults,
  applyFieldChange,
} from "../src/domain/relations";
import { defaultLinkErrors } from "../src/domain/fieldValidation";
import {
  memberContext,
  newAccessGroup,
  defaultAccess,
  prepareMemberCreate,
  prepareMemberUpdate,
} from "../src/domain/access";
import { useWorkspaceStore } from "../src/stores/workspace";
import { WORKSPACE_KEY } from "../src/repositories/workspaceRepository";
import FieldInspector from "../src/features/forms/components/FieldInspector.vue";

const cleanups: (() => void)[] = [];
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem(WORKSPACE_KEY, JSON.stringify(seedWorkspace()));
});
afterEach(() => {
  cleanups.splice(0).forEach((f) => f());
  document.body.innerHTML = "";
});
const flush = async () => {
  for (let i = 0; i < 4; i++) await nextTick();
};
function fixture() {
  const data = seedWorkspace(),
    source = newForm("oa", "合成物料清单"),
    target = newForm("oa", "合成采购单");
  source.id = "source";
  target.id = "target";
  const sourceRows = createField("subform", {
    id: "materials",
    label: "物料明细",
    children: [
      createField("text", { id: "material", label: "物料" }),
      createField("number", { id: "price", label: "单价" }),
      createField("select", {
        id: "category",
        label: "类别",
        options: [{ id: "remote-parts", label: "零件" }],
      }),
    ],
  });
  source.schema.fields = [
    createField("text", { id: "device", label: "设备" }),
    sourceRows,
  ];
  source.published = {
    version: 1,
    title: source.title,
    schema: copy(source.schema),
    workflow: copy(source.workflow),
    publishedAt: "2026-10-01",
  };
  source.versions = [copy(source.published)];
  const rows = createField("subform", {
    id: "lines",
    label: "采购明细",
    children: [
      createField("text", { id: "name", label: "物料" }),
      createField("number", { id: "amount", label: "单价" }),
      createField("select", {
        id: "kind",
        label: "类别",
        options: [{ id: "local-parts", label: "零件" }],
      }),
      createField("number", { id: "qty", label: "数量", defaultValue: 99 }),
    ],
    defaultLink: {
      enabled: true,
      formId: source.id,
      fieldId: sourceRows.id,
      match: "all",
      filters: [
        {
          id: "f",
          sourceFieldId: "device",
          operator: "equals",
          source: "field",
          value: "selected",
        },
      ],
      mappings: [
        { sourceFieldId: "material", targetFieldId: "name" },
        { sourceFieldId: "price", targetFieldId: "amount" },
        { sourceFieldId: "category", targetFieldId: "kind" },
      ],
    },
  });
  target.schema.fields = [
    createField("text", { id: "selected", label: "设备", defaultValue: "A" }),
    rows,
  ];
  target.published = {
    version: 1,
    title: target.title,
    schema: copy(target.schema),
    workflow: copy(target.workflow),
    publishedAt: "2026-10-02",
  };
  target.versions = [copy(target.published)];
  data.forms.push(source, target);
  data.entries.push({
    id: "source-a",
    formId: source.id,
    definitionVersion: 1,
    status: "submitted",
    createdAt: "2026-10-01",
    history: [],
    values: {
      device: "A",
      materials: [
        { material: "合成螺栓", price: 0, category: "remote-parts" },
        { material: "合成支架", price: 12.5, category: "remote-parts" },
      ],
    },
  });
  data.entries.push({
    id: "source-b",
    formId: source.id,
    definitionVersion: 1,
    status: "submitted",
    createdAt: "2026-10-02",
    history: [],
    values: {
      device: "B",
      materials: [
        { material: "合成面板", price: 20, category: "remote-parts" },
      ],
    },
  });
  return { data, source, target, rows };
}
it("maps whole rows by stable IDs, translates choice IDs, clears unassigned cells and reacts to the root condition", () => {
  const { data, target, rows } = fixture();
  expect(defaultLinkErrors(rows, target.schema.fields, data)).toEqual([]);
  const values = runtimeDefaults(target.schema.fields, data);
  expect(values.lines).toEqual([
    { name: "合成螺栓", amount: 0, kind: "local-parts", qty: "" },
    { name: "合成支架", amount: 12.5, kind: "local-parts", qty: "" },
  ]);
  (values.lines as FormValues[])[0]!.qty = 4;
  expect(
    (
      applyFieldChange(target.schema.fields, values, "selected", "B", data)
        .lines as FormValues[]
    )[0],
  ).toEqual({ name: "合成面板", amount: 20, kind: "local-parts", qty: "" });
  expect(linkedDefault(rows, data, { selected: "missing" })).toEqual([]);
  expect(
    (
      data.entries.find((e) => e.id === "source-a")!.values
        .materials as FormValues[]
    )[0],
  ).not.toHaveProperty("qty");
});
it("keeps empty source rows and optional empty cells while honoring explicit read projections", () => {
  const { data, rows } = fixture();
  const source = data.entries.find((e) => e.id === "source-a")!;
  (source.values.materials as FormValues[]).push({});
  const result = linkedDefault(rows, data, { selected: "A" }) as FormValues[];
  expect(result).toHaveLength(3);
  expect(result[2]).toEqual({ name: "", amount: "", kind: "", qty: "" });
  (source.values.materials as FormValues[])[0]!.price = "";
  (source.values.materials as FormValues[])[0]!.category = "";
  expect(
    (linkedDefault(rows, data, { selected: "A" }) as FormValues[])[0],
  ).toEqual({
    name: "合成螺栓",
    amount: "",
    kind: "",
    qty: "",
  });
  (source.values.materials as FormValues[])[0]!.price = "无效数字";
  expect(linkedDefault(rows, data, { selected: "A" })).toEqual([]);
  delete (source.values.materials as FormValues[])[0]!.price;
  expect(
    (linkedDefault(rows, data, { selected: "A" }) as FormValues[])[0]!.amount,
  ).toBe("");
  source.readableFieldIds = ["device", "materials", "material", "category"];
  expect(linkedDefault(rows, data, { selected: "A" })).toEqual([]);
});
it("never fills unreadable source columns or stale historical fields and excludes drafts/deleted records", () => {
  const { data, source, rows } = fixture();
  expect(
    linkedDefault(rows, memberContext(data, "wang"), { selected: "A" }),
  ).toEqual([]);
  const group = newAccessGroup(source.schema);
  group.identities = ["wang"];
  data.formAccess = {
    [source.id]: { ...defaultAccess(), membersEnabled: true, groups: [group] },
  };
  expect(
    linkedDefault(rows, memberContext(data, "wang"), { selected: "A" }),
  ).toHaveLength(2);
  group.fields.price = "hidden";
  expect(
    linkedDefault(rows, memberContext(data, "wang"), { selected: "A" }),
  ).toEqual([]);
  group.fields.price = "read";
  source.versions[0]!.schema.fields[1]!.children[1]!.type = "text";
  expect(linkedDefault(rows, data, { selected: "A" })).toEqual([]);
  source.versions[0]!.schema.fields[1]!.children[1]!.type = "number";
  data.entries.find((e) => e.id === "source-a")!.status = "draft";
  expect(linkedDefault(rows, data, { selected: "A" })).toEqual([]);
  data.entries.find((e) => e.id === "source-a")!.status = "submitted";
  data.entries.find((e) => e.id === "source-a")!.deletedAt = "2026-10-03";
  expect(linkedDefault(rows, data, { selected: "A" })).toEqual([]);
});
it("preserves custom defaults and missing-cell defaults without sharing rows or rewriting older definitions", () => {
  const { data, target, rows } = fixture();
  rows.defaultLink!.enabled = false;
  rows.defaultRows = [
    { name: "合成默认明细", amount: 0, qty: 2 },
    { name: "第二行" },
  ];
  expect(
    (defaultValues(target.schema.fields).lines as FormValues[])[1]!.qty,
  ).toBe(99);
  const initial = runtimeDefaults(target.schema.fields, data);
  (initial.lines as FormValues[])[0]!.qty = 3;
  expect(
    (runtimeDefaults(target.schema.fields, data).lines as FormValues[])[0]!.qty,
  ).toBe(2);
  expect(rows.defaultRows[0]!.qty).toBe(2);
  const split = separateFormSchema(target.schema);
  expect(split.model.fields[1]!.settings.defaultRows).toEqual(rows.defaultRows);
  expect(composeFormSchema(split.model, split.page)).toEqual(target.schema);
  expect(parseSchema(target.schema)).toEqual(target.schema);
  expect(target.versions[0]!.schema.fields[1]).not.toHaveProperty(
    "defaultRows",
  );
});
it("remaps local default cells and mapping targets on copy but keeps external source identity", () => {
  const { rows } = fixture();
  rows.defaultRows = [{ name: "合成默认", qty: 0 }];
  const clone = duplicateField(rows);
  expect(clone.defaultRows).toEqual([
    { [clone.children[0]!.id]: "合成默认", [clone.children[3]!.id]: 0 },
  ]);
  expect(clone.defaultLink!.mappings![0]).toEqual({
    sourceFieldId: "material",
    targetFieldId: clone.children[0]!.id,
  });
  for (const value of [null, {}, [null], [1], [[]]]) {
    const schema = emptySchema();
    schema.fields = [copy(rows)];
    (schema.fields[0] as any).defaultRows = value;
    expect(() => parseSchema(schema)).toThrow("子表默认明细格式无效");
  }
  const schema = emptySchema();
  schema.fields = [copy(rows)];
  (schema.fields[0]!.defaultLink as any).mappings = [{ sourceFieldId: 1 }];
  expect(() => parseSchema(schema)).toThrow("默认值联动配置无效");
});
it("rejects missing, duplicated and incompatible child mappings before publishing", () => {
  const { data, target, rows } = fixture();
  rows.defaultLink!.mappings = [];
  expect(defaultLinkErrors(rows, target.schema.fields, data)).toContain(
    "请添加需要联动的子字段",
  );
  rows.defaultLink!.mappings = [
    { targetFieldId: "amount", sourceFieldId: "material" },
  ];
  expect(defaultLinkErrors(rows, target.schema.fields, data)).toContain(
    "子字段联动对应已失效、重复或类型不匹配",
  );
  rows.defaultLink!.mappings = [
    { targetFieldId: "name", sourceFieldId: "material" },
    { targetFieldId: "name", sourceFieldId: "material" },
  ];
  expect(defaultLinkErrors(rows, target.schema.fields, data)).toContain(
    "子字段联动对应已失效、重复或类型不匹配",
  );
});
it("keeps manual adjustments after linked initialization during member create and record update", () => {
  const { data, source, target } = fixture();
  const values = runtimeDefaults(target.schema.fields, data);
  (values.lines as FormValues[])[0]!.qty = 4;
  expect(
    (prepareMemberCreate(target.schema, values, data).lines as FormValues[])[0]!
      .qty,
  ).toBe(4);
  const sourceGroup = newAccessGroup(source.schema);
  sourceGroup.identities = ["wang"];
  const group = newAccessGroup(target.schema, "manage");
  group.identities = ["wang"];
  group.actions.push("edit");
  data.formAccess = {
    [source.id]: {
      ...defaultAccess(),
      membersEnabled: true,
      groups: [sourceGroup],
    },
    [target.id]: { ...defaultAccess(), membersEnabled: true, groups: [group] },
  };
  const entry = {
    id: "request",
    formId: target.id,
    definitionVersion: 1,
    status: "submitted" as const,
    createdAt: "2026-10-03",
    history: [],
    values,
  };
  data.entries.push(entry);
  const incoming = applyFieldChange(
    target.schema.fields,
    values,
    "selected",
    "B",
    memberContext(data, "wang"),
  );
  (incoming.lines as FormValues[])[0]!.qty = 7;
  const update = prepareMemberUpdate(data, entry, "wang", group.id, incoming);
  expect(update.errors).toEqual([]);
  expect((update.values.lines as FormValues[])[0]).toMatchObject({
    name: "合成面板",
    qty: 7,
  });
  group.fields.qty = "read";
  const denied = prepareMemberUpdate(data, entry, "wang", group.id, incoming);
  expect(denied.errors.length).toBeGreaterThan(0);
});
it("fills dependent choices before evaluating row formulas regardless of whole-link mapping order", () => {
  const { data, source, target, rows } = fixture();
  const catalog = newForm("oa", "合成分类目录");
  catalog.id = "catalog";
  catalog.schema.fields = [
    createField("text", { id: "catalog_name" }),
    createField("text", { id: "catalog_kind" }),
  ];
  catalog.published = {
    version: 1,
    title: catalog.title,
    schema: copy(catalog.schema),
    workflow: copy(catalog.workflow),
    publishedAt: "2026-10-02",
  };
  data.forms.push(catalog);
  for (const [index, name] of ["合成螺栓", "合成支架", "合成面板"].entries())
    data.entries.push({
      id: `catalog-${index}`,
      formId: catalog.id,
      definitionVersion: 1,
      status: "submitted",
      createdAt: "2026-10-02",
      history: [],
      values: { catalog_name: name, catalog_kind: "零件" },
    });
  const kind = rows.children.find((f) => f.id === "kind")!;
  kind.choiceSource = {
    ...kind.choiceSource,
    mode: "form",
    formId: catalog.id,
    labelFieldId: "catalog_kind",
    filters: [
      {
        id: "by-material",
        sourceFieldId: "catalog_name",
        operator: "equals",
        source: "field",
        value: "name",
      },
    ],
  };
  target.schema.fields.push(
    createField("calculated", { id: "total", expression: "SUM({{amount}})" }),
  );
  const before = copy(data.entries.find((e) => e.formId === source.id)!.values);
  for (const reverse of [false, true]) {
    if (reverse) rows.defaultLink!.mappings!.reverse();
    const initial = runtimeDefaults(target.schema.fields, data);
    expect((initial.lines as FormValues[]).map((r) => r.kind)).toEqual([
      "catalog-0",
      "catalog-1",
    ]);
    expect(initial.total).toBe(12.5);
    const changed = applyFieldChange(
      target.schema.fields,
      initial,
      "selected",
      "B",
      data,
    );
    expect((changed.lines as FormValues[])[0]).toEqual({
      name: "合成面板",
      amount: 20,
      kind: "catalog-2",
      qty: "",
    });
    expect(changed.total).toBe(20);
    expect(changed).not.toHaveProperty("name");
    expect((changed.lines as FormValues[])[0]).not.toHaveProperty("selected");
  }
  expect(data.entries.find((e) => e.formId === source.id)!.values).toEqual(
    before,
  );
});
it("resolves department-scoped members before converting a whole linked row and rejects an invalid row atomically", () => {
  const { data, source, target, rows } = fixture();
  source.schema.fields[1]!.children.push(
    createField("department", { id: "source_department" }),
    createField("member", { id: "source_person" }),
  );
  source.published!.schema = copy(source.schema);
  source.versions = [copy(source.published!)];
  const department = createField("department", {
    id: "department",
    editable: false,
  });
  const person = createField("member", { id: "person" });
  person.organization.scope.mode = "fieldDepartment";
  person.organization.scope.fieldId = department.id;
  rows.children.push(person, department);
  rows.defaultLink!.mappings!.push(
    { sourceFieldId: "source_person", targetFieldId: person.id },
    { sourceFieldId: "source_department", targetFieldId: department.id },
  );
  const record = data.entries.find((e) => e.id === "source-a")!;
  Object.assign((record.values.materials as FormValues[])[0]!, {
    source_person: "wang",
    source_department: "engineering",
  });
  Object.assign((record.values.materials as FormValues[])[1]!, {
    source_person: "zhang",
    source_department: "product",
  });
  for (const reverse of [false, true]) {
    if (reverse) rows.defaultLink!.mappings!.reverse();
    const result = runtimeDefaults(target.schema.fields, data)
      .lines as FormValues[];
    expect(result.map((r) => [r.person, r.department])).toEqual([
      ["wang", "engineering"],
      ["zhang", "product"],
    ]);
  }
  (record.values.materials as FormValues[])[1]!.source_department =
    "engineering";
  const before = copy(record.values);
  expect(
    linkedDefault(rows, data, { selected: "A" }, target.schema.fields),
  ).toEqual([]);
  expect(record.values).toEqual(before);
});
it("initializes child attachment links after whole rows, retriggers them on root changes and preserves manual edits", () => {
  const { data, source, target, rows } = fixture();
  source.schema.fields.push(createField("file", { id: "source_files" }));
  source.published!.schema = copy(source.schema);
  source.versions = [copy(source.published!)];
  const files = (name: string) => [{ name, size: 2, type: "text/plain" }];
  data.entries.find((e) => e.id === "source-a")!.values.source_files =
    files("A.txt");
  data.entries.find((e) => e.id === "source-b")!.values.source_files =
    files("B.txt");
  rows.children.push(
    createField("file", {
      id: "attachments",
      defaultLink: {
        ...copy(rows.defaultLink!),
        fieldId: "source_files",
        mappings: undefined,
      },
    }),
  );
  target.schema.fields.push(createField("text", { id: "memo" }));
  const initial = runtimeDefaults(target.schema.fields, data);
  expect((initial.lines as FormValues[]).map((r) => r.attachments)).toEqual([
    files("A.txt"),
    files("A.txt"),
  ]);
  (initial.lines as FormValues[])[0]!.attachments = files("manual.txt");
  const unrelated = applyFieldChange(
    target.schema.fields,
    initial,
    "memo",
    "其他说明",
    data,
  );
  expect((unrelated.lines as FormValues[])[0]!.attachments).toEqual(
    files("manual.txt"),
  );
  const manual = applyFieldChange(
    target.schema.fields,
    initial,
    "lines",
    initial.lines,
    data,
  );
  expect((manual.lines as FormValues[])[0]!.attachments).toEqual(
    files("manual.txt"),
  );
  const changed = applyFieldChange(
    target.schema.fields,
    initial,
    "selected",
    "B",
    data,
  );
  expect((changed.lines as FormValues[])[0]).toMatchObject({
    name: "合成面板",
    amount: 20,
    attachments: files("B.txt"),
  });
  expect(
    applyFieldChange(target.schema.fields, changed, "selected", "missing", data)
      .lines,
  ).toEqual([]);
});
it("does not reload a linked subform when only inactive option/reference filters mention the changed input", () => {
  const { data, target, rows } = fixture();
  target.schema.fields.push(createField("text", { id: "memo" }));
  const dormant = {
    id: "unused",
    sourceFieldId: "device",
    operator: "equals" as const,
    source: "field" as const,
    value: "memo",
  };
  rows.choiceSource.filters = [dormant];
  rows.reference.filters = [dormant];
  const initial = runtimeDefaults(target.schema.fields, data);
  (initial.lines as FormValues[])[0]!.qty = 7;
  const changed = applyFieldChange(
    target.schema.fields,
    initial,
    "memo",
    "无关说明",
    data,
  );
  expect(changed.lines).toEqual(initial.lines);
  expect((changed.lines as FormValues[])[0]!.qty).toBe(7);
});
it("edits literal defaults only on confirmation and discards a cancelled dialog without changing the form", async () => {
  const pinia = createPinia(),
    store = useWorkspaceStore(pinia),
    { data, target, rows } = fixture();
  store.data = data;
  const schema = reactive(target.schema);
  schema.fields[1]!.defaultLink!.enabled = false;
  const field = schema.fields[1]!;
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({
    render: () =>
      h(FieldInspector, {
        field,
        schema,
        formId: target.id,
        manageSubform: true,
        onUpdate: (patch: any) => Object.assign(field, patch),
      }),
  });
  app.use(pinia);
  app.mount(host);
  cleanups.push(() => app.unmount());
  await flush();
  const click = async (label: string, root: Element = document.body) => {
    [...root.querySelectorAll("button")]
      .find((b) => b.textContent?.trim() === label)!
      .click();
    await flush();
  };
  await click("设置", host);
  await click("添加采购明细");
  const input = document.querySelector<HTMLInputElement>(
    'dialog input[aria-label="采购明细 第1行 物料"]',
  )!;
  input.value = "合成待取消";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await flush();
  await click("取消");
  expect(field.defaultRows).toBeUndefined();
  await click("放弃修改");
  expect(document.querySelector("dialog")).toBeNull();
  await click("设置", host);
  await click("添加采购明细");
  const value = document.querySelector<HTMLInputElement>(
    'dialog input[aria-label="采购明细 第1行 物料"]',
  )!;
  value.value = "合成默认明细";
  value.dispatchEvent(new Event("input", { bubbles: true }));
  await flush();
  await click("确定");
  expect(field.defaultRows![0]!.name).toBe("合成默认明细");
  expect(field.defaultRows![0]!.qty).toBe(99);
  expect(target.versions[0]!.schema.fields[1]).not.toHaveProperty(
    "defaultRows",
  );
});
it("keeps the field menu inside the shared dialog lifecycle and commits complete mappings only on confirmation", async () => {
  const pinia = createPinia(),
    store = useWorkspaceStore(pinia),
    { data, target } = fixture();
  store.data = data;
  const schema = reactive(target.schema),
    field = schema.fields[1]!;
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({
    render: () =>
      h(FieldInspector, {
        field,
        schema,
        formId: target.id,
        manageSubform: true,
        onUpdate: (patch: any) => Object.assign(field, patch),
      }),
  });
  app.use(pinia);
  app.mount(host);
  cleanups.push(() => app.unmount());
  await flush();
  const click = async (label: string) => {
    const root =
      document.querySelector('[role="menu"]') ||
      document.querySelector("dialog") ||
      host;
    [...root.querySelectorAll("button")]
      .find((b) => b.textContent?.trim() === label)!
      .click();
    await flush();
  };
  await click("数据联动设置");
  await click("添加子字段");
  expect(document.activeElement?.textContent).toContain("数量");
  document.activeElement!.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );
  await flush();
  expect(document.querySelector('[role="menu"]')).toBeNull();
  expect(document.querySelector("dialog")).not.toBeNull();
  expect(document.activeElement?.getAttribute("aria-label")).toBe(
    "添加联动子字段",
  );
  await click("添加子字段");
  await click("数量");
  expect(field.defaultLink!.mappings).toHaveLength(3);
  const selection = document.querySelector<HTMLSelectElement>(
    'dialog select[aria-label="联动子字段 数量"]',
  )!;
  expect(selection.value).toBe("");
  selection.value = "price";
  selection.dispatchEvent(new Event("change", { bubbles: true }));
  await flush();
  await click("取消");
  expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
  await click("放弃修改");
  expect(field.defaultLink!.mappings).toHaveLength(3);
  await click("数据联动设置");
  const remove = document.querySelector<HTMLButtonElement>(
    'button[aria-label="删除子字段对应 1"]',
  )!;
  remove.click();
  await flush();
  await click("添加子字段");
  await click("物料");
  expect(
    document.querySelector<HTMLSelectElement>(
      'dialog select[aria-label="联动子字段 物料"]',
    )!.value,
  ).toBe("material");
  await click("确定");
  expect(document.querySelector("dialog")).toBeNull();
  expect(field.defaultLink!.mappings!.at(-1)).toEqual({
    targetFieldId: "name",
    sourceFieldId: "material",
  });
  expect(
    target.versions[0]!.schema.fields[1]!.defaultLink!.mappings![0]!
      .targetFieldId,
  ).toBe("name");
});
