// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp, h, nextTick, reactive } from "vue";
import { createPinia } from "pinia";
import { createMemoryHistory, createRouter } from "vue-router";
import { IDBFactory } from "fake-indexeddb";
import { Blob as NodeBlob, File as NodeFile } from "node:buffer";
import {
  fileValueIssue,
  composeFormSchema,
  separateFormSchema,
  type FormValues,
  type FormField,
  type AddressValue,
} from "@platform/contracts";
import {
  copy,
  createField,
  duplicateField,
  parseSchema,
  validateValues,
} from "../src/domain/form";
import {
  applyFieldChange,
  defaultLinkLocalFields,
  linkedDefault,
  runtimeDefaults,
  matchesFilters,
} from "../src/domain/relations";
import {
  defaultLinkErrors,
  validateFieldConfiguration,
} from "../src/domain/fieldValidation";
import {
  memberContext,
  defaultAccess,
  newAccessGroup,
  prepareMemberUpdate,
} from "../src/domain/access";
import {
  seedWorkspace,
  newForm,
  type FormEntry,
  type FormRecord,
} from "../src/domain/workspace";
import { saveFiles, readFile } from "../src/repositories/fileRepository";
import { useWorkspaceStore } from "../src/stores/workspace";
import DefaultLinkInspector from "../src/features/forms/components/DefaultLinkInspector.vue";
import FieldInspector from "../src/features/forms/components/FieldInspector.vue";
import FormRuntime from "../src/features/forms/components/FormRuntime.vue";

vi.mock("../src/stores/workspace", () => ({ useWorkspaceStore: vi.fn() }));
function publish(form: FormRecord) {
  form.published = {
    version: 1,
    schema: copy(form.schema),
    workflow: copy(form.workflow),
    extensions: copy(form.extensions),
    title: form.title,
    publishedAt: "2026-10-01",
  };
  form.versions = [copy(form.published)];
}
function fixture() {
  const data = seedWorkspace(),
    source = newForm("oa", "产品资料"),
    target = newForm("oa", "产品领用");
  source.id = "source";
  target.id = "target";
  source.schema.fields = [
    createField("text", { id: "name", label: "产品" }),
    createField("number", { id: "amount" }),
    createField("file", { id: "files", label: "附件" }),
    createField("image", { id: "pictures", label: "图片" }),
  ];
  const product = createField("text", { id: "product", defaultValue: "A" });
  const attachment = createField("file", {
    id: "attachment",
    label: "附件",
    defaultLink: {
      enabled: true,
      formId: source.id,
      fieldId: "files",
      match: "all",
      filters: [
        {
          id: "condition",
          sourceFieldId: "name",
          operator: "equals",
          source: "field",
          value: "product",
        },
      ],
    },
  });
  target.schema.fields = [
    product,
    attachment,
    createField("text", { id: "note" }),
    createField("image", {
      id: "picture",
      defaultLink: { ...copy(attachment.defaultLink!), fieldId: "pictures" },
    }),
  ];
  publish(source);
  publish(target);
  data.forms = [source, target];
  const record = (id: string, name: string, time: string): FormEntry => ({
    id,
    formId: source.id,
    definitionVersion: 1,
    values: {
      name,
      amount: 1,
      files: [
        { id: `file_${id}`, name: `${id}.txt`, size: 4, type: "text/plain" },
      ],
      pictures: [],
    },
    createdAt: time,
    createdBy: "zhang",
    status: "submitted",
    history: [],
  });
  data.entries = [
    record("later", "A", "2026-10-02T00:00:00Z"),
    record("first", "A", "2026-10-01T00:00:00Z"),
    record("other", "B", "2026-10-03T00:00:00Z"),
  ];
  return { data, source, target, product, attachment, record };
}
let app: ReturnType<typeof createApp> | undefined;
const settle = async () => {
  for (let i = 0; i < 10; i++) await nextTick();
  await new Promise((r) => setTimeout(r, 10));
};
const control = <T extends HTMLElement>(label: string) =>
  document.querySelector<T>(`[aria-label="${label}"]`)!;
async function mount(
  render: Parameters<typeof createApp>[0],
  data: ReturnType<typeof fixture>["data"],
) {
  const store = reactive({
    data,
    get activeForms() {
      return this.data.forms.filter((f) => !f.archived);
    },
    notify: vi.fn(),
  });
  vi.mocked(useWorkspaceStore).mockReturnValue(store as any);
  document.body.innerHTML = '<div id="app"></div>';
  app = createApp(render);
  app.use(createPinia());
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/", component: { render: () => null } }],
  });
  app.use(router);
  await router.push("/");
  app.mount("#app");
  await settle();
}
function change(label: string, value: string) {
  const select = control<HTMLSelectElement>(label);
  select.value = value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
}
function click(text: string) {
  [...document.querySelectorAll<HTMLButtonElement>("button")]
    .find((b) => b.textContent?.trim() === text)!
    .click();
}
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => {
  app?.unmount();
  app = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

it("selects the earliest eligible submitted record, with all/any conditions and no result for missing inputs", () => {
  const { data, target, attachment } = fixture();
  expect(runtimeDefaults(target.schema.fields, data).attachment).toEqual(
    data.entries[1]!.values.files,
  );
  expect(linkedDefault(attachment, data, {})).toEqual([]);
  data.entries[1]!.status = "draft";
  expect(linkedDefault(attachment, data, { product: "A" })).toEqual(
    data.entries[0]!.values.files,
  );
  data.entries[0]!.deletedAt = "2026-10-04";
  expect(linkedDefault(attachment, data, { product: "A" })).toEqual([]);
  attachment.defaultLink!.filters.push({
    id: "other",
    sourceFieldId: "amount",
    operator: "equals",
    source: "constant",
    value: "1",
  });
  attachment.defaultLink!.match = "any";
  expect(linkedDefault(attachment, data, { product: "unknown" })).toEqual(
    data.entries[2]!.values.files,
  );
  attachment.defaultLink!.match = "all";
  expect(linkedDefault(attachment, data, { product: "unknown" })).toEqual([]);
});
it("updates only a changed dependency and keeps existing record values until that dependency changes", () => {
  const { data, target } = fixture();
  let values = runtimeDefaults(target.schema.fields, data);
  values.attachment = [{ name: "manual.txt", size: 4, type: "text/plain" }];
  values = applyFieldChange(target.schema.fields, values, "note", "说明", data);
  expect((values.attachment as any[])[0].name).toBe("manual.txt");
  values = applyFieldChange(target.schema.fields, values, "product", "B", data);
  expect(values.attachment).toEqual(data.entries[2]!.values.files);
  values = applyFieldChange(
    target.schema.fields,
    values,
    "product",
    "missing",
    data,
  );
  expect(values.attachment).toEqual([]);
  data.forms[0]!.schema.fields = [];
  expect(
    linkedDefault(target.schema.fields[1]!, data, { product: "A" }),
  ).toEqual(data.entries[1]!.values.files);
  data.forms[0]!.archived = true;
  expect(
    linkedDefault(target.schema.fields[1]!, data, { product: "A" }),
  ).toEqual([]);
});
it("keeps subform rows isolated, includes parent inputs, and remaps dependencies when copying a container", () => {
  const { data, attachment } = fixture();
  const rowField = copy(attachment);
  rowField.defaultLink!.filters[0]!.value = "item";
  const subform = createField("subform", {
    id: "lines",
    children: [createField("text", { id: "item" }), rowField],
  });
  const fields = [
    createField("text", { id: "parent" }),
    subform,
    createField("subform", {
      id: "otherRows",
      children: [createField("text", { id: "otherItem" })],
    }),
  ];
  expect(defaultLinkLocalFields(fields, rowField.id).map((f) => f.id)).toEqual([
    "parent",
    "item",
  ]);
  let rows: FormValues[] = [
    { item: "A", attachment: [] },
    { item: "B", attachment: [] },
  ];
  rows[0] = applyFieldChange(subform.children, rows[0]!, "item", "A", data);
  expect(rows[0]!.attachment).toEqual(data.entries[1]!.values.files);
  expect(rows[1]!.attachment).toEqual([]);
  rowField.defaultLink!.filters[0]!.value = "parent";
  expect(
    runtimeDefaults(subform.children, data, { parent: "B" }).attachment,
  ).toEqual(data.entries[2]!.values.files);
  const next = applyFieldChange(
    fields,
    { parent: "A", lines: [{ item: "", attachment: [] }] },
    "parent",
    "B",
    data,
  );
  expect((next.lines as FormValues[])[0]!.attachment).toEqual(
    data.entries[2]!.values.files,
  );
  rowField.defaultLink!.filters[0]!.value = "item";
  const duplicate = duplicateField(subform);
  expect(duplicate.children[1]!.defaultLink!.filters[0]!.value).toBe(
    duplicate.children[0]!.id,
  );
  expect(duplicate.children[1]!.defaultLink!.fieldId).toBe("files");
});
it("never obtains a record, result field or condition value outside the member's permitted context", () => {
  const { data, source, attachment } = fixture();
  expect(
    linkedDefault(attachment, memberContext(data, "wang"), { product: "A" }),
  ).toEqual([]);
  const access = defaultAccess();
  const group = newAccessGroup(source.schema);
  group.identities = ["wang"];
  access.membersEnabled = true;
  access.groups = [group];
  data.formAccess = { [source.id]: access };
  expect(
    linkedDefault(attachment, memberContext(data, "wang"), { product: "A" }),
  ).toEqual(data.entries[1]!.values.files);
  group.fields.files = "hidden";
  expect(
    linkedDefault(attachment, memberContext(data, "wang"), { product: "A" }),
  ).toEqual([]);
  group.fields.files = "read";
  group.fields.name = "hidden";
  attachment.defaultLink!.filters[0]!.operator = "notEquals";
  expect(
    linkedDefault(attachment, memberContext(data, "wang"), { product: "A" }),
  ).toEqual([]);
});
it("preserves explicit configuration, refuses malformed imports and protects compatibility projections", () => {
  const { data, target, attachment } = fixture();
  attachment.maxFileSize = 1;
  attachment.limitFileTypes = true;
  attachment.accept = ".pdf";
  target.schema.fields[3]!.uploadStyle = "list";
  expect(parseSchema(target.schema)).toEqual(target.schema);
  const split = separateFormSchema(target.schema);
  const composed = composeFormSchema(split.model, split.page);
  expect(composed.fields[1]!.defaultLink).toEqual(attachment.defaultLink);
  expect(composed.fields[1]!.maxFileSize).toBe(1);
  expect(composed.fields[3]!.uploadStyle).toBe("list");
  expect(validateFieldConfiguration(target.schema, data)).toEqual([]);
  attachment.defaultLink!.filters[0]!.sourceFieldId = "amount";
  expect(defaultLinkErrors(attachment, target.schema.fields, data)).toContain(
    "联动条件的引用字段已失效或类型不匹配",
  );
  attachment.defaultLink!.enabled = false;
  expect(defaultLinkErrors(attachment, target.schema.fields, data)).toEqual([]);
  const invalid = copy(target.schema);
  (invalid.fields[1]!.defaultLink!.filters as any) = [
    { id: "bad", source: "script" },
  ];
  expect(() => parseSchema(invalid)).toThrow("联动配置");
  delete attachment.defaultLink;
  expect(parseSchema(target.schema).fields[1]).not.toHaveProperty(
    "defaultLink",
  );
});
it("does not turn a default lookup into permission to update a protected result field", () => {
  const { data, source, target, record } = fixture();
  const sourceAccess = defaultAccess(),
    sourceGroup = newAccessGroup(source.schema);
  sourceGroup.identities = ["wang"];
  sourceAccess.membersEnabled = true;
  sourceAccess.groups = [sourceGroup];
  const targetAccess = defaultAccess(),
    group = newAccessGroup(target.schema, "manage");
  group.identities = ["wang"];
  group.fields.attachment = "read";
  targetAccess.membersEnabled = true;
  targetAccess.groups = [group];
  data.formAccess = { [source.id]: sourceAccess, [target.id]: targetAccess };
  const entry = record("saved", "A", "2026-10-04");
  entry.formId = target.id;
  entry.values = {
    product: "A",
    attachment: copy(data.entries[1]!.values.files),
    note: "",
    picture: [],
  };
  data.entries.push(entry);
  const updated = prepareMemberUpdate(data, entry, "wang", group.id, {
    product: "B",
  });
  expect(updated.errors).toContain(
    "字段联动会修改无编辑权限的字段，请联系管理员调整规则",
  );
  expect(entry.values.product).toBe("A");
  expect(entry.values.attachment).toEqual(data.entries[1]!.values.files);
});
it("a source-only not-empty condition does not require or react to a dormant local reference", () => {
  const { data, target, attachment } = fixture();
  attachment.defaultLink!.filters[0]!.operator = "notEmpty";
  attachment.defaultLink!.filters[0]!.value = "product";
  const saved = [{ name: "historic.txt", type: "text/plain", size: 4 }];
  const values = applyFieldChange(
    target.schema.fields,
    { product: "A", attachment: saved },
    "product",
    "B",
    data,
  );
  expect(values.attachment).toEqual(saved);
  attachment.defaultLink!.filters[0]!.value = "removed";
  const choice = createField("select", {
    choiceSource: {
      mode: "form",
      formId: "source",
      labelFieldId: "name",
      valueFieldId: "",
      filters: copy(attachment.defaultLink!.filters),
      sort: "none",
      deduplicate: true,
    },
  });
  target.schema.fields.push(choice);
  expect(validateFieldConfiguration(target.schema, data)).toEqual([]);
});
it("calculated conditions update the lookup in the same change, including row formulas using parent values", () => {
  const { data, source, target, attachment } = fixture();
  source.schema.fields[1] = createField("calculated", {
    id: "amount",
    expression: "1",
  });
  publish(source);
  data.entries[2]!.values.amount = 2;
  const input = createField("number", { id: "quantity", defaultValue: "1" }),
    total = createField("calculated", {
      id: "total",
      expression: "{{quantity}}",
    });
  attachment.defaultLink!.filters = [
    {
      id: "amount_filter",
      sourceFieldId: "amount",
      operator: "equals",
      source: "field",
      value: "total",
    },
  ];
  target.schema.fields = [input, total, attachment];
  expect(validateFieldConfiguration(target.schema, data)).toEqual([]);
  const values = applyFieldChange(
    target.schema.fields,
    runtimeDefaults(target.schema.fields, data),
    "quantity",
    2,
    data,
  );
  expect(values.total).toBe(2);
  expect(values.attachment).toEqual(data.entries[2]!.values.files);
  const lines = createField("subform", {
    id: "lines",
    children: [copy(attachment)],
  });
  const parentChanged = applyFieldChange(
    [input, total, lines],
    {
      quantity: 1,
      total: 1,
      lines: [{ attachment: copy(data.entries[1]!.values.files) }],
    },
    "quantity",
    2,
    data,
  );
  expect((parentChanged.lines as FormValues[])[0]!.attachment).toEqual(
    data.entries[2]!.values.files,
  );
  total.expression = "{{parent}} + {{quantity}}";
  const rowDefaults = runtimeDefaults(target.schema.fields, data, {
    parent: 1,
  });
  expect(rowDefaults.total).toBe(2);
  expect(rowDefaults.attachment).toEqual(data.entries[2]!.values.files);
  const changed = applyFieldChange(
    target.schema.fields,
    rowDefaults,
    "quantity",
    0,
    data,
    { parent: 1 },
  );
  expect(changed.total).toBe(1);
  expect(changed.attachment).toEqual(data.entries[1]!.values.files);
});
it("linked field submission uses required/metadata checks while new uploads still honor upload limits", () => {
  const { target, attachment } = fixture();
  attachment.required = true;
  attachment.multiple = false;
  attachment.accept = ".pdf";
  attachment.limitFileTypes = true;
  attachment.maxFileSize = 0.01;
  const files = [
    { id: "one", name: "large.txt", type: "text/plain", size: 20000 },
    { id: "two", name: "other.txt", type: "text/plain", size: 4 },
  ];
  expect(fileValueIssue(attachment, files)).toContain("单个");
  expect(validateValues(target.schema, { attachment: files })).toEqual([]);
  expect(
    validateValues(target.schema, { attachment: [] })[0]!.message,
  ).toContain("请填写");
  expect(
    validateValues(target.schema, { attachment: [{ name: "broken" }] })[0]!
      .message,
  ).toContain("无效");
  expect(
    validateValues(target.schema, { attachment: [files[0], files[0]] })[0]!
      .message,
  ).toContain("重复");
  expect(fileValueIssue(attachment, [files[0]])).toContain("超过");
  attachment.defaultLink!.enabled = false;
  expect(
    validateValues(target.schema, { attachment: files })[0]!.message,
  ).toContain("单个");
});
it("the shared settings dialog confirms atomically, filters types and retains configured values when disabled", async () => {
  const { data, target, attachment } = fixture(),
    field = reactive(copy(attachment));
  await mount(
    {
      render: () =>
        h(DefaultLinkInspector, {
          field,
          schema: target.schema,
          formId: target.id,
          onUpdate: (patch: any) => Object.assign(field, patch),
        }),
    },
    data,
  );
  click("数据联动设置");
  await settle();
  expect(control<HTMLSelectElement>("联动来源字段").options.length).toBe(2);
  expect(
    [...control<HTMLSelectElement>("条件1引用字段").options].map(
      (o) => o.value,
    ),
  ).toEqual(["", "product", "note"]);
  change("联动条件关系", "any");
  await settle();
  expect(field.defaultLink!.match).toBe("all");
  click("取消");
  await settle();
  expect(document.querySelector(".config-discard")).not.toBeNull();
  click("继续编辑");
  await settle();
  click("确定");
  await settle();
  expect(field.defaultLink!.match).toBe("any");
  change("文件默认值", "none");
  await settle();
  expect(field.defaultLink!.formId).toBe("source");
  expect(field.defaultLink!.enabled).toBe(false);
  change("文件默认值", "linked");
  await settle();
  click("数据联动设置");
  await settle();
  change("联动来源字段", "");
  click("确定");
  await settle();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    "同类型",
  );
  expect(field.defaultLink!.fieldId).toBe("files");
  click("取消");
  await settle();
  click("放弃修改");
  await settle();
  expect(document.querySelector("dialog")).toBeNull();
});
it("real runtime prefills stored file IDs, submits them, and keeps initial saved values on reopen", async () => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("Blob", NodeBlob);
  vi.stubGlobal("File", NodeFile);
  const { data, target } = fixture();
  const files = await saveFiles([
    new File(["联动原文件"], "source.txt", { type: "text/plain" }),
  ]);
  data.entries[1]!.values.files = files;
  const persist = vi.fn(async (_values: FormValues) => true);
  await mount(
    {
      render: () =>
        h(FormRuntime, {
          schema: target.schema,
          formId: target.id,
          preview: false,
          persistValues: persist,
        }),
    },
    data,
  );
  expect(
    document.querySelector('[aria-label="查看 source.txt"]'),
  ).not.toBeNull();
  document
    .querySelector<HTMLFormElement>("form")!
    .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await settle();
  expect(persist.mock.calls[0]![0].attachment).toEqual(files);
  expect(
    await (
      await readFile((persist.mock.calls[0]![0].attachment as any[])[0])
    ).text(),
  ).toBe("联动原文件");
  app!.unmount();
  app = undefined;
  await mount(
    {
      render: () =>
        h(FormRuntime, {
          schema: target.schema,
          formId: target.id,
          entryId: "history",
          initialValues: {
            product: "A",
            attachment: [{ name: "historic.txt", size: 4, type: "text/plain" }],
          },
        }),
    },
    data,
  );
  expect(
    document.querySelector('[aria-label="查看 historic.txt"]'),
  ).not.toBeNull();
  expect(document.querySelector('[aria-label="查看 source.txt"]')).toBeNull();
});

function scalarFixture() {
  const f = fixture();
  f.source.schema.fields.push(
    createField("textarea", { id: "description" }),
    createField("datetime", { id: "date", format: "date" }),
    createField("radio", {
      id: "category",
      options: [
        { id: "category_id", label: "机械设备" },
        { id: "other_id", label: "其他", other: true },
      ],
    }),
  );
  publish(f.source);
  Object.assign(f.data.entries[1]!.values, {
    amount: 0,
    description: "第一行\n第二行",
    date: "2026-10-09",
    category: "category_id",
  });
  Object.assign(f.data.entries[2]!.values, {
    amount: 9.87654321,
    description: "产品B说明",
    date: "2026-10-10",
    category: { optionId: "other_id", text: "其他设备" },
  });
  const linked = (type: FormField["type"], id: string, sourceId: string) =>
    createField(type, {
      id,
      defaultValue: "旧自定义值",
      ...(type === "datetime" ? { format: "date" } : {}),
      defaultLink: { ...copy(f.attachment.defaultLink!), fieldId: sourceId },
    });
  const name = linked("text", "linkedName", "name"),
    note = linked("textarea", "linkedNote", "description"),
    amount = linked("number", "linkedAmount", "amount"),
    date = linked("datetime", "linkedDate", "date");
  amount.defaultValue = 42;
  date.defaultValue = "2025-01-01";
  f.target.schema.fields = [f.product, name, note, amount, date];
  publish(f.target);
  return { ...f, linked, name, note, amount, date };
}

it("prefills scalar values from the earliest permitted match without formatting numbers or losing multiline text", () => {
  const { data, target, name, note, amount, date } = scalarFixture();
  expect(validateFieldConfiguration(target.schema, data)).toEqual([]);
  expect(runtimeDefaults(target.schema.fields, data)).toMatchObject({
    product: "A",
    linkedName: "A",
    linkedNote: "第一行\n第二行",
    linkedAmount: 0,
    linkedDate: "2026-10-09",
  });
  const saved = parseSchema(JSON.parse(JSON.stringify(target.schema)));
  expect(saved.fields[3]!.defaultLink).toEqual(amount.defaultLink);
  expect(
    composeFormSchema(
      separateFormSchema(saved).model,
      separateFormSchema(saved).page,
    ).fields[3]!.defaultLink,
  ).toEqual(amount.defaultLink);
  const next = applyFieldChange(
    target.schema.fields,
    runtimeDefaults(target.schema.fields, data),
    "product",
    "B",
    data,
  );
  expect(next).toMatchObject({
    linkedNote: "产品B说明",
    linkedAmount: 9.87654321,
    linkedDate: "2026-10-10",
  });
  const empty = applyFieldChange(
    target.schema.fields,
    next,
    "product",
    "unknown",
    data,
  );
  for (const field of [name, note, amount, date])
    expect(empty[field.id]).toBe("");
  amount.defaultLink!.enabled = false;
  expect(runtimeDefaults(target.schema.fields, data).linkedAmount).toBe(42);
});

it("links single-choice labels and supplementary text into text fields using the record's historical options", () => {
  const { data, source, target, name, note } = scalarFixture();
  name.defaultLink!.fieldId = "category";
  note.defaultLink!.fieldId = "category";
  source.published!.schema.fields.find(
    (f) => f.id === "category",
  )!.options[0]!.label = "当前改名";
  expect(runtimeDefaults(target.schema.fields, data)).toMatchObject({
    linkedName: "机械设备",
    linkedNote: "机械设备",
  });
  expect(
    applyFieldChange(
      target.schema.fields,
      runtimeDefaults(target.schema.fields, data),
      "product",
      "B",
      data,
    ),
  ).toMatchObject({ linkedName: "其他设备", linkedNote: "其他设备" });
  const catalog = newForm("oa", "分类名称");
  catalog.schema.fields = [createField("text", { id: "label" })];
  publish(catalog);
  data.forms.push(catalog);
  data.entries.push({
    ...copy(data.entries[1]!),
    id: "category_record",
    formId: catalog.id,
    values: { label: "动态分类名称" },
  });
  source.versions[0]!.schema.fields.find(
    (f) => f.id === "category",
  )!.choiceSource = {
    mode: "form",
    formId: catalog.id,
    labelFieldId: "label",
    valueFieldId: "",
    filters: [],
    sort: "none",
    deduplicate: true,
  };
  data.entries[1]!.values.category = "category_record";
  expect(runtimeDefaults(target.schema.fields, data)).toMatchObject({
    linkedName: "动态分类名称",
    linkedNote: "动态分类名称",
  });
});

it("initializes a reversed chain through the existing change propagation and recalculates linked numbers", () => {
  const { data, target, linked } = scalarFixture();
  const code = linked("text", "code", "name");
  code.defaultValue = "";
  code.defaultLink!.filters[0] = {
    ...code.defaultLink!.filters[0]!,
    source: "constant",
    value: "A",
  };
  const amount = linked("number", "amount", "amount");
  amount.defaultValue = 999;
  amount.defaultLink!.filters[0]!.value = "code";
  const total = createField("calculated", {
    id: "total",
    expression: "{{amount}} * 2",
  });
  const note = linked("textarea", "note", "description");
  note.defaultLink!.filters[0] = {
    ...note.defaultLink!.filters[0]!,
    sourceFieldId: "amount",
    value: "total",
  };
  target.schema.fields = [note, total, amount, code];
  expect(validateFieldConfiguration(target.schema, data)).toEqual([]);
  expect(runtimeDefaults(target.schema.fields, data)).toMatchObject({
    code: "A",
    amount: 0,
    total: 0,
    note: "第一行\n第二行",
  });
  amount.defaultLink!.filters[0] = {
    ...amount.defaultLink!.filters[0]!,
    sourceFieldId: "amount",
    value: "total",
  };
  expect(validateFieldConfiguration(target.schema, data)).toContain(
    "字段联动存在循环引用，请调整筛选条件、部门依赖或回填映射",
  );
});

it("keeps scalar row links scoped to their own row and reacts to parent conditions without overwriting unrelated input", () => {
  const { data, product, amount } = scalarFixture();
  const rowCode = createField("text", { id: "rowCode", defaultValue: "A" });
  const own = copy(amount),
    parent = { ...copy(amount), id: "parentAmount" };
  own.defaultLink!.filters[0]!.value = "rowCode";
  const children = [
    rowCode,
    own,
    parent,
    createField("text", { id: "manual" }),
  ];
  const rows = [
    runtimeDefaults(children, data, { product: "A" }),
    runtimeDefaults(children, data, { product: "B" }),
  ];
  rows[0]!.manual = "保留输入";
  expect(rows[1]).toMatchObject({ linkedAmount: 0, parentAmount: 9.87654321 });
  const changed = applyFieldChange(children, rows[0]!, "rowCode", "B", data, {
    product: "A",
  });
  expect(changed).toMatchObject({
    linkedAmount: 9.87654321,
    parentAmount: 0,
    manual: "保留输入",
  });
  expect(rows[1]!.linkedAmount).toBe(0);
  const all = applyFieldChange(
    [product, createField("subform", { id: "lines", children })],
    { product: "A", lines: [rows[0]!] },
    "product",
    "B",
    data,
  );
  expect((all.lines as FormValues[])[0]).toMatchObject({
    linkedAmount: 0,
    parentAmount: 9.87654321,
    manual: "保留输入",
  });
});

it("rejects unsupported or mismatched scalar links and does not use dormant custom dates while linked", () => {
  const { data, target, amount, date } = scalarFixture();
  amount.defaultLink!.fieldId = "description";
  date.defaultLink!.fieldId = "amount";
  expect(defaultLinkErrors(amount, target.schema.fields, data)).toContain(
    "请选择同类型的联动字段",
  );
  expect(linkedDefault(amount, data, { product: "A" })).toBe("");
  date.defaultLink!.fieldId = "date";
  date.defaultValue = "invalid-old-input";
  expect(
    validateFieldConfiguration(target.schema, data).some((e) =>
      e.includes("默认日期"),
    ),
  ).toBe(false);
  date.defaultLink!.enabled = false;
  expect(
    validateFieldConfiguration(target.schema, data).some((e) =>
      e.includes("默认日期"),
    ),
  ).toBe(true);
  const unsupported = createField("phone", {
    defaultLink: copy(amount.defaultLink),
  });
  expect(defaultLinkErrors(unsupported, target.schema.fields, data)).toContain(
    "此字段默认值联动尚未接入",
  );
  amount.defaultLink!.fieldId = "amount";
  data.entries[1]!.values.amount = "not-a-number";
  expect(linkedDefault(amount, data, { product: "A" })).toBe("");
});

it("uses the same member scope for scalar source fields and conditions", () => {
  const { data, source, amount } = scalarFixture();
  expect(
    linkedDefault(amount, memberContext(data, "wang"), { product: "A" }),
  ).toBe("");
  const access = defaultAccess(),
    group = newAccessGroup(source.schema);
  group.identities = ["wang"];
  access.membersEnabled = true;
  access.groups = [group];
  data.formAccess = { [source.id]: access };
  expect(
    linkedDefault(amount, memberContext(data, "wang"), { product: "A" }),
  ).toBe(0);
  group.fields.amount = "hidden";
  expect(
    linkedDefault(amount, memberContext(data, "wang"), { product: "A" }),
  ).toBe("");
  group.fields.amount = "read";
  group.fields.name = "hidden";
  amount.defaultLink!.filters[0]!.operator = "notEquals";
  expect(
    linkedDefault(amount, memberContext(data, "wang"), { product: "A" }),
  ).toBe("");
});

it("the original scalar inspector switches sources, retains custom values and confirms the shared link dialog", async () => {
  const { data, target, note } = scalarFixture(),
    field = reactive(copy(note));
  field.defaultLink!.enabled = false;
  await mount(
    {
      render: () =>
        h(FieldInspector, {
          field,
          schema: target.schema,
          formId: target.id,
          onUpdate: (patch: any) => Object.assign(field, patch),
        }),
    },
    data,
  );
  expect(control<HTMLTextAreaElement>("自定义默认值").value).toBe("旧自定义值");
  change("默认值来源", "linked");
  await settle();
  expect(document.querySelector("#field-default")).toBeNull();
  click("数据联动设置");
  await settle();
  expect(
    [...control<HTMLSelectElement>("联动来源字段").options].map((o) => o.value),
  ).toEqual(["", "name", "description", "category"]);
  change("联动来源字段", "category");
  click("确定");
  await settle();
  expect(field.defaultLink!.fieldId).toBe("category");
  change("默认值来源", "custom");
  await settle();
  expect(control<HTMLTextAreaElement>("自定义默认值").value).toBe("旧自定义值");
  expect(field.defaultLink!.fieldId).toBe("category");
});

it("the real runtime submits scalar linked values but preserves a reopened record", async () => {
  const { data, target } = scalarFixture(),
    persist = vi.fn(async (_values: FormValues) => true);
  const long = "第一行\n" + "完整说明".repeat(100);
  data.entries[1]!.values.description = long;
  await mount(
    {
      render: () =>
        h(FormRuntime, {
          schema: target.schema,
          formId: target.id,
          preview: false,
          persistValues: persist,
        }),
    },
    data,
  );
  expect(
    document
      .querySelector('[data-field-id="linkedNote"] textarea')
      ?.getAttribute("maxlength"),
  ).toBeNull();
  document
    .querySelector<HTMLFormElement>("form")!
    .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await settle();
  expect(persist.mock.calls[0]![0]).toMatchObject({
    linkedAmount: 0,
    linkedNote: long,
    linkedDate: "2026-10-09",
  });
  app!.unmount();
  app = undefined;
  const original = {
    product: "A",
    linkedName: "旧名称",
    linkedNote: "旧说明",
    linkedAmount: 17,
    linkedDate: "2025-01-01",
  };
  await mount(
    {
      render: () =>
        h(FormRuntime, {
          schema: target.schema,
          formId: target.id,
          initialValues: original,
          entryId: "historic",
          preview: false,
          persistValues: persist,
        }),
    },
    data,
  );
  document
    .querySelector<HTMLFormElement>("form")!
    .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await settle();
  expect(persist.mock.calls.at(-1)![0]).toMatchObject(original);
});

it("new phone fields omit unrelated text settings while configured legacy defaults and limits remain editable and preserve publications", async () => {
  const { data, target } = fixture();
  const field = reactive(
    createField("phone", { id: "contactPhone", label: "联系电话" }),
  );
  target.schema.fields = [field];
  publish(target);
  const published = copy(target.published);
  await mount(
    {
      render: () =>
        h(FieldInspector, {
          field,
          schema: target.schema,
          formId: target.id,
          onUpdate: (patch: any) => Object.assign(field, patch),
        }),
    },
    data,
  );
  expect(document.querySelector("#field-default")).toBeNull();
  expect(document.querySelector("#field-length")).toBeNull();
  Object.assign(field, { defaultValue: "13800000000", maxLength: 20 });
  await settle();
  const defaultInput =
    document.querySelector<HTMLInputElement>("#field-default")!;
  expect(defaultInput.value).toBe("13800000000");
  expect(document.querySelector<HTMLInputElement>("#field-length")!.value).toBe(
    "20",
  );
  defaultInput.value = "13900000000";
  defaultInput.dispatchEvent(new Event("input", { bubbles: true }));
  const limit = document.querySelector<HTMLInputElement>("#field-length")!;
  limit.value = "11";
  limit.dispatchEvent(new Event("change", { bubbles: true }));
  await settle();
  expect(field.defaultValue).toBe("13900000000");
  expect(field.maxLength).toBe(11);
  expect(document.querySelector("#field-length")).toBeNull();
  expect(runtimeDefaults(target.schema.fields, data).contactPhone).toBe(
    "13900000000",
  );
  expect(parseSchema(target.schema).fields[0]).toMatchObject({
    id: field.id,
    defaultValue: field.defaultValue,
    maxLength: 11,
  });
  expect(target.published).toEqual(published);
});

function addressFixture() {
  const f = fixture();
  const remote = createField("address", { id: "location", label: "仓库地址" });
  f.source.schema.fields.push(remote);
  const shipping = createField("address", {
    id: "shipping",
    label: "收货地址",
    defaultValue: {
      province: "北京市",
      city: "北京市",
      district: "海淀区",
      detail: "旧自定义仓库",
    },
    defaultLink: { ...copy(f.attachment.defaultLink!), fieldId: remote.id },
  });
  const city = createField("text", {
    id: "cityText",
    label: "收货城市",
    defaultFormula: true,
    expression: 'TEXTLOCATION({{shipping}}, "city")',
  });
  f.target.schema.fields = [
    city,
    shipping,
    f.product,
    createField("text", { id: "note" }),
  ];
  const locations: AddressValue[] = [
    {
      province: "浙江省",
      city: "杭州市",
      district: "余杭区",
      detail: "较晚仓库",
    },
    {
      province: "江苏省",
      city: "无锡市",
      district: "锡山区",
      detail: "仓库,1号\n=SUM(1,2)",
    },
    { province: "广东省", city: "深圳市", district: "南山区", detail: "B仓库" },
  ];
  f.data.entries.forEach((entry, i) => {
    entry.values.location = copy(locations[i]!);
  });
  publish(f.source);
  publish(f.target);
  return { ...f, remote, shipping, city, locations };
}

it("prefills one independent structured address and recalculates TEXTLOCATION without a second default engine", () => {
  const { data, target, shipping, locations } = addressFixture();
  expect(validateFieldConfiguration(target.schema, data)).toEqual([]);
  const values = runtimeDefaults(target.schema.fields, data);
  expect(values).toMatchObject({ shipping: locations[1], cityText: "无锡市" });
  (values.shipping as AddressValue).detail = "手动修改";
  expect(data.entries[1]!.values.location).toEqual(locations[1]);
  expect(runtimeDefaults(target.schema.fields, data).shipping).toEqual(
    locations[1],
  );
  shipping.format = "province";
  expect(linkedDefault(shipping, data, { product: "A" })).toEqual({
    province: "江苏省",
  });
  shipping.format = "city";
  expect(linkedDefault(shipping, data, { product: "A" })).toEqual({
    province: "江苏省",
    city: "无锡市",
  });
  shipping.format = "district";
  expect(linkedDefault(shipping, data, { product: "A" })).toEqual({
    province: "江苏省",
    city: "无锡市",
    district: "锡山区",
  });
  expect(linkedDefault(shipping, data, { product: "missing" })).toBe("");
  data.entries[1]!.values.location = "江苏省无锡市锡山区";
  expect(linkedDefault(shipping, data, { product: "A" })).toBe("");
  data.entries[1]!.values.location = { province: "江苏省", district: 12 };
  expect(linkedDefault(shipping, data, { product: "A" })).toBe("");
});

it("changes only an address dependency, preserves manual/old values and clears a missing lookup", () => {
  const { data, target, shipping, locations } = addressFixture();
  const original = runtimeDefaults(target.schema.fields, data);
  const manual = {
    ...(original.shipping as AddressValue),
    detail: "原记录地址",
  };
  const unchanged = applyFieldChange(
    target.schema.fields,
    { ...original, shipping: manual },
    "note",
    "说明",
    data,
  );
  expect(unchanged.shipping).toEqual(manual);
  expect(unchanged.cityText).toBe("无锡市");
  const changed = applyFieldChange(
    target.schema.fields,
    unchanged,
    "product",
    "B",
    data,
  );
  expect(changed).toMatchObject({
    shipping: locations[2],
    cityText: "深圳市",
    note: "说明",
  });
  expect(
    applyFieldChange(target.schema.fields, changed, "product", "missing", data),
  ).toMatchObject({ shipping: "", cityText: "" });
  shipping.defaultLink!.enabled = false;
  expect(runtimeDefaults(target.schema.fields, data)).toMatchObject({
    shipping: shipping.defaultValue,
    cityText: "北京市",
  });
});

it("projects address lookup through the exact source version and target precision without mutating either publication", () => {
  const { data, source, target, shipping, remote, locations } =
    addressFixture();
  source.versions[0]!.schema.fields.find((f) => f.id === remote.id)!.format =
    "province";
  const before = copy(source.versions[0]);
  remote.format = "detail";
  expect(linkedDefault(shipping, data, { product: "A" })).toEqual({
    province: "江苏省",
    city: "",
    district: "",
    detail: "",
  });
  expect(
    validateValues(
      target.schema,
      runtimeDefaults(target.schema.fields, data),
    ).some((e) => e.fieldId === shipping.id && e.message.includes("完整填写")),
  ).toBe(true);
  expect(source.versions[0]).toEqual(before);
  expect(data.entries[1]!.values.location).toEqual(locations[1]);
  source.versions = [];
  source.published!.version = 2;
  expect(linkedDefault(shipping, data, { product: "A" })).toBe("");
  source.versions = [before!];
  source.versions[0]!.schema.fields.find((f) => f.id === remote.id)!.type =
    "text";
  expect(linkedDefault(shipping, data, { product: "A" })).toBe("");
});

it("isolates address links in detail rows and compares address content instead of generic object text", () => {
  const { data, shipping, locations } = addressFixture();
  shipping.defaultLink!.filters[0]!.value = "item";
  const rows = createField("subform", {
    id: "lines",
    children: [createField("text", { id: "item" }), shipping],
  });
  const fields = [createField("text", { id: "parent" }), rows];
  const original = {
    parent: "A",
    lines: [
      { item: "A", shipping: locations[1] },
      { item: "B", shipping: locations[2] },
    ],
  };
  const changedRow = applyFieldChange(
    rows.children,
    original.lines[0]!,
    "item",
    "B",
    data,
  );
  expect(changedRow.shipping).toEqual(locations[2]);
  expect(original.lines[1]!.shipping).toEqual(locations[2]);
  shipping.defaultLink!.filters[0]!.value = "parent";
  const changed = applyFieldChange(fields, original, "parent", "B", data);
  expect((changed.lines as FormValues[]).map((row) => row.shipping)).toEqual([
    locations[2],
    locations[2],
  ]);
  const conditions = [
    {
      id: "byAddress",
      sourceFieldId: "location",
      source: "field" as const,
      value: "input",
      operator: "equals" as const,
    },
  ];
  const a = locations[1]!;
  expect(
    matchesFilters(
      conditions,
      { location: a },
      {
        input: {
          detail: a.detail,
          district: a.district,
          city: a.city,
          province: a.province,
        },
      },
      data,
    ),
  ).toBe(true);
  expect(
    matchesFilters(conditions, { location: a }, { input: locations[2] }, data),
  ).toBe(false);
  expect(
    matchesFilters(conditions, { location: {} }, { input: {} }, data),
  ).toBe(false);
  expect(
    matchesFilters(
      [{ ...conditions[0]!, operator: "notEmpty" }],
      { location: { province: "", city: "", district: "", detail: "" } },
      {},
      data,
    ),
  ).toBe(false);
  shipping.defaultLink!.filters = conditions;
  expect(linkedDefault(shipping, data, { input: a })).toEqual(a);
  expect(
    linkedDefault(shipping, data, { input: { ...a, district: "滨湖区" } }),
  ).toBe("");
});

it("never reads hidden address fields, conditions or records through a member's linked default", () => {
  const { data, source, shipping, locations } = addressFixture();
  expect(
    linkedDefault(shipping, memberContext(data, "wang"), { product: "A" }),
  ).toBe("");
  const group = newAccessGroup(source.schema);
  group.identities = ["wang"];
  data.formAccess = {
    [source.id]: { ...defaultAccess(), membersEnabled: true, groups: [group] },
  };
  expect(
    linkedDefault(shipping, memberContext(data, "wang"), { product: "A" }),
  ).toEqual(locations[1]);
  group.fields.location = "hidden";
  expect(
    linkedDefault(shipping, memberContext(data, "wang"), { product: "A" }),
  ).toBe("");
  group.fields.location = "read";
  group.fields.name = "hidden";
  shipping.defaultLink!.filters[0]!.operator = "notEquals";
  expect(
    linkedDefault(shipping, memberContext(data, "wang"), { product: "A" }),
  ).toBe("");
  group.fields.name = "read";
  shipping.defaultLink!.filters[0]!.operator = "equals";
  source.archived = true;
  expect(linkedDefault(shipping, data, { product: "A" })).toBe("");
});

it("retains address lookup configuration through schema and layout restore while dormant custom defaults do not block publishing", () => {
  const { data, target, shipping } = addressFixture();
  const restored = parseSchema(target.schema);
  const parts = separateFormSchema(restored);
  const composed = composeFormSchema(parts.model, parts.page);
  expect(
    composed.fields.find((f) => f.id === shipping.id)!.defaultLink,
  ).toEqual(shipping.defaultLink);
  expect(
    composed.fields.find((f) => f.id === shipping.id)!.defaultValue,
  ).toEqual(shipping.defaultValue);
  shipping.defaultValue = { province: "已失效的旧自定义地址" };
  expect(validateFieldConfiguration(target.schema, data)).toEqual([]);
  shipping.defaultLink!.enabled = false;
  expect(
    validateFieldConfiguration(target.schema, data).some((e) =>
      e.includes("默认请重新选择省"),
    ),
  ).toBe(true);
  shipping.defaultLink!.enabled = true;
  shipping.defaultLink!.fieldId = "files";
  expect(defaultLinkErrors(shipping, target.schema.fields, data)).toContain(
    "请选择同类型的联动字段",
  );
  const malformed = copy(restored);
  malformed.fields.find((f) => f.id === shipping.id)!.defaultLink!.filters = [
    { id: "bad", source: "script" } as any,
  ];
  expect(() => parseSchema(malformed)).toThrow("联动配置");
});

it("the address inspector reuses source selection and the link dialog, with custom values retained and no unusable formula option", async () => {
  const { data, target, shipping } = addressFixture();
  target.schema.fields.push(
    createField("address", { id: "inputAddress", label: "条件地址" }),
  );
  const field = reactive(copy(shipping));
  field.defaultLink!.enabled = false;
  await mount(
    {
      render: () =>
        h(FieldInspector, {
          field,
          schema: target.schema,
          formId: target.id,
          onUpdate: (patch: any) => Object.assign(field, patch),
        }),
    },
    data,
  );
  expect(
    [...control<HTMLSelectElement>("默认值来源").options].map((o) => o.value),
  ).toEqual(["custom", "linked"]);
  expect(control<HTMLTextAreaElement>("默认地址 详细地址").value).toBe(
    "旧自定义仓库",
  );
  change("默认值来源", "linked");
  await settle();
  expect(document.querySelector(".address-trigger")).toBeNull();
  click("数据联动设置");
  await settle();
  expect(
    [...control<HTMLSelectElement>("联动来源字段").options].map((o) => o.value),
  ).toEqual(["", "location"]);
  change("条件1来源字段", "location");
  await settle();
  expect(
    [...control<HTMLSelectElement>("条件1运算符").options].map((o) => o.value),
  ).toEqual(["equals", "notEquals", "notEmpty"]);
  expect(
    [...control<HTMLSelectElement>("条件1值来源").options].map((o) => o.value),
  ).toEqual(["field"]);
  expect(
    [...control<HTMLSelectElement>("条件1引用字段").options].map(
      (o) => o.value,
    ),
  ).toEqual(["", "inputAddress"]);
  change("条件1引用字段", "inputAddress");
  await settle();
  click("确定");
  await settle();
  expect(field.defaultLink!.fieldId).toBe("location");
  change("默认值来源", "custom");
  await settle();
  expect(control<HTMLTextAreaElement>("默认地址 详细地址").value).toBe(
    "旧自定义仓库",
  );
  expect(field.defaultLink!.fieldId).toBe("location");
});

it("rejects unusable address comparisons and value sources while ignoring dormant not-empty bindings", () => {
  const { data, target, shipping, locations } = addressFixture();
  const input = createField("address", { id: "inputAddress" });
  target.schema.fields.push(input);
  const condition = shipping.defaultLink!.filters[0]!;
  Object.assign(condition, {
    sourceFieldId: "location",
    source: "field",
    value: input.id,
  });
  expect(defaultLinkErrors(shipping, target.schema.fields, data)).toEqual([]);
  const record = { location: locations[1] },
    values = { inputAddress: locations[1] };
  expect(matchesFilters([condition], record, values, data)).toBe(true);
  for (const operator of ["contains", "greater", "less"] as const) {
    condition.operator = operator;
    expect(defaultLinkErrors(shipping, target.schema.fields, data)).toContain(
      "联动条件的比较方式不适用于地址字段",
    );
    expect(matchesFilters([condition], record, values, data)).toBe(false);
  }
  condition.operator = "notEquals";
  expect(
    matchesFilters([condition], record, { inputAddress: "江苏省" }, data),
  ).toBe(false);
  for (const source of [
    "constant",
    "currentUser",
    "currentDepartment",
  ] as const) {
    condition.source = source;
    expect(defaultLinkErrors(shipping, target.schema.fields, data)).toContain(
      "地址条件请使用当前表单字段",
    );
    expect(matchesFilters([condition], record, values, data)).toBe(false);
  }
  condition.operator = "notEmpty";
  condition.value = "removed-field";
  expect(defaultLinkErrors(shipping, target.schema.fields, data)).toEqual([]);
  expect(matchesFilters([condition], record, {}, data)).toBe(true);
});

it("real address runtime submits the linked structure, changes customers and preserves a reopened record until its dependency changes", async () => {
  const { data, target, shipping, locations } = addressFixture();
  const persist = vi.fn(async (_values: FormValues) => true);
  const render = (initialValues?: FormValues) => ({
    render: () =>
      h(FormRuntime, {
        schema: target.schema,
        formId: target.id,
        preview: false,
        initialValues,
        entryId: initialValues ? "saved" : undefined,
        persistValues: persist,
      }),
  });
  await mount(render(), data);
  expect(control<HTMLTextAreaElement>("收货地址 详细地址").value).toBe(
    locations[1]!.detail,
  );
  const submit = () =>
    document
      .querySelector<HTMLFormElement>("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  submit();
  await settle();
  expect(persist.mock.calls[0]![0]).toMatchObject({
    shipping: locations[1],
    cityText: "无锡市",
  });
  app!.unmount();
  app = undefined;
  const old = {
    product: "A",
    shipping: { ...locations[1]!, detail: "历史地址" },
    cityText: "无锡市",
    note: "旧说明",
  };
  await mount(render(old), data);
  submit();
  await settle();
  expect(persist.mock.calls.at(-1)![0]).toMatchObject(old);
  app!.unmount();
  app = undefined;
  await mount(render(old), data);
  const input = document.querySelector<HTMLInputElement>(
    '[data-field-id="product"] input',
  )!;
  input.value = "B";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
  expect(control<HTMLTextAreaElement>("收货地址 详细地址").value).toBe(
    locations[2]!.detail,
  );
  submit();
  await settle();
  expect(persist.mock.calls.at(-1)![0]).toMatchObject({
    product: "B",
    shipping: locations[2],
    cityText: "深圳市",
    note: "旧说明",
  });
  expect(shipping.defaultValue).toMatchObject({ detail: "旧自定义仓库" });
});

it("all four date granularities round-trip each default source without losing custom, formula or linked configuration", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2024-02-29T16:03:04Z"));
  try {
    for (const [format, current, custom, linked, formula] of [
      ["month", "2024-03", "2020-06", "2026-10", "2024-02"],
      ["date", "2024-03-01", "2020-06-15", "2026-10-09", "2024-02-29"],
      [
        "datetime-local",
        "2024-03-01T00:03",
        "2020-06-15T09:10",
        "2026-10-09T10:11",
        "2024-02-29T12:13",
      ],
      [
        "datetime-second",
        "2024-03-01T00:03:04",
        "2020-06-15T09:10:11",
        "2026-10-09T10:11:12",
        "2024-02-29T12:13:14",
      ],
    ] as const) {
      const { data, source, target, date } = scalarFixture();
      source.schema.fields.find((f) => f.id === "date")!.format = format;
      data.entries[1]!.values.date = linked;
      publish(source);
      Object.assign(date, {
        format,
        defaultValue: custom,
        dateDefault: "custom",
        expression: "DATE(2024,2,29,12,13,14)",
      });
      const link = copy(date.defaultLink!);
      const value = () =>
        runtimeDefaults(
          parseSchema(JSON.parse(JSON.stringify(target.schema))).fields,
          data,
        )[date.id];
      expect(value()).toBe(linked);
      date.defaultLink!.enabled = false;
      date.defaultFormula = true;
      expect(value()).toBe(formula);
      date.defaultFormula = false;
      date.dateDefault = "now";
      expect(value()).toBe(current);
      date.dateDefault = "custom";
      expect(value()).toBe(custom);
      date.defaultLink!.enabled = true;
      expect(date.defaultLink).toEqual(link);
      expect(date.expression).toBe("DATE(2024,2,29,12,13,14)");
      expect(value()).toBe(linked);
    }
  } finally {
    vi.useRealTimers();
  }
});
