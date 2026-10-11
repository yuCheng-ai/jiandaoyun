// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computed, createApp, h, nextTick, reactive } from "vue";
import { createPinia, setActivePinia } from "pinia";
import {
  copy,
  createField,
  emptySchema,
  fieldTypePatch,
  isFieldVisible,
  parseSchema,
} from "../src/domain/form";
import { conditionDisplayValue } from "../src/domain/conditionValues";
import {
  matchesFilters,
  resolveConditionOption,
  referenceDependencies,
} from "../src/domain/relations";
import { textVisibilityRules } from "../src/domain/visibility";
import {
  defaultAccess,
  groupsForEntry,
  newAccessGroup,
} from "../src/domain/access";
import {
  newForm,
  seedWorkspace,
  type FormEntry,
} from "../src/domain/workspace";
import { parseWorkspace } from "../src/repositories/workspaceRepository";
import { runtimeDataKey } from "../src/composables/useRuntimeData";
import DataFilterEditor from "../src/features/forms/components/DataFilterEditor.vue";
import VisibilityRules from "../src/features/forms/components/VisibilityRules.vue";
import { useWorkspaceStore } from "../src/stores/workspace";
import type { DataFilter } from "@platform/contracts";

let app: ReturnType<typeof createApp> | undefined;
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  setActivePinia(createPinia());
});
afterEach(() => {
  app?.unmount();
  app = undefined;
  document.body.innerHTML = "";
});
const settle = async () => {
  for (let i = 0; i < 6; i++) await nextTick();
};
function fixture() {
  const data = seedWorkspace();
  const catalog = newForm("oa", "分类目录");
  catalog.id = "catalog";
  catalog.schema.fields = [createField("text", { id: "name" })];
  catalog.published = {
    version: 1,
    schema: copy(catalog.schema),
    workflow: copy(catalog.workflow),
    title: catalog.title,
    publishedAt: "2026-10-11",
  };
  const record = (
    id: string,
    formId: string,
    values: Record<string, unknown>,
    version = 1,
  ): FormEntry => ({
    id,
    formId,
    values,
    definitionVersion: version,
    status: "submitted",
    createdBy: "zhang",
    createdAt: "2026-10-11",
    history: [],
  });
  data.forms = [catalog];
  data.entries = [
    record("a", catalog.id, { name: "甲" }),
    record("b", catalog.id, { name: "乙" }),
    record("private", catalog.id, { name: "未被规则选中的业务内容" }),
  ];
  const field = createField("select", { id: "category", label: "类别" });
  field.choiceSource = {
    ...field.choiceSource,
    mode: "form",
    formId: catalog.id,
    labelFieldId: "name",
  };
  const original = copy(field);
  const filter: DataFilter = {
    id: "f",
    sourceFieldId: field.id,
    source: "constant",
    operator: "equals",
    value: "a",
  };
  const convert = () => Object.assign(field, fieldTypePatch(field, "text"));
  const match = (value: string, negative = false) =>
    matchesFilters(
      [{ ...filter, operator: negative ? "notEquals" : "equals" }],
      { category: value },
      {},
      data,
      "all",
      [field],
    );
  return { data, catalog, field, original, filter, convert, match, record };
}

describe("dynamic choice conversion", () => {
  it("stores only source references, round-trips them, and resolves positive and negative constants", () => {
    const f = fixture();
    f.convert();
    expect(f.field.choiceConversion).toEqual({
      initialType: "choice",
      options: [],
      sources: [{ formId: "catalog", labelFieldId: "name", valueFieldId: "" }],
    });
    expect(JSON.stringify(f.field)).not.toContain("未被规则选中的业务内容");
    expect(f.match("甲")).toBe(true);
    expect(f.match("乙")).toBe(false);
    expect(f.match("甲", true)).toBe(false);
    expect(f.match("乙", true)).toBe(true);
    expect(f.match("a")).toBe(false);
    const schema = emptySchema();
    schema.fields = [f.field];
    expect(parseSchema(schema).fields[0]!.choiceConversion).toEqual(
      f.field.choiceConversion,
    );
    expect(
      conditionDisplayValue(f.field, "a", undefined, (field, id) =>
        resolveConditionOption(field, id, f.data),
      ),
    ).toBe("甲");
  });

  it("never turns removed, masked or ambiguous dynamic names into a passing negative condition", () => {
    for (const missing of [
      "record",
      "column",
      "scope",
      "archive",
      "ambiguous",
    ]) {
      const f = fixture();
      f.convert();
      if (missing === "record") f.data.entries[0]!.deletedAt = "2026-10-11";
      if (missing === "column") delete f.data.entries[0]!.values.name;
      if (missing === "scope") f.data.entries[0]!.readableFieldIds = [];
      if (missing === "archive") f.catalog.archived = true;
      if (missing === "ambiguous") {
        f.catalog.schema.fields.push(createField("text", { id: "other" }));
        f.data.entries[0]!.values.other = "另一个含义";
        f.field.choiceConversion!.sources!.push({
          formId: "catalog",
          labelFieldId: "other",
          valueFieldId: "",
        });
      }
      expect(f.match("任意文字", true), missing).toBe(false);
    }
  });

  it("keeps exact old versions and existing permission scopes while interpreting new text", () => {
    const f = fixture(),
      form = newForm("oa", "申请");
    form.schema.fields = [f.field];
    const publish = (version: number) => {
      const definition = {
        version,
        title: form.title,
        schema: copy(form.schema),
        workflow: copy(form.workflow),
        publishedAt: "2026-10-11",
      };
      form.versions.push(definition);
      form.published = copy(definition);
    };
    publish(1);
    f.convert();
    publish(2);
    f.data.forms.push(form);
    const records = [
      f.record("old-a", form.id, { category: "a" }),
      f.record("old-b", form.id, { category: "b" }),
      f.record("new-a", form.id, { category: "甲" }, 2),
      f.record("new-b", form.id, { category: "乙" }, 2),
    ];
    f.data.entries.push(...records);
    const group = newAccessGroup(form.schema, "read");
    group.identities = ["zhang"];
    group.scope = "custom";
    group.filters = [f.filter];
    f.data.formAccess = {
      [form.id]: { ...defaultAccess(), membersEnabled: true, groups: [group] },
    };
    expect(
      records
        .filter((e) => groupsForEntry(f.data, e, "zhang").length)
        .map((e) => e.id),
    ).toEqual(["old-a", "new-a"]);
    group.filters[0]!.operator = "notEquals";
    const restored = parseWorkspace(JSON.stringify(f.data));
    expect(
      records
        .filter((e) => groupsForEntry(restored, e, "zhang").length)
        .map((e) => e.id),
    ).toEqual(["old-b", "new-b"]);
    expect(form.versions[0]!.schema.fields[0]).toEqual(f.original);
    expect(records[0]!.values.category).toBe("a");
  });

  it("converts only this draft's referenced visibility constants, including subfields", () => {
    const f = fixture(),
      detail = createField("text", { id: "detail" });
    const schema = emptySchema();
    schema.fields = [
      createField("subform", { id: "rows", children: [f.field, detail] }),
    ];
    schema.settings.rules = [
      {
        id: "visible",
        sourceId: f.field.id,
        operator: "notEquals",
        value: "a",
        targetIds: [detail.id],
      },
    ];
    const original = copy(schema);
    schema.settings.rules = textVisibilityRules(
      schema.settings.rules,
      f.field,
      [{ id: "a", label: "甲" }],
    );
    f.convert();
    expect(schema.settings.rules[0]).toMatchObject({
      value: "甲",
      valueType: "text",
    });
    expect(isFieldVisible(detail, schema, { category: "甲" })).toBe(false);
    expect(isFieldVisible(detail, schema, { category: "乙" })).toBe(true);
    expect(original.settings.rules[0]).toMatchObject({ value: "a" });
    expect(() =>
      textVisibilityRules(original.settings.rules, f.original, []),
    ).toThrow("显隐条件选项已不可用");
  });

  it("keeps source and local deletion impacts for active and converted choices", () => {
    const f = fixture();
    f.field.choiceSource.filters = [
      { ...f.filter, sourceFieldId: "name", source: "field", value: "gate" },
    ];
    expect(referenceDependencies(f.field).local).toContain("gate");
    expect(referenceDependencies(f.field).external).toContainEqual({
      formId: "catalog",
      fields: ["name"],
    });
    f.convert();
    const restored = parseSchema({ ...emptySchema(), fields: [f.field] })
      .fields[0]!;
    expect(referenceDependencies(restored).external).toContainEqual({
      formId: "catalog",
      fields: ["name"],
    });
    expect(referenceDependencies(restored).local).not.toContain("gate");
  });

  it("visibility configuration offers dynamic choices before a dependent input has been filled", async () => {
    const f = fixture(),
      schema = reactive(emptySchema());
    f.field.choiceSource.filters = [
      { ...f.filter, sourceFieldId: "name", source: "field", value: "gate" },
    ];
    schema.fields = [
      createField("text", { id: "gate" }),
      f.field,
      createField("text", { id: "detail", label: "补充说明" }),
    ];
    useWorkspaceStore().data = f.data;
    document.body.innerHTML = '<div id="mount"></div>';
    app = createApp(() => h(VisibilityRules, { schema, fieldId: f.field.id }));
    app.mount("#mount");
    await settle();
    const button = (name: string) =>
      [...document.querySelectorAll<HTMLButtonElement>("button")].find(
        (el) => el.textContent?.trim() === name,
      )!;
    button("设置").click();
    await settle();
    button("显隐规则").click();
    await settle();
    document.querySelector<HTMLElement>('[aria-label="条件选项 1"]')!.click();
    await settle();
    const options = [
      ...document.querySelectorAll<HTMLElement>('[role="option"]'),
    ];
    expect(options.map((option) => option.textContent?.trim())).toEqual(
      expect.arrayContaining(["甲", "乙"]),
    );
    options.find((option) => option.textContent?.trim() === "甲")!.click();
    await settle();
    document.querySelector<HTMLElement>('[aria-label="显示字段 1"]')!.click();
    await settle();
    document
      .querySelector<HTMLElement>('[aria-label="显示字段 1 补充说明"]')!
      .click();
    await settle();
    expect(schema.settings.rules).toEqual([]);
    button("确定").click();
    await settle();
    expect(schema.settings.rules[0]).toMatchObject({
      conditions: [{ sourceId: "category", value: "a" }],
      targetIds: ["detail"],
    });
  });

  it("rejects malformed source metadata rather than dropping the old condition meaning", () => {
    const f = fixture();
    f.convert();
    const schema = emptySchema();
    schema.fields = [f.field];
    f.field.choiceConversion!.sources![0]!.labelFieldId = "";
    expect(() => parseSchema(schema)).toThrow("选项来源无效");
  });

  it("the shared editor shows actual dynamic choices and keeps literals distinct after conversion", async () => {
    const f = fixture(),
      state = reactive({ field: f.field, filters: [f.filter] });
    document.body.innerHTML = '<div id="mount"></div>';
    app = createApp(() =>
      h(DataFilterEditor<DataFilter>, {
        modelValue: state.filters,
        sourceFields: [state.field],
        localFields: [],
        allowFieldSource: false,
        "onUpdate:modelValue": (value) => {
          state.filters = value;
        },
      }),
    );
    app.provide(
      runtimeDataKey,
      computed(() => f.data),
    );
    app.mount("#mount");
    await settle();
    const select = document.querySelector<HTMLSelectElement>(
      '[aria-label="条件1固定值"]',
    )!;
    expect([...select.options].map((option) => option.label)).toContain("甲");
    expect([...select.options].map((option) => option.label)).not.toContain(
      "选项一",
    );
    Object.assign(state.field, fieldTypePatch(state.field, "text"));
    await settle();
    const input = document.querySelector<HTMLInputElement>(
      'input[aria-label="条件1固定值"]',
    )!;
    expect(input.value).toBe("甲");
    expect(state.filters[0]!.value).toBe("a");
    input.value = "a";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    expect(state.filters[0]).toMatchObject({ value: "a", valueType: "text" });
    expect(
      matchesFilters(state.filters, { category: "a" }, {}, f.data, "all", [
        state.field,
      ]),
    ).toBe(true);
    expect(
      matchesFilters(state.filters, { category: "甲" }, {}, f.data, "all", [
        state.field,
      ]),
    ).toBe(false);
  });
});
