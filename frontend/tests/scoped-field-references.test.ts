// @vitest-environment jsdom
import { expect, it } from "vitest";

import { copy, createField, emptySchema } from "../src/domain/form";
import { seedWorkspace, newForm } from "../src/domain/workspace";
import { validateFieldConfiguration } from "../src/domain/fieldValidation";

function fixture() {
  const data = seedWorkspace();
  const source = newForm("oa", "分类目录", "form");
  source.schema.fields = [
    createField("text", { id: "name", label: "编号" }),
    createField("number", { id: "quantity", label: "数量" }),
  ];
  data.forms.push(source);
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
it("rejects unavailable department references while accepting root/current-row dependencies without mutating old configuration", () => {
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
  expect(validateFieldConfiguration(schema, data)).toContain(
    "「经办人」请选择有效的部门依赖字段",
  );
  expect(schema).toEqual(before);
  member.organization.scope.fieldId = "row_department";
  expect(validateFieldConfiguration(schema, data)).toEqual([]);
  member.organization.scope.fieldId = "root_department";
  expect(validateFieldConfiguration(schema, data)).toEqual([]);
});
