// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from "vitest";
import { createApp, h, nextTick, reactive } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createMemoryHistory, createRouter } from "vue-router";
import {
  composeFormSchema,
  separateFormSchema,
  textFormatValueIssue,
  textFormats,
} from "@platform/contracts";
import {
  copy,
  createField,
  duplicateField,
  emptySchema,
  parseSchema,
  validateValues,
} from "../src/domain/form";
import { validateFieldConfiguration } from "../src/domain/fieldValidation";
import { seedWorkspace } from "../src/domain/workspace";
import { LocalWorkspaceRepository } from "../src/repositories/workspaceRepository";
import { useWorkspaceStore } from "../src/stores/workspace";
import type { RecordImportRequest } from "../src/domain/recordImport";

import FieldControl from "../src/features/forms/components/FieldControl.vue";
import FieldValueRules from "../src/features/data/FieldValueRules.vue";

let app: ReturnType<typeof createApp> | undefined;
beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
});
afterEach(() => {
  app?.unmount();
  app = undefined;
  document.body.innerHTML = "";
  localStorage.clear();
});
const text = (format: string, extra = {}) =>
  createField("text", { id: format, label: format, format, ...extra });
const issue = (format: string, value: unknown) =>
  textFormatValueIssue(text(format), value);
const examples = {
  mobile: "086-12000000001",
  tel: "010-2345678-0123",
  zip: "000001",
  id: "11000020000229123X",
  email: "sample+tag@example.technology",
};

it("preserves new formats in the existing compatibility editor while keeping multiline formats unchanged", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const field = reactive(text("zip", { label: "编码" }));
  app = createApp(() =>
    h(FieldValueRules, {
      field,
      onUpdate: (patch: object) => Object.assign(field, patch),
    }),
  );
  app.mount(host);
  const select = host.querySelector(
    'select[aria-label="编码文本格式"]',
  ) as HTMLSelectElement;
  expect(select.value).toBe("zip");
  expect([...select.options].map((option) => option.value)).toEqual(
    textFormats.map((item) => item.value),
  );
  select.value = "mobile";
  select.dispatchEvent(new Event("change", { bubbles: true }));
  await nextTick();
  expect(field.format).toBe("mobile");
  field.type = "textarea";
  field.format = "email";
  await nextTick();
  expect([...select.options].map((option) => option.value)).toEqual([
    "none",
    "email",
  ]);
  expect(select.value).toBe("email");
});

it("offers all built-in formats and rejects unsupported configurations without imposing text formats on other types", () => {
  expect(textFormats.map((f) => f.label)).toEqual([
    "无",
    "手机号码",
    "电话号码",
    "邮政编码",
    "身份证号码",
    "邮箱",
  ]);
  for (const format of ["none", ...Object.keys(examples)])
    expect(
      validateFieldConfiguration(
        { ...emptySchema(), fields: [text(format)] },
        seedWorkspace(),
      ),
    ).toEqual([]);
  expect(
    validateFieldConfiguration(
      { ...emptySchema(), fields: [text("script")] },
      seedWorkspace(),
    ),
  ).toContain("「script」请选择有效的文本格式");
  expect(
    validateFieldConfiguration(
      {
        ...emptySchema(),
        fields: [createField("number", { format: "percent" })],
      },
      seedWorkspace(),
    ),
  ).toEqual([]);
});
it("validates mobile text prefixes and keeps the independent phone field rule unchanged", () => {
  for (const value of [
    "12000000001",
    "086-12000000001",
    "(86)12000000001",
    "(086)12000000001",
  ])
    expect(issue("mobile", value)).toBeUndefined();
  for (const value of [
    "22000000001",
    "1200000000",
    " 12000000001",
    "+8612000000001",
    12000000001,
  ])
    expect(issue("mobile", value)).toContain("手机号码");
  expect(
    validateValues(
      { ...emptySchema(), fields: [createField("phone", { id: "phone" })] },
      { phone: "12000000001" },
    )[0]?.message,
  ).toContain("11 位手机号");
});
it("validates area codes and extensions and handles the source telephone grouping without unbounded regex backtracking", () => {
  for (const value of [
    "2345678",
    "23456789",
    "010-2345678",
    "0571-23456789-0",
    "2345678-0123",
    "234567823456789",
  ])
    expect(issue("tel", value)).toBeUndefined();
  for (const value of [
    "12345678",
    "234567",
    "0102345678",
    "010-2345678-12345",
    "010--2345678",
    "2345678-",
    "2".repeat(10000) + "x",
  ])
    expect(issue("tel", value)).toContain("电话号码");
});
it("preserves leading zeroes in postal identifiers and rejects the wrong length or non-string values", () => {
  expect(issue("zip", "000001")).toBeUndefined();
  for (const value of ["00001", "0000001", "00000a", " 000001", 100001])
    expect(issue("zip", value)).toContain("邮政编码");
});
it("checks the source identity-number shape and component ranges without adding a checksum requirement", () => {
  for (const value of ["11000020000229123X", "820000200012311234"])
    expect(issue("id", value)).toBeUndefined();
  for (const value of [
    "11000020000229123x",
    "99000020000229123X",
    "11000020001329123X",
    "11000020000232123X",
    "11000000000229123X",
    "11000020000229123",
    "11000020000229123X ",
  ])
    expect(issue("id", value)).toContain("身份证号码");
});
it("keeps existing email and unrestricted text semantics and lets required validation handle empty values", () => {
  expect(issue("email", examples.email)).toBeUndefined();
  expect(issue("email", "bad")).toContain("邮箱");
  expect(
    textFormatValueIssue(
      createField("textarea", { format: "email" }),
      examples.email,
    ),
  ).toBeUndefined();
  expect(issue("none", "任意 / 文本")).toBeUndefined();
  for (const format of Object.keys(examples)) {
    expect(issue(format, "")).toBeUndefined();
    const field = text(format, { required: true });
    expect(
      validateValues(
        { ...emptySchema(), fields: [field] },
        { [field.id]: "" },
      )[0]?.message,
    ).toBe(`请填写${field.label}`);
  }
});
it("reports correct main, tab and populated subform paths while retaining invalid input and ignoring hidden fields", () => {
  const main = text("zip"),
    child = text("tel", { id: "rowTel" }),
    tabs = createField("tabs", { children: [text("mobile")] }),
    rows = createField("subform", { id: "rows", children: [child] });
  tabs.children[0]!.tabId = tabs.tabs[0]!.id;
  const schema = {
    ...emptySchema(),
    fields: [main, tabs, rows, text("id", { visible: false })],
  };
  const values = {
    zip: "00001",
    mobile: "bad",
    rows: [{ rowTel: "bad" }],
    id: "bad",
  };
  const before = copy(values);
  expect(validateValues(schema, values).map((e) => e.path)).toEqual([
    "zip",
    "mobile",
    "rows.0.rowTel",
  ]);
  expect(values).toEqual(before);
  expect(
    validateValues(schema, {
      zip: "000001",
      mobile: examples.mobile,
      rows: [{ rowTel: examples.tel }],
      id: "bad",
    }),
  ).toEqual([]);
});
it("roundtrips all formats through schema, copies and compatibility projections without changing defaults or field IDs", () => {
  const schema = {
    ...emptySchema(),
    fields: Object.entries(examples).map(([format, value]) =>
      text(format, { defaultValue: value }),
    ),
  };
  const parsed = parseSchema(JSON.parse(JSON.stringify(schema)));
  expect(parsed).toEqual(schema);
  const parts = separateFormSchema(parsed),
    composed = composeFormSchema(parts.model, parts.page);
  expect(composed.fields.map((f) => [f.id, f.format, f.defaultValue])).toEqual(
    schema.fields.map((f) => [f.id, f.format, f.defaultValue]),
  );
  const copied = duplicateField(schema.fields[2]!);
  expect(copied.id).not.toBe("zip");
  expect(copied).toMatchObject({ format: "zip", defaultValue: "000001" });
});
async function mount(component: any, props: Record<string, unknown>) {
  const host = document.createElement("div");
  document.body.append(host);
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/", component: { render: () => null } }],
  });
  await router.push("/");
  await router.isReady();
  app = createApp({ render: () => h(component, props) });
  app.use(createPinia()).use(router).mount(host);
  await nextTick();
  return host;
}

it("the shared input keeps leading zeroes and invalid text available for correction", async () => {
  const state = reactive({ value: "000001" });
  const host = await mount(FieldControl, {
    field: text("zip"),
    modelValue: state.value,
    "onUpdate:modelValue": (value: string) => {
      state.value = value;
    },
  });
  const input = host.querySelector("input")!;
  expect(input.type).toBe("text");
  expect(input.value).toBe("000001");
  input.value = "00001bad";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await nextTick();
  expect(state.value).toBe("00001bad");
  expect(input.value).toBe("00001bad");
});
async function setup() {
  const store = useWorkspaceStore(),
    form = (await store.createForm("oa", "文本格式回归", "form"))!,
    draft = store.openForm(form.id)!;
  draft.schema.fields = [
    text("zip", { required: true }),
    text("mobile"),
    text("tel"),
    text("id"),
  ];
  expect(await store.saveForm(form.id)).toBe(true);
  expect(await store.publishForm(form.id)).toBe(true);
  return { store, form, draft };
}
it("retains an invalid draft, blocks its final submission, then submits and updates the same record with atomic failures", async () => {
  const { store, form } = await setup();
  const draft = (await store.submitEntry(form.id, { zip: "bad" }, "draft"))!;
  expect(draft.status).toBe("draft");
  expect(
    await store.submitEntry(form.id, draft.values, "submitted", draft.id),
  ).toBeUndefined();
  expect(draft.status).toBe("draft");
  expect(draft.values.zip).toBe("bad");
  const saved = (await store.submitEntry(
    form.id,
    examples,
    "submitted",
    draft.id,
  ))!;
  expect(saved.id).toBe(draft.id);
  expect(store.data.entries).toHaveLength(1);
  const before = copy(saved);
  expect(
    await store.updateEntry(saved.id, {
      ...saved.values,
      zip: "bad",
      tel: "2345678",
    }),
  ).toBe(false);
  expect(saved).toEqual(before);
  expect(
    await store.updateEntry(saved.id, {
      ...saved.values,
      zip: "000002",
      tel: "2345678",
    }),
  ).toBe(true);
  const cold = new LocalWorkspaceRepository().load()!;
  expect(cold.entries).toHaveLength(1);
  expect(cold.entries[0]).toMatchObject({
    id: draft.id,
    definitionVersion: 1,
    values: { zip: "000002", tel: "2345678" },
  });
});
it("applies import-format checks only when existing validation is enabled and retains failed rows for correction", async () => {
  const { store, form } = await setup();
  const request: RecordImportRequest = {
    mode: "create",
    definitionVersion: 1,
    rows: [["bad"], ["000003"]],
    firstRow: 2,
    mapping: [{ column: 0, fieldId: "zip", type: "text" }],
    validate: true,
    triggerWorkflow: false,
    targets: [],
  };
  const result = await store.importEntries(form.id, request);
  expect(result).toMatchObject({ created: 1, updated: 0 });
  if (!result) throw Error("import failed");
  expect(result.rows[0]).toMatchObject({
    kind: "error",
    row: 2,
    values: { zip: "bad" },
  });
  expect(result.rows[0]?.issues).toContainEqual({
    fieldId: "zip",
    row: 2,
    message: "请输入有效的邮政编码",
  });
  expect(
    await store.importEntries(form.id, {
      ...request,
      rows: [["unchecked"]],
      validate: false,
    }),
  ).toMatchObject({ created: 1 });
  expect(store.data.entries.map((e) => e.values.zip)).toEqual([
    "unchecked",
    "000003",
  ]);
});
it("old published records and drafts retain their original format after a new version changes it", async () => {
  const { store, form, draft } = await setup();
  const old = (await store.submitEntry(form.id, { zip: "000004" }, "draft"))!;
  const published = copy(
    store.data.forms.find((f) => f.id === form.id)!.published!,
  );
  draft.schema.fields[0]!.format = "mobile";
  expect(await store.publishForm(form.id)).toBe(true);
  expect(store.data.forms.find((f) => f.id === form.id)!.versions[0]).toEqual(
    published,
  );
  expect(
    (await store.submitEntry(form.id, old.values, "submitted", old.id))
      ?.definitionVersion,
  ).toBe(1);
  expect(await store.submitEntry(form.id, { zip: "000004" })).toBeUndefined();
  const current = (await store.submitEntry(form.id, { zip: "12000000001" }))!;
  expect(current.definitionVersion).toBe(2);
  expect(store.data.entries).toHaveLength(2);
  expect(await store.updateEntry(old.id, { zip: "000005" })).toBe(true);
  expect(store.data.forms.find((f) => f.id === form.id)!.versions[0]).toEqual(
    published,
  );
});
