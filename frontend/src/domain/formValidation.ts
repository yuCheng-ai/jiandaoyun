import type {
  FormSchema,
  FormValues,
  FormValidationRule,
  FormField,
  FieldOption,
} from "@platform/contracts";
import {
  evaluateFieldFormula,
  formulaExpressionErrors,
  formulaFields,
  formulaReferences,
  formulaTokens,
} from "./formula";
import { displayValue, resolveChoices } from "./relations";
import { isFieldVisible } from "./form";
import type { WorkspaceData } from "./workspace";

export type FormValidationIssue = {
  ruleId: string;
  message: string;
  mode: "block" | "warn";
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
    data?: WorkspaceData;
    displaySchema?: FormSchema;
    ruleIds?: ReadonlySet<string>;
  } = {},
): FormValidationIssue[] {
  const options = context.data
    ? (field: FormField): FieldOption[] => {
        // Dynamic options are resolved by the caller's already scoped runtime data.
        return resolveChoices(field, context.data!, values, schema.fields);
      }
    : undefined;
  const available = formulaFields((context.displaySchema || schema).fields);
  const message = (rule: FormValidationRule) =>
    rule.message.replace(/\{\{([a-zA-Z0-9_.:-]+)\}\}/g, (_, id: string) => {
      const item = available.find((item) => item.field.id === id);
      if (!item || !findVisibleColumn(item.field.id)) return "—";
      const render = (value: unknown) =>
        context.data
          ? displayValue(item.field, value, context.data)
          : String(value ?? "");
      return item.column
        ? Array.isArray(values[item.column])
          ? (values[item.column] as FormValues[])
              .map((row) => render(row[id]))
              .join("、")
          : ""
        : render(values[id]);
    });
  function findVisibleColumn(id: string) {
    const visit = (fields: FormField[]): boolean =>
      fields.some(
        (field) =>
          isFieldVisible(field, context.displaySchema || schema, values) &&
          (field.id === id || visit(field.children)),
      );
    return visit((context.displaySchema || schema).fields);
  }
  return (schema.settings.validations || []).flatMap((rule) => {
    if (context.ruleIds && !context.ruleIds.has(rule.id)) return [];
    const invalid = formValidationErrors(rule, schema.fields)[0];
    if (invalid)
      return [
        {
          ruleId: rule.id,
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
          mode: "block" as const,
          message: "数据校验未完成，请检查条件涉及的填写内容。",
        },
      ];
    return result.value
      ? []
      : [{ ruleId: rule.id, mode: rule.mode, message: message(rule) }];
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
