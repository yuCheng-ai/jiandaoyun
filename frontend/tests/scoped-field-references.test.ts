// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createApp, h, nextTick } from "vue";
import { copy, createField, emptySchema } from "../src/domain/form";
import { seedWorkspace, newForm } from "../src/domain/workspace";
import { validateFieldConfiguration } from "../src/domain/fieldValidation";
import ChoiceFieldInspector from "../src/features/forms/components/ChoiceFieldInspector.vue";
import RelationFieldInspector from "../src/features/forms/components/RelationFieldInspector.vue";
import OrganizationFieldInspector from "../src/features/forms/components/OrganizationFieldInspector.vue";
import { useWorkspaceStore } from "../src/stores/workspace";

vi.mock("../src/stores/workspace", () => ({ useWorkspaceStore: vi.fn() }));
const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  document.body.innerHTML = "";
});
function fixture() {
  const data = seedWorkspace();
  const source = newForm("oa", "分类目录", "form");
  source.schema.fields = [
    createField("text", { id: "name", label: "编号" }),
    createField("number", { id: "quantity", label: "数量" }),
  ];
  data.forms.push(source);
  vi.mocked(useWorkspaceStore).mockReturnValue({
    data,
    activeForms: data.forms,
  } as any);
  const choice = createField("select", {
    id: "choice",
    label: "分类编号",
  });
  choice.choiceSource = {
    ...choice.choiceSource,
    mode: "form",
    formId: source.id,
    labelFieldId: "name",
    filters: [
      {
        id: "filter",
        sourceFieldId: "quantity",
        source: "field",
        operator: "equals",
        value: "row_quantity",
      },
    ],
  };
  const relation = createField("relation", {
    id: "relation",
    label: "关联编号",
    referenceFormId: source.id,
    referenceFieldId: "name",
  });
  relation.reference.filters = copy(choice.choiceSource.filters);
  const schema = emptySchema();
  schema.fields = [
    createField("number", { id: "root_quantity", label: "数量" }),
    createField("subform", {
      id: "rows",
      label: "联动明细",
      children: [
        createField("number", { id: "row_quantity", label: "数量" }),
        choice,
        relation,
      ],
    }),
    createField("subform", {
      id: "other_rows",
      label: "其他明细",
      children: [
        createField("number", { id: "other_quantity", label: "数量" }),
      ],
    }),
  ];
  return { data, schema, choice, relation };
}
function referenceOptions() {
  const select = document.querySelector<HTMLSelectElement>(
    '[aria-label="条件1引用字段"]',
  )!;
  return [...select.options].map((option) => ({
    value: option.value,
    label: option.textContent!.trim(),
    disabled: option.disabled,
  }));
}
for (const kind of ["choice", "relation"] as const) {
  it(`${kind} filters offer only root and current-row inputs, distinguish duplicate names and retain an invalid old binding`, async () => {
    const { schema, choice, relation } = fixture();
    const field = kind === "choice" ? choice : relation;
    const filter =
      kind === "choice"
        ? field.choiceSource.filters[0]!
        : field.reference.filters[0]!;
    filter.value = "other_quantity";
    const before = copy(field);
    const host = document.createElement("div");
    document.body.append(host);
    const app = createApp({
      render: () =>
        h(kind === "choice" ? ChoiceFieldInspector : RelationFieldInspector, {
          field,
          schema,
          formId: "target",
        }),
    });
    app.mount(host);
    cleanups.push(() => app.unmount());
    await nextTick();
    const options = referenceOptions();
    expect(options.find((o) => o.value === "root_quantity")?.label).toBe(
      "数量",
    );
    expect(options.find((o) => o.value === "row_quantity")?.label).toBe(
      "联动明细 · 数量",
    );
    expect(
      options.filter((o) => !o.disabled).map((o) => o.value),
    ).not.toContain("other_quantity");
    expect(
      options.filter((o) => !o.disabled).map((o) => o.value),
    ).not.toContain(field.id);
    const select = document.querySelector<HTMLSelectElement>(
      '[aria-label="条件1引用字段"]',
    )!;
    expect(select.value).toBe("other_quantity");
    expect(select.selectedOptions[0]!.disabled).toBe(true);
    expect(select.selectedOptions[0]!.textContent).toContain(
      "不在当前可用范围",
    );
    expect(field).toEqual(before);
  });
}
it("rejects unavailable row references at publish without mutating old configuration and accepts root/current-row references", () => {
  const { data, schema, choice, relation } = fixture();
  expect(validateFieldConfiguration(schema, data)).toEqual([]);
  choice.choiceSource.filters[0]!.value = "other_quantity";
  relation.reference.filters[0]!.value = "other_quantity";
  const before = copy(schema);
  const errors = validateFieldConfiguration(schema, data);
  expect(errors).toContain("「分类编号」筛选条件的引用字段不在当前可用范围内");
  expect(errors).toContain("「关联编号」筛选条件的引用字段不在当前可用范围内");
  expect(schema).toEqual(before);
  choice.choiceSource.filters[0]!.value = "root_quantity";
  relation.reference.filters[0]!.value = "row_quantity";
  expect(validateFieldConfiguration(schema, data)).toEqual([]);
  schema.fields.unshift(choice);
  schema.fields[2]!.children = schema.fields[2]!.children.filter(
    (field) => field.id !== choice.id,
  );
  choice.choiceSource.filters[0]!.value = "row_quantity";
  expect(validateFieldConfiguration(schema, data)).toContain(
    "「分类编号」筛选条件的引用字段不在当前可用范围内",
  );
});
it("uses the same root/current-row scope for department-dependent personnel, retaining an invalid old dependency and rejecting publication", async () => {
  const { data, schema } = fixture();
  const member = createField("member", { id: "member", label: "经办人" });
  member.organization.scope.mode = "fieldDepartment";
  member.organization.scope.fieldId = "other_department";
  schema.fields.unshift(
    createField("department", { id: "root_department", label: "部门" }),
  );
  schema.fields[2]!.children.push(
    createField("department", { id: "row_department", label: "部门" }),
    member,
  );
  schema.fields[3]!.children.push(
    createField("department", { id: "other_department", label: "部门" }),
  );
  const before = copy(schema);
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({
    render: () => h(OrganizationFieldInspector, { field: member, schema }),
  });
  app.mount(host);
  cleanups.push(() => app.unmount());
  await nextTick();
  const select = document.querySelector<HTMLSelectElement>(
    '[aria-label="依赖部门字段"]',
  )!;
  expect(
    [...select.options].filter((o) => !o.disabled).map((o) => o.value),
  ).toEqual(["", "root_department", "row_department"]);
  expect(
    [...select.options].find((o) => o.value === "row_department")?.textContent,
  ).toContain("联动明细 · 部门");
  expect(select.value).toBe("other_department");
  expect(select.selectedOptions[0]!.disabled).toBe(true);
  expect(validateFieldConfiguration(schema, data)).toContain(
    "「经办人」请选择有效的部门依赖字段",
  );
  expect(schema).toEqual(before);
  member.organization.scope.fieldId = "row_department";
  expect(validateFieldConfiguration(schema, data)).toEqual([]);
  member.organization.scope.fieldId = "root_department";
  expect(validateFieldConfiguration(schema, data)).toEqual([]);
});
