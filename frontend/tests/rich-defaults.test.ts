import { seedWorkspace, newAccessGroup } from "./fixtures/workspace";
// @vitest-environment jsdom
// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp, h, shallowRef } from "vue";
import { createPinia, setActivePinia } from "pinia";
import {
  copy,
  createField,
  emptySchema,
  parseSchema,
  validateValues,
} from "../src/domain/form";
import { fieldCountLimitError } from "../src/domain/form";
import { richTextValueIssue } from "../src/domain/richText";
import {
  defaultLinkErrors,
  richTextDefaultErrors,
} from "../src/domain/fieldValidation";
import {
  applyFieldChange,
  linkedDefault,
  runtimeDefaults,
} from "../src/domain/relations";
import {
  defaultAccess,
  memberContext,
} from "../src/domain/access";
import {
  newForm,
  type FormRecord,
} from "../src/domain/workspace";
import { useFormDesigner } from "../src/features/forms/useFormDesigner";

const apps: ReturnType<typeof createApp>[] = [];

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
});
afterEach(() => {
  apps.splice(0).forEach((app) => app.unmount());
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

function mount(component: Parameters<typeof createApp>[0]) {
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp(component);
  app.use(createPinia());
  app.mount(host);
  apps.push(app);
  return app;
}
function publish(form: FormRecord) {
  form.published = {
    version: 1,
    schema: copy(form.schema),
    workflow: copy(form.workflow),
    extensions: copy(form.extensions),
    title: form.title,
    publishedAt: form.createdAt,
  };
  form.versions = [copy(form.published)];
}
const richFields = (count: number) =>
  Array.from({ length: count }, () => createField("richtext"));

it("rich defaults retain their formatting through schema save and runtime initialization", () => {
  const value =
    "<h2>请按以下步骤处理</h2><ol><li><b>检查</b></li><li>登记</li></ol>";
  const field = createField("richtext", { defaultValue: value });
  const schema = emptySchema();
  schema.fields = [field];
  expect(
    runtimeDefaults(
      parseSchema(JSON.parse(JSON.stringify(schema))).fields,
      seedWorkspace(),
    )[field.id],
  ).toBe(value);
});

it("enforces stored HTML length while preserving and allowing reductions of legacy values", () => {
  expect(richTextValueIssue("甲".repeat(30000))).toBe("");
  expect(richTextValueIssue("<p>" + "甲".repeat(30000) + "</p>")).toContain(
    "3 万",
  );
  expect(richTextValueIssue("甲".repeat(30001), "旧".repeat(30002))).toBe("");
  const schema = emptySchema(),
    field = createField("richtext");
  schema.fields = [field];
  const previous = { [field.id]: "原".repeat(31000) };
  expect(validateValues(schema, previous, [], previous)).toEqual([]);
  expect(
    validateValues(schema, { [field.id]: "新".repeat(31001) }, [], previous),
  ).toHaveLength(1);
  expect(
    validateValues(schema, { [field.id]: "新".repeat(30001) }),
  ).toHaveLength(1);
  expect(
    validateValues(schema, { [field.id]: "<p><br></p>".repeat(3001) }),
  ).toHaveLength(1);
  field.defaultValue = previous[field.id];
  expect(richTextDefaultErrors(schema.fields, copy(schema.fields))).toEqual([]);
  expect(richTextDefaultErrors(schema.fields)).toHaveLength(1);
  expect(parseSchema(schema).fields[0]!.defaultValue).toBe(previous[field.id]);
}, 20000);
it("uses stable row identities for legacy nested rich-value baselines", () => {
  const child = createField("richtext");
  const rows = createField("subform", { children: [child] });
  const schema = emptySchema();
  schema.fields = [rows];
  const previous = {
    [rows.id]: [
      { _rowId: "large", [child.id]: "原".repeat(31000) },
      { _rowId: "short", [child.id]: "短" },
    ],
  };
  const reordered = { [rows.id]: [...previous[rows.id]].reverse() };
  expect(validateValues(schema, reordered, [], previous)).toEqual([]);
  const changed = copy(reordered);
  changed[rows.id][0]![child.id] = "新".repeat(30001);
  expect(validateValues(schema, changed, [], previous)[0]!.path).toBe(
    `${rows.id}.0.${child.id}`,
  );
});
it("links only matching published rich fields and respects member field and condition access", () => {
  const data = seedWorkspace(),
    source = newForm("oa", "模板资料"),
    target = newForm("oa", "业务记录");
  const key = createField("text", { id: "key" }),
    value = createField("richtext", { id: "body" });
  source.schema.fields = [key, value];
  publish(source);
  const input = createField("text", { id: "input", defaultValue: "A" });
  const rich = createField("richtext", {
    id: "rich",
    defaultLink: {
      enabled: true,
      formId: source.id,
      fieldId: value.id,
      match: "all",
      filters: [
        {
          id: "match",
          sourceFieldId: key.id,
          operator: "equals",
          source: "field",
          value: input.id,
        },
      ],
    },
  });
  target.schema.fields = [input, rich];
  publish(target);
  data.forms = [source, target];
  data.entries = [
    {
      id: "source-entry",
      formId: source.id,
      definitionVersion: 1,
      values: {
        key: "A",
        body: '<h2>处理步骤</h2><p><b>先检查</b></p><img data-file-id="asset_example">',
      },
      status: "submitted",
      createdBy: "zhang",
      createdAt: "2026-10-01",
      history: [],
    },
  ];
  const expected = data.entries[0]!.values.body;
  expect(defaultLinkErrors(rich, target.schema.fields, data)).toEqual([]);
  expect(runtimeDefaults(target.schema.fields, data).rich).toBe(expected);
  expect(
    applyFieldChange(
      target.schema.fields,
      runtimeDefaults(target.schema.fields, data),
      "input",
      "B",
      data,
    ).rich,
  ).toBe("");
  expect(linkedDefault(rich, memberContext(data, "wang"), { input: "A" })).toBe(
    "",
  );
  const access = defaultAccess(),
    group = newAccessGroup(source.schema);
  access.membersEnabled = true;
  group.identities = ["wang"];
  access.groups = [group];
  data.formAccess = { [source.id]: access };
  expect(linkedDefault(rich, memberContext(data, "wang"), { input: "A" })).toBe(
    expected,
  );
  group.fields.body = "hidden";
  expect(linkedDefault(rich, memberContext(data, "wang"), { input: "A" })).toBe(
    "",
  );
  group.fields.body = "read";
  group.fields.key = "hidden";
  rich.defaultLink!.filters[0]!.operator = "notEquals";
  expect(linkedDefault(rich, memberContext(data, "wang"), { input: "B" })).toBe(
    "",
  );
  rich.defaultLink!.fieldId = key.id;
  expect(defaultLinkErrors(rich, target.schema.fields, data)).toContain(
    "请选择同类型的联动字段",
  );
});
it("rejects the eleventh rich field across click, drag, copy and restoration without mutating the draft", () => {
  const form = shallowRef(newForm("oa", "数量限制"));
  form.value.schema.fields = richFields(9);
  let editor!: ReturnType<typeof useFormDesigner>;
  const report = vi.fn();
  mount({
    setup: () => {
      editor = useFormDesigner(form, report);
      return () => h("div");
    },
  });
  expect(editor.add("richtext", null)).toBeTruthy();
  const before = copy(form.value);
  expect(editor.add("richtext", null)).toBeUndefined();
  editor.drop({ type: "richtext", index: 0 });
  editor.duplicate(form.value.schema.fields[0]!.id);
  expect(form.value).toEqual(before);
  form.value.fieldTrash = [
    { field: createField("richtext"), parentId: null, rules: [] },
  ];
  expect(editor.restore(0)).toBe(false);
  expect(form.value.fieldTrash).toHaveLength(1);
  expect(editor.add("text", null)).toBeTruthy();
  expect(report).toHaveBeenCalledWith("单个表单最多 10 个富文本字段");
});
it("preserves legacy over-limit definitions without allowing growth", () => {
  const schema = emptySchema();
  const legacy = richFields(11);
  expect(fieldCountLimitError(legacy, legacy)).toBe("");
  expect(
    fieldCountLimitError([...legacy, createField("richtext")], legacy),
  ).toContain("10 个富文本");
  schema.fields = legacy;
  expect(parseSchema(schema).fields).toHaveLength(11);
});
