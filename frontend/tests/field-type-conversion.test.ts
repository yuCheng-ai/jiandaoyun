import { describe, expect, it } from "vitest";
import {
  copy,
  createField,
  fieldTypeAlternatives,
  fieldTypeChangeIssue,
  fieldTypePatch,
  parseSchema,
  validateValues,
} from "../src/domain/form";
import { newForm } from "../src/domain/workspace";
import { emptyDefaultLink } from "../src/domain/fieldConfig";

describe("text / single-choice conversion contract", () => {
  it("keeps field and subform ownership while replacing incompatible widget settings", () => {
    const form = newForm("oa", "转换验收");
    const field = createField("text", {
      id: "code",
      label: "编号",
      description: "录入编号",
      showLabel: false,
      required: true,
      visible: false,
      editable: false,
      width: 6,
      subformWidth: "double",
      tabId: "tab-a",
      placeholder: "六位编号",
      defaultValue: "000001",
      format: "zip",
      maxLength: 6,
      masked: true,
      unique: true,
      uniqueInRecord: true,
      duplicateMessage: "编号不能重复",
    });
    form.schema.fields = [
      createField("subform", { id: "lines", children: [field] }),
    ];
    const published = copy(form.schema);
    Object.assign(field, fieldTypePatch(field, "select"));
    const saved = parseSchema(form.schema).fields[0]!.children[0]!;
    expect(saved).toMatchObject({
      id: "code",
      type: "select",
      label: "编号",
      description: "录入编号",
      showLabel: false,
      required: true,
      visible: false,
      editable: false,
      width: 6,
      subformWidth: "double",
      tabId: "tab-a",
      defaultValue: "",
      format: "none",
      masked: false,
      unique: false,
    });
    expect(saved.options.map((option) => option.label)).toEqual([
      "选项一",
      "选项二",
      "选项三",
    ]);
    expect(new Set(saved.options.map((option) => option.id)).size).toBe(3);
    expect(published.fields[0]!.children[0]).toMatchObject({
      type: "text",
      format: "zip",
      defaultValue: "000001",
      masked: true,
    });
  });

  it.each(["select", "radio"] as const)(
    "%s to text drops option-only rules and does not carry an opaque default ID into text",
    (type) => {
      const field = createField(type, {
        id: "category",
        required: true,
        options: [{ id: "option_a", label: "甲" }],
        defaultValue: "option_a",
        coloredOptions: true,
        optionColors: { option_a: "#ff0000" },
        allowCustomChoices: true,
        selectionLimit: { enabled: true, min: 1 },
        choiceSource: {
          mode: "form",
          formId: "catalog",
          labelFieldId: "name",
          valueFieldId: "code",
          filters: [],
          sort: "asc",
          deduplicate: true,
        },
      });
      const snapshot = copy(field);
      const converted = { ...field, ...fieldTypePatch(field, "text") };
      expect(field).toEqual(snapshot);
      expect(converted).toMatchObject({
        id: "category",
        type: "text",
        defaultValue: "",
        options: [],
        choiceSource: { mode: "manual" },
      });
      expect(converted.optionColors).toBeUndefined();
      expect(converted.selectionLimit).toBeUndefined();
      expect(converted.allowCustomChoices).toBeUndefined();
      const form = newForm("oa", "类型转换");
      form.schema.fields = [converted];
      expect(
        validateValues(parseSchema(form.schema), { category: "任意编号0001" }),
      ).toEqual([]);
    },
  );

  it("does not silently remove a computed default", () => {
    const field = createField("text", {
      defaultFormula: true,
      expression: '"编号"',
    });
    for (const type of ["select", "radio"] as const) {
      expect(fieldTypeChangeIssue(field, type)).toContain("默认值");
      expect(fieldTypePatch(field, type)).toBeUndefined();
    }
    expect(field.expression).toBe('"编号"');
    field.defaultFormula = false;
    const patch = fieldTypePatch(field, "select")!;
    expect(patch.expression).toBe("");
    expect(patch.defaultFormula).toBeUndefined();
  });

  it("follows the source distinction between linked text to dropdown and radio", () => {
    const field = createField("text", {
      defaultLink: {
        ...emptyDefaultLink(),
        enabled: true,
        formId: "catalog",
        fieldId: "name",
      },
    });
    expect(fieldTypePatch(field, "radio")).toBeUndefined();
    expect(fieldTypeChangeIssue(field, "radio")).toContain("数据联动");
    const patch = fieldTypePatch(field, "select")!;
    expect(patch.type).toBe("select");
    expect(patch.defaultLink).toBeUndefined();
    expect(field.defaultLink?.enabled).toBe(true);
  });

  it.each([
    ["select", "radio"],
    ["multiselect", "checkbox"],
  ] as const)(
    "preserves the existing live-source capability from %s to %s",
    (from, to) => {
      const field = createField(from);
      field.choiceSource.mode = "form";
      field.choiceSource.formId = "catalog";
      field.choiceSource.labelFieldId = "name";
      const source = copy(field.choiceSource);
      const options = copy(field.options);
      Object.assign(field, fieldTypePatch(field, to));
      expect(field.type).toBe(to);
      expect(field.choiceSource).toEqual(source);
      expect(field.options).toEqual(options);
    },
  );

  it("only exposes the supported conversion families", () => {
    expect(fieldTypeAlternatives("text")).toEqual(["select", "radio"]);
    expect(fieldTypeAlternatives("select")).toEqual(["text", "radio"]);
    expect(fieldTypeAlternatives("radio")).toEqual(["text", "select"]);
    expect(fieldTypeAlternatives("checkbox")).toEqual(["multiselect"]);
    expect(fieldTypeAlternatives("number")).toEqual([]);
    expect(fieldTypePatch(createField("text"), "textarea")).toBeUndefined();
    expect(fieldTypePatch(createField("select"), "select")).toBeUndefined();
    expect(fieldTypePatch(createField("multiselect"), "text")).toBeUndefined();
  });
});
