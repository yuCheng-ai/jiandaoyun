import type {
  FormSchema,
  FormValues,
  FormValidationRule,
  FormField,
  FieldOption,
} from "./form";
import {
  evaluateFieldFormula,
  formulaExpressionErrors,
  formulaFields,
  formulaReferences,
  formulaTokens,
} from "./formula";
import { ruleFieldVisible } from "./visibility";

export type FormValidationIssue = {
  ruleId: string;
  message: string;
  mode: "block" | "warn";
  fieldIds?: string[];
};
export const messageReferences = (message: string) => [
  ...new Set(
    Array.from(
      message.matchAll(/\{\{([a-zA-Z0-9_.:-]+)\}\}/g),
      (match) => match[1]!,
    ),
  ),
];
export const validationReferences = (rule: FormValidationRule) => [
  ...new Set([
    ...formulaReferences(rule.expression),
    ...messageReferences(rule.message),
  ]),
];

export function formValidationErrors(
  rule: FormValidationRule,
  fields: FormField[],
): string[] {
  const errors = formulaExpressionErrors(rule.expression, fields, {
    returns: "boolean",
  });
  if (!rule.message.trim()) errors.push("请填写不满足校验条件时的提示文字");
  const available = formulaFields(fields);
  if (
    messageReferences(rule.message).some(
      (id) => !available.some((item) => item.field.id === id),
    )
  )
    errors.push("提示文字引用的字段已失效");
  if (
    !["block", "warn"].includes(rule.mode) ||
    typeof rule.realtime !== "boolean"
  )
    errors.push("数据校验设置不合法");
  return errors;
}

/** Business labels are presentation only; persisted references always keep field IDs. */
export function formulaLabel(expression: string, fields: FormField[]): string {
  const available = formulaFields(fields);
  try {
    let text = "",
      end = 0;
    for (const token of formulaTokens(expression)) {
      if (!token.text.startsWith("{{")) continue;
      const id = token.text.slice(2, -2);
      text +=
        expression.slice(end, token.start) +
        (available.find((item) => item.field.id === id)?.label || "已失效字段");
      end = token.end;
    }
    return text + expression.slice(end);
  } catch {
    return expression;
  }
}

export function formValidationResults(
  schema: FormSchema,
  values: FormValues,
  context: {
    options?: (field: FormField) => FieldOption[];
    display?: (field: FormField, value: unknown) => string;
    visible?: (field: FormField, schema: FormSchema, values: FormValues) => boolean;
    displaySchema?: FormSchema;
    ruleIds?: ReadonlySet<string>;
  } = {},
): FormValidationIssue[] {
  const options = context.options;
  const displaySchema = context.displaySchema || schema;
  const visible = context.visible || ruleFieldVisible;
  const available = formulaFields(displaySchema.fields);
  const message = (rule: FormValidationRule) =>
    rule.message.replace(/\{\{([a-zA-Z0-9_.:-]+)\}\}/g, (_, id: string) => {
      const item = available.find((item) => item.field.id === id);
      if (!item || !findVisibleColumn(item.field.id)) return "—";
      const render = (value: unknown) =>
        context.display ? context.display(item.field, value) : String(value ?? "");
      if (!item.column) return render(values[id]);
      const rows = values[item.column];
      if (!Array.isArray(rows)) return "";
      return rows.map((row) => {
        if (!visible(item.field, displaySchema, { ...values, ...row })) return "—";
        return render(row[id]);
      }).join("、");
    });
  function findVisibleColumn(id: string) {
    const visit = (fields: FormField[], current: FormValues): boolean =>
      fields.some((field) => {
        if (!visible(field, displaySchema, current)) return false;
        if (field.id === id) return true;
        if (field.type === "subform") {
          const rows = current[field.id];
          if (Array.isArray(rows) && rows.length) {
            return rows.some((row) => visit(field.children, { ...current, ...row }));
          }
        }
        return visit(field.children, current);
      });
    return visit(displaySchema.fields, values);
  }

  return (schema.settings.validations || []).flatMap((rule) => {
    if (context.ruleIds && !context.ruleIds.has(rule.id)) return [];
    // 只标记表达式实际涉及且当前可见的字段，不能从提示文案猜测或暴露隐藏字段。
    const fieldIds = formulaReferences(rule.expression).filter(findVisibleColumn);
    const invalid = formValidationErrors(rule, schema.fields)[0];
    if (invalid)
      return [
        {
          ruleId: rule.id,
          fieldIds,
          mode: "block" as const,
          message: "数据校验设置已失效，请联系表单管理员调整。",
        },
      ];
    const result = evaluateFieldFormula(
      rule.expression,
      schema.fields,
      values,
      { options, strictCalculated: true },
    );
    if (result.error || typeof result.value !== "boolean")
      return [
        {
          ruleId: rule.id,
          fieldIds,
          mode: "block" as const,
          message: "数据校验未完成，请检查条件涉及的填写内容。",
        },
      ];
    return result.value
      ? []
      : [{ ruleId: rule.id, mode: rule.mode, message: message(rule), fieldIds }];
  });
}

/** A detail column participates only when that column's values changed. */
export function changedValidationRules(
  schema: FormSchema,
  before: FormValues,
  after: FormValues,
): string[] {
  const available = formulaFields(schema.fields);
  const read = (id: string, values: FormValues) => {
    const item = available.find((item) => item.field.id === id);
    return item?.column
      ? Array.isArray(values[item.column])
        ? (values[item.column] as FormValues[]).map((row) => row[id])
        : []
      : values[id];
  };
  return (schema.settings.validations || [])
    .filter(
      (rule) =>
        rule.realtime &&
        formulaReferences(rule.expression).some(
          (id) =>
            JSON.stringify(read(id, before)) !==
            JSON.stringify(read(id, after)),
        ),
    )
    .map((rule) => rule.id);
}

export function blockingFormValidation(
  schema: FormSchema,
  values: FormValues,
  context: Parameters<typeof formValidationResults>[2] = {},
): string[] {
  return formValidationResults(schema, values, context)
    .filter((issue) => issue.mode === "block")
    .map((issue) => issue.message);
}

/** Reject malformed rules instead of silently dropping existing validation settings. */
export function validateFormValidations(raw: unknown, fields: FormField[]): FormValidationRule[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 200) throw Error("数据校验设置不合法");
  const ids = new Set<string>();
  return raw.map(rule => {
    if (!rule || typeof rule !== "object" || Array.isArray(rule) ||
      Object.keys(rule).some(key => !["id", "expression", "message", "realtime", "mode", "remark"].includes(key)) ||
      typeof rule.id !== "string" || !rule.id.trim() || rule.id.length > 200 || ids.has(rule.id) ||
      typeof rule.expression !== "string" || typeof rule.message !== "string" || rule.message.length > 10000 ||
      typeof rule.realtime !== "boolean" || !["block", "warn"].includes(rule.mode) ||
      (rule.remark !== undefined && (typeof rule.remark !== "string" || rule.remark.length > 10000)))
      throw Error("数据校验设置不合法");
    const errors = formValidationErrors(rule, fields);
    if (errors.length) throw Error(errors[0]);
    ids.add(rule.id);
    return structuredClone(rule) as FormValidationRule;
  });
}

export const readableFormValidations = (rules: FormValidationRule[] | undefined, allowedIds: ReadonlySet<string>) =>
  (rules || []).filter(rule => validationReferences(rule).every(id => allowedIds.has(id)));
