import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import {
  serverFieldTypes,
  maxSubformRows,
  emptyFieldValue,
  fieldDefaultValue,
  dateRangeErrors,
  dateScopeFields,
  choiceSettingsErrors,
  formLayoutErrors,
  externalStyleErrors,
  subformWidthErrors,
  subformFixedColumnErrors,
  subformMobileErrors,
  subformPermissionSettingErrors,
  fieldTextPropertiesErrors,
} from "@platform/contracts";
import { scalar, validateFieldRules } from "./field-values";
export { scalar } from "./field-values";
import type {
  AccessGrant,
  FormField,
  FormSchema,
  FormValues,
  RecordCell,
} from "@platform/contracts";

export function object(value: unknown): asserts value is Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new BadRequestException("需要对象格式");
}
export function identifier(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^[a-zA-Z][a-zA-Z0-9_-]{0,99}$/.test(value) ||
    ["constructor", "prototype", "__proto__"].includes(value)
  )
    throw new BadRequestException("标识不合法");
}
export function uuid(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  )
    throw new BadRequestException("记录或请求标识不合法");
}
export function title(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > 100)
    throw new BadRequestException("名称应为 1–100 个字符");
}
export const allFields = (schema: FormSchema) =>
  schema.fields.flatMap((f) => [f, ...f.children]);

// The first server runtime deliberately rejects rules it cannot enforce.
export function parseSchema(
  input: unknown,
  allowIncomplete = false,
): FormSchema {
  object(input);
  object(input.settings);
  const layoutErrors = [
    ...formLayoutErrors(input.settings as FormSchema["settings"]),
    ...externalStyleErrors(input.settings as FormSchema["settings"]),
  ];
  if (layoutErrors.length) throw new BadRequestException(layoutErrors[0]);
  if (
    input.version !== 1 ||
    !Array.isArray(input.fields) ||
    (!allowIncomplete && input.fields.length < 1) ||
    input.fields.length > 60
  )
    throw new BadRequestException("表单应包含 1–60 个顶层字段");
  if (!Array.isArray(input.settings.rules) || input.settings.rules.length)
    throw new BadRequestException("当前服务端暂不支持条件显隐规则");
  if (
    input.settings.frontendEvents !== undefined &&
    (!Array.isArray(input.settings.frontendEvents) ||
      input.settings.frontendEvents.length)
  )
    throw new BadRequestException("当前服务端暂不支持前端事件，请保留原配置");
  if (
    input.settings.validations !== undefined &&
    (!Array.isArray(input.settings.validations) ||
      input.settings.validations.length)
  )
    throw new BadRequestException(
      "当前服务端暂不支持表单提交校验，请保留原配置",
    );
  if (
    (input.settings.hiddenValues && input.settings.hiddenValues !== "retain") ||
    (input.settings.hiddenValueRules !== undefined &&
      (!input.settings.hiddenValueRules ||
        typeof input.settings.hiddenValueRules !== "object" ||
        Array.isArray(input.settings.hiddenValueRules) ||
        Object.keys(input.settings.hiddenValueRules).length))
  )
    throw new BadRequestException(
      "当前服务端暂不支持不可见字段赋值规则，请保留原配置",
    );
  const ids = new Set<string>();
  const visit = (raw: unknown, nested: boolean): FormField => {
    object(raw);
    identifier(raw.id);
    const textErrors = fieldTextPropertiesErrors(raw as FormField, nested);
    if (textErrors.length) throw new BadRequestException(textErrors[0]);
    if (ids.has(raw.id) || ids.size >= 120)
      throw new BadRequestException("字段 ID 重复或字段超过 120 个");
    ids.add(raw.id);
    if (
      !serverFieldTypes.includes(raw.type) ||
      (nested && raw.type === "subform")
    )
      throw new BadRequestException(
        `「${raw.label}」暂不支持服务端执行，请保留原配置`,
      );
    const rowPermissionErrors = subformPermissionSettingErrors(
      raw as FormField,
    );
    if (rowPermissionErrors.length)
      throw new BadRequestException(rowPermissionErrors[0]);
    const fixedErrors = subformFixedColumnErrors(raw as any);
    if (fixedErrors.length) throw new BadRequestException(fixedErrors[0]);
    const mobileErrors = subformMobileErrors(raw as any, true);
    if (mobileErrors.length) throw new BadRequestException(mobileErrors[0]);
    if (
      raw.subformQuickFill !== undefined &&
      (raw.type !== "subform" || typeof raw.subformQuickFill !== "boolean")
    )
      throw new BadRequestException("快速填报配置无效");
    if (raw.subformQuickFill)
      throw new BadRequestException("快速填报暂未接通服务端，请保留原配置");
    if (
      raw.subformPermissions &&
      Object.values(raw.subformPermissions).some((value) => value === false)
    )
      throw new BadRequestException(
        "子表单操作权限暂未接通服务端，请保留原配置",
      );
    if (
      raw.serial !== undefined ||
      raw.unique ||
      raw.uniqueInRecord ||
      raw.expression ||
      raw.masked ||
      raw.visible !== true ||
      raw.editable !== true ||
      raw.choiceSource?.mode === "form" ||
      raw.defaultLink?.enabled ||
      raw.defaultRows !== undefined ||
      raw.defaultFormula ||
      raw.referenceFormId
    )
      throw new BadRequestException(
        `「${raw.label}」含暂未接通的规则，请使用协作权限配置可见与可编辑范围`,
      );
    if (
      typeof raw.required !== "boolean" ||
      !Array.isArray(raw.children) ||
      raw.children.length > 40 ||
      (raw.type !== "subform" && raw.children.length)
    )
      throw new BadRequestException("字段结构不合法");
    if (
      !Number.isInteger(raw.maxLength) ||
      raw.maxLength < 0 ||
      raw.maxLength > 10000 ||
      !Number.isInteger(raw.precision) ||
      raw.precision < 0 ||
      raw.precision > 8
    )
      throw new BadRequestException("长度或小数位配置不合法");
    for (const bound of [raw.min, raw.max])
      if (
        bound !== undefined &&
        (typeof bound !== "number" || !Number.isFinite(bound))
      )
        throw new BadRequestException("数字范围不合法");
    if (
      raw.limitRange !== false &&
      raw.min !== undefined &&
      raw.max !== undefined &&
      raw.min > raw.max
    )
      throw new BadRequestException("数字下限不能大于上限");
    const field = {
      ...structuredClone(raw),
      children: raw.children.map((c: unknown) => visit(c, true)),
    } as FormField;
    if (!allowIncomplete && field.type === "subform" && !field.children.length)
      throw new BadRequestException("子表至少需要一列");
    const choiceErrors = choiceSettingsErrors(field, allowIncomplete);
    choiceErrors.push(...subformWidthErrors(field));
    if (choiceErrors.length)
      throw new BadRequestException(`「${field.label}」${choiceErrors[0]}`);
    validateFieldRules(field, allowIncomplete, identifier);
    if (field.type !== "subform")
      scalar(field, fieldDefaultValue(field), false);
    return field;
  };
  const schema = {
    ...structuredClone(input),
    fields: input.fields.map((f: unknown) => visit(f, false)),
  } as FormSchema;
  for (const field of allFields(schema)) {
    const errors = dateRangeErrors(
      field,
      dateScopeFields(schema.fields, field.id),
      allowIncomplete,
    );
    if (errors.length)
      throw new BadRequestException(`「${field.label}」${errors[0]}`);
  }
  return schema;
}
export const cellKey = (cell: RecordCell) =>
  cell.subformId
    ? `${cell.subformId}/${cell.rowId}/${cell.fieldId}`
    : cell.fieldId;
export function permission(
  grant: AccessGrant,
  field: FormField,
  parent?: FormField,
) {
  const own = grant.fields[field.id] || "hidden";
  const outer = parent ? grant.fields[parent.id] || "hidden" : "edit";
  if ((!grant.read && !grant.create) || own === "hidden" || outer === "hidden")
    return "hidden";
  return own === "edit" && outer === "edit" ? "edit" : "read";
}
export function newValues(
  schema: FormSchema,
  input: unknown,
  grant: AccessGrant,
  resolveDefault?: (field: FormField, row?: FormValues) => any,
) {
  object(input);
  const now = new Date(),
    defaultFor =
      resolveDefault || ((field: FormField) => fieldDefaultValue(field, now));
  const values: FormValues = {},
    revisions: Record<string, number> = {};
  const fields = schema.fields;
  for (const key of Object.keys(input))
    if (!fields.some((f) => f.id === key))
      throw new BadRequestException("包含未定义字段");
  for (const field of fields) {
    const allowed = permission(grant, field) === "edit";
    if (!allowed && Object.hasOwn(input, field.id))
      throw new ForbiddenException("包含无权写入的字段");
    if (field.type === "subform") {
      revisions[`@rows/${field.id}`] = 1;
      if (!allowed && field.required)
        throw new ForbiddenException("当前权限无法完成必填字段，请联系管理员");
      const rows = input[field.id] ?? [];
      if (
        !Array.isArray(rows) ||
        rows.length > maxSubformRows ||
        (field.required && !rows.length)
      )
        throw new BadRequestException(`「${field.label}」的明细数量不符合要求`);
      values[field.id] = rows.map((row: unknown) => {
        object(row);
        for (const key of Object.keys(row))
          if (!field.children.some((f) => f.id === key))
            throw new BadRequestException(
              "明细包含未定义字段，行 ID 由服务端分配",
            );
        const result: FormValues = { _rowId: randomUUID() };
        for (const child of field.children) {
          const canWrite = permission(grant, child, field) === "edit";
          if (!canWrite && Object.hasOwn(row, child.id))
            throw new ForbiddenException("包含无权写入的明细列");
          const defaultValue = defaultFor(child, row);
          // Hidden required fields with no default cannot be completed by this member.
          if (!canWrite && child.required && emptyFieldValue(defaultValue))
            throw new ForbiddenException(
              "当前权限无法完成必填字段，请联系管理员",
            );
          result[child.id] = scalar(
            child,
            canWrite ? (row[child.id] ?? defaultValue) : defaultValue,
          );
          revisions[
            cellKey({
              subformId: field.id,
              rowId: String(result._rowId),
              fieldId: child.id,
            })
          ] = 1;
        }
        return result;
      });
    } else {
      const defaultValue = defaultFor(field);
      if (!allowed && field.required && emptyFieldValue(defaultValue))
        throw new ForbiddenException("当前权限无法完成必填字段，请联系管理员");
      values[field.id] = scalar(
        field,
        allowed ? (input[field.id] ?? defaultValue) : defaultValue,
      );
      revisions[field.id] = 1;
    }
  }
  return { values, revisions };
}
export function masked(
  schema: FormSchema,
  values: FormValues,
  revisions: Record<string, number>,
  grant: AccessGrant,
) {
  const result: FormValues = {},
    cells: Record<string, number> = {},
    rows: Record<string, number> = {};
  const fields = schema.fields
    .filter((f) => permission(grant, f) !== "hidden")
    .map((field) => {
      const clone = structuredClone(field);
      if (field.type === "subform") {
        rows[field.id] = revisions[`@rows/${field.id}`] || 1;
        clone.children = field.children.filter(
          (c) => permission(grant, c, field) !== "hidden",
        );
        result[field.id] = ((values[field.id] || []) as FormValues[]).map(
          (row) => {
            const filtered: FormValues = { _rowId: row._rowId };
            for (const child of clone.children) {
              filtered[child.id] = row[child.id];
              const key = cellKey({
                subformId: field.id,
                rowId: String(row._rowId),
                fieldId: child.id,
              });
              cells[key] = revisions[key]!;
            }
            return filtered;
          },
        );
      } else {
        result[field.id] = values[field.id];
        cells[field.id] = revisions[field.id]!;
      }
      return clone;
    });
  return { schema: { ...schema, fields }, values: result, cells, rows };
}
export function rowActions(schema: FormSchema, access: AccessGrant) {
  return Object.fromEntries(
    schema.fields
      .filter(
        (field) =>
          field.type === "subform" && permission(access, field) !== "hidden",
      )
      .map((field) => {
        const editable = access.edit && permission(access, field) === "edit";
        return [
          field.id,
          {
            add: editable,
            remove:
              editable &&
              field.children.every(
                (child) => permission(access, child, field) === "edit",
              ),
          },
        ];
      }),
  );
}
