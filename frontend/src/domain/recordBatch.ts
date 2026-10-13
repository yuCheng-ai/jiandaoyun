import {
  choiceValueIssue,
  emptyFieldValue,
  validDateValue,
} from "@platform/contracts";
import { copy, type FormField, type FormSchema, type FormValues } from "./form";
import { scopeFields, resolveChoices } from "./relations";
import {
  formulaExpressionErrors,
  formulaTokens,
  formulaValue,
} from "@platform/contracts";
import type { WorkspaceData } from "./workspace";

export type RecordBatchChange = {
  fieldId: string;
  mode: "fixed" | "formula" | "empty";
  value?: unknown;
  expression?: string;
};
export type RecordBatchSelection = {
  id: string;
  definitionVersion: number;
  values: FormValues;
};
export type RecordBatchField = {
  field: FormField;
  parent?: FormField;
  label: string;
};
const mainTypes = [
  "text",
  "textarea",
  "number",
  "datetime",
  "radio",
  "select",
  "phone",
  "serial",
];
const rowTypes = ["text", "textarea", "number", "datetime"];
export const batchExcludedFunctions = [
  "SUMIF",
  "SUMIFS",
  "SUMPRODUCT",
  "IP",
  "ISEMPTY",
  "GETUSERNAME",
  "MAPX",
  "RECNO",
];

export function recordBatchFields(schema: FormSchema): RecordBatchField[] {
  return scopeFields(schema.fields).flatMap((field) =>
    field.type === "subform"
      ? scopeFields(field.children)
          .filter((child) => rowTypes.includes(child.type) && !child.unique)
          .map((child) => ({
            field: child,
            parent: field,
            label: `${field.label} · ${child.label}`,
          }))
      : mainTypes.includes(field.type) && !field.unique
        ? [{ field, label: field.label }]
        : [],
  );
}

/** Bulk expressions read original values; main fields cannot read detail arrays. */
export function recordBatchFormulaFields(
  schema: FormSchema,
  fieldId: string,
): FormField[] {
  const main = scopeFields(schema.fields),
    target = recordBatchFields(schema).find(
      (item) => item.field.id === fieldId,
    ),
    types = [
      ...mainTypes.filter((type) => type !== "phone"),
      "checkbox",
      "multiselect",
    ];
  return [
    ...main.filter((field) => types.includes(field.type)),
    ...(target?.parent
      ? scopeFields(target.parent.children).filter((field) =>
          types.includes(field.type),
        )
      : []),
  ];
}
export function recordBatchFormulaErrors(
  expression: string,
  fields: FormField[],
  type: FormField["type"],
): string[] {
  try {
    const excluded = formulaTokens(expression).find((token) =>
      batchExcludedFunctions.includes(token.text.toUpperCase()),
    );
    if (excluded) return [`批量修改不支持${excluded.text.toUpperCase()}函数`];
    return formulaExpressionErrors(expression, fields, {
      returns:
        type === "number" ? "number" : type === "datetime" ? "date" : undefined,
    });
  } catch (error) {
    return [(error as Error).message];
  }
}

/** Modify only this column. Ordinary form validation, defaults and events do not run. */
export function prepareRecordBatch(
  schema: FormSchema,
  values: FormValues,
  change: RecordBatchChange,
  data: WorkspaceData,
  now: Date,
): FormValues {
  const target = recordBatchFields(schema).find(
    (item) => item.field.id === change.fieldId,
  );
  if (!target) throw Error("该字段不支持批量修改，唯一值字段不能批改");
  if (!["fixed", "formula", "empty"].includes(change.mode))
    throw Error("请选择修改方式");
  const fields = recordBatchFormulaFields(schema, change.fieldId);
  if (change.mode === "formula") {
    const error = recordBatchFormulaErrors(
      change.expression || "",
      fields,
      target.field.type,
    )[0];
    if (error) throw Error(error);
  }
  function value(context: FormValues) {
    const field = target!.field;
    let next = change.mode === "empty" ? "" : change.value;
    if (change.mode === "formula") {
      const result = formulaValue(
        { ...field, expression: change.expression || "" },
        fields,
        context,
        (source) => resolveChoices(source, data, context, schema.fields),
        now,
      );
      if (result.error) throw Error(result.error);
      next = result.value;
      if (["radio", "select"].includes(field.type) && !emptyFieldValue(next)) {
        const option = resolveChoices(field, data, context, schema.fields).find(
          (option) => option.label === next,
        );
        if (!option) throw Error("公式结果不在可选项内");
        next = option.id;
      }
    }
    if (emptyFieldValue(next)) return field.type === "number" ? null : "";
    if (field.type === "number") {
      if (typeof next !== "number" || !Number.isFinite(next))
        throw Error("修改值必须是有效数字");
    } else if (field.type === "datetime") {
      if (!validDateValue(field.format, next))
        throw Error("修改日期格式不合法");
    } else if (["radio", "select"].includes(field.type)) {
      const error = choiceValueIssue(
        field,
        next,
        resolveChoices(field, data, context, schema.fields),
      );
      if (error) throw Error(error);
    } else if (typeof next !== "string") throw Error("修改值必须是文本");
    return copy(next);
  }
  const result = copy(values);
  if (target.parent) {
    const rows = values[target.parent.id];
    if (rows !== undefined && !Array.isArray(rows))
      throw Error("记录明细格式不合法");
    if (Array.isArray(rows))
      result[target.parent.id] = rows.map((row) => {
        if (!row || typeof row !== "object" || Array.isArray(row))
          throw Error("记录明细格式不合法");
        return { ...copy(row), [change.fieldId]: value({ ...values, ...row }) };
      });
  } else result[change.fieldId] = value(values);
  return result;
}
