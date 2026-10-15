import { BadRequestException, ForbiddenException } from "@nestjs/common";
import {
  choiceSettingsErrors,
  dateRangeErrors,
  dateScopeFields,
  emptyFieldValue,
  externalStyleErrors,
  fieldDefaultValue,
  fieldTextPropertiesErrors,
  formLayoutErrors,
  formulaReferences,
  formulaSchemaErrors,
  formulaTypes,
  hasFieldValue,
  maxSubformRows,
  fieldPermission as permission,
  readableFormValidations,
  readableVisibilityRules,
  serverFieldTypes,
  subformFixedColumnErrors,
  subformMobileErrors,
  subformPermissionSettingErrors,
  subformPermissions,
  subformWidthErrors,
  type AccessGrant,
  type FieldValidationIssue,
  type FormField,
  type FormSchema,
  type FormValues,
  type RecordCell,
} from "@platform/contracts";
import { randomUUID } from "node:crypto";
import { identifier, object } from "../../core/validation";
import {
  FieldValidationException,
  collectFieldIssues,
  scalar,
  validateFieldRules,
} from "./field-values";

/** 展平获取表单中的所有字段（含顶层字段与子表/标签页内嵌字段） */
export const allFields = (schema: FormSchema): FormField[] =>
  schema.fields.flatMap((f) => [f, ...f.children]);

/** 生成记录单元格的版本号字典键（子表单元格：`subformId/rowId/fieldId`，主表字段：`fieldId`） */
export const cellKey = (cell: RecordCell): string =>
  cell.subformId ? `${cell.subformId}/${cell.rowId}/${cell.fieldId}` : cell.fieldId;

// ============================================================================
// 2. 表单定义 Schema 校验与解析
// ============================================================================

/**
 * 校验并深拷贝表单 Schema：
 * - 拒绝当前服务端运行时无法强制执行的规则配置；
 * - 校验字段类型、子表结构、选项设置、公式引用与日期范围约束。
 */
export function parseSchema(input: unknown, allowIncomplete = false): FormSchema {
  object(input);
  object(input.settings);

  const layoutErrors = [
    ...formLayoutErrors(input.settings as FormSchema["settings"]),
    ...externalStyleErrors(input.settings as FormSchema["settings"]),
  ];
  if (layoutErrors.length) {
    throw new BadRequestException(layoutErrors[0]);
  }

  if (
    input.version !== 1 ||
    !Array.isArray(input.fields) ||
    (!allowIncomplete && input.fields.length < 1) ||
    input.fields.length > 60
  ) {
    throw new BadRequestException("表单应包含 1–60 个顶层字段");
  }

  if (!Array.isArray(input.settings.rules) || input.settings.rules.length) {
    throw new BadRequestException("当前服务端暂不支持条件显隐规则");
  }

  if (
    input.settings.frontendEvents !== undefined &&
    (!Array.isArray(input.settings.frontendEvents) || input.settings.frontendEvents.length)
  ) {
    throw new BadRequestException("当前服务端暂不支持前端事件，请保留原配置");
  }

  if (
    input.settings.validations !== undefined &&
    (!Array.isArray(input.settings.validations) || input.settings.validations.length)
  ) {
    throw new BadRequestException("当前服务端暂不支持表单提交校验，请保留原配置");
  }

  const hasInvalidHiddenValues =
    input.settings.hiddenValues && input.settings.hiddenValues !== "retain";
  const hasInvalidHiddenValueRules =
    input.settings.hiddenValueRules !== undefined &&
    (!input.settings.hiddenValueRules ||
      typeof input.settings.hiddenValueRules !== "object" ||
      Array.isArray(input.settings.hiddenValueRules) ||
      Object.keys(input.settings.hiddenValueRules).length > 0);

  if (hasInvalidHiddenValues || hasInvalidHiddenValueRules) {
    throw new BadRequestException("当前服务端暂不支持不可见字段赋值规则，请保留原配置");
  }

  const ids = new Set<string>();

  const visit = (raw: unknown, nested: boolean): FormField => {
    object(raw);
    identifier(raw.id);

    const textErrors = fieldTextPropertiesErrors(raw as FormField, nested);
    if (textErrors.length) {
      throw new BadRequestException(textErrors[0]);
    }

    if (ids.has(raw.id) || ids.size >= 120) {
      throw new BadRequestException("字段 ID 重复或字段超过 120 个");
    }
    ids.add(raw.id);

    if (
      !serverFieldTypes.includes(raw.type) ||
      raw.type === "serial" ||
      (nested && raw.type === "subform")
    ) {
      throw new BadRequestException(`「${raw.label}」暂不支持服务端执行，请保留原配置`);
    }

    const rowPermissionErrors = subformPermissionSettingErrors(raw as FormField);
    if (rowPermissionErrors.length) {
      throw new BadRequestException(rowPermissionErrors[0]);
    }

    const fixedErrors = subformFixedColumnErrors(raw as any);
    if (fixedErrors.length) {
      throw new BadRequestException(fixedErrors[0]);
    }

    const mobileErrors = subformMobileErrors(raw as any, true);
    if (mobileErrors.length) {
      throw new BadRequestException(mobileErrors[0]);
    }

    if (
      raw.subformQuickFill !== undefined &&
      (raw.type !== "subform" || typeof raw.subformQuickFill !== "boolean")
    ) {
      throw new BadRequestException("快速填报配置无效");
    }
    if (raw.subformQuickFill) {
      throw new BadRequestException("快速填报暂未接通服务端，请保留原配置");
    }

    const hasUnsupportedFieldRule =
      raw.serial !== undefined ||
      raw.unique ||
      raw.uniqueInRecord ||
      (raw.expression && !formulaTypes.includes(raw.type)) ||
      raw.masked ||
      raw.visible !== true ||
      raw.editable !== true ||
      raw.choiceSource?.mode === "form" ||
      raw.defaultLink?.enabled ||
      raw.defaultRows !== undefined ||
      (raw.defaultFormula && !formulaTypes.includes(raw.type)) ||
      raw.referenceFormId;

    if (hasUnsupportedFieldRule) {
      throw new BadRequestException(
        `「${raw.label}」含暂未接通的规则，请使用协作权限配置可见与可编辑范围`,
      );
    }

    if (
      typeof raw.required !== "boolean" ||
      !Array.isArray(raw.children) ||
      raw.children.length > 40 ||
      (raw.type !== "subform" && raw.type !== "tabs" && raw.children.length > 0)
    ) {
      throw new BadRequestException("字段结构不合法");
    }

    if (
      !Number.isInteger(raw.maxLength) ||
      raw.maxLength < 0 ||
      raw.maxLength > 10000 ||
      !Number.isInteger(raw.precision) ||
      raw.precision < 0 ||
      raw.precision > 8
    ) {
      throw new BadRequestException("长度或小数位配置不合法");
    }

    for (const bound of [raw.min, raw.max]) {
      if (bound !== undefined && (typeof bound !== "number" || !Number.isFinite(bound))) {
        throw new BadRequestException("数字范围不合法");
      }
    }

    if (
      raw.limitRange !== false &&
      raw.min !== undefined &&
      raw.max !== undefined &&
      raw.min > raw.max
    ) {
      throw new BadRequestException("数字下限不能大于上限");
    }

    const field = {
      ...structuredClone(raw),
      children: raw.children.map((c: unknown) => visit(c, true)),
    } as FormField;

    if (!allowIncomplete && field.type === "subform" && !field.children.length) {
      throw new BadRequestException("子表至少需要一列");
    }

    const choiceErrors = choiceSettingsErrors(field, allowIncomplete);
    choiceErrors.push(...subformWidthErrors(field));
    if (choiceErrors.length) {
      throw new BadRequestException(`「${field.label}」${choiceErrors[0]}`);
    }

    validateFieldRules(field, allowIncomplete, identifier);
    if (field.type !== "subform" && hasFieldValue(field)) {
      scalar(field, fieldDefaultValue(field), false);
    }

    return field;
  };

  const schema = {
    ...structuredClone(input),
    fields: input.fields.map((f: unknown) => visit(f, false)),
  } as FormSchema;

  const formulaErrors = formulaSchemaErrors(schema.fields, allowIncomplete);
  if (formulaErrors.length) {
    throw new BadRequestException(formulaErrors[0]);
  }

  for (const field of allFields(schema)) {
    const errors = dateRangeErrors(
      field,
      dateScopeFields(schema.fields, field.id),
      allowIncomplete,
    );
    if (errors.length) {
      throw new BadRequestException(`「${field.label}」${errors[0]}`);
    }
  }

  return schema;
}

/**
 * 创建新记录时校验并填充字段初始值与单元格初始版本号：
 * - 拦截未定义字段与无权写入字段；
 * - 若必填字段对当前用户不可写且无默认值，拒绝提交并提示联系管理员。
 */
export function newValues(
  schema: FormSchema,
  input: unknown,
  grant: AccessGrant,
  resolveDefault?: (field: FormField, row?: FormValues) => any,
) {
  object(input);
  const now = new Date();
  const defaultFor = resolveDefault || ((field: FormField) => fieldDefaultValue(field, now));
  const values: FormValues = {};
  const revisions: Record<string, number> = {};
  const fields = schema.fields;
  const issues: FieldValidationIssue[] = [];

  for (const key of Object.keys(input)) {
    if (!fields.some((f) => f.id === key)) {
      throw new BadRequestException("包含未定义字段");
    }
  }

  for (const field of fields) {
    const allowed = permission(grant, field) === "edit";
    if (!allowed && Object.hasOwn(input, field.id)) {
      throw new ForbiddenException("包含无权写入的字段");
    }

    if (field.type === "subform") {
      revisions[`@rows/${field.id}`] = 1;
      if (!allowed && field.required) {
        throw new ForbiddenException("当前权限无法完成必填字段，请联系管理员");
      }

      const rows = input[field.id] ?? [];
      if (
        !Array.isArray(rows) ||
        rows.length > maxSubformRows ||
        (field.required && !rows.length)
      ) {
        const message = `「${field.label}」的明细数量不符合要求`;
        if (permission(grant, field) === "hidden") throw new BadRequestException(message);
        throw new FieldValidationException([{ fieldId: field.id, message }]);
      }

      values[field.id] = rows.map((row: unknown, rowIndex: number) => {
        object(row);
        for (const key of Object.keys(row)) {
          if (!field.children.some((f) => f.id === key)) {
            throw new BadRequestException("明细包含未定义字段，行 ID 由服务端分配");
          }
        }

        const result: FormValues = { _rowId: randomUUID() };
        for (const child of field.children) {
          const canWrite = permission(grant, child, field) === "edit";
          if (!canWrite && Object.hasOwn(row, child.id)) {
            throw new ForbiddenException("包含无权写入的明细列");
          }

          const defaultValue = defaultFor(child, row);
          // 不可写且无默认值的必填明细列无法由当前成员完成
          if (!canWrite && child.required && emptyFieldValue(defaultValue)) {
            throw new ForbiddenException("当前权限无法完成必填字段，请联系管理员");
          }

          const location = permission(grant, child, field) === "hidden"
            ? undefined
            : { subformId: field.id, rowIndex };
          result[child.id] = collectFieldIssues(issues, () => {
            return scalar(
              child,
              canWrite ? (row[child.id] ?? defaultValue) : defaultValue,
              true,
              location,
            );
          });
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
      if (!allowed && field.required && emptyFieldValue(defaultValue)) {
        throw new ForbiddenException("当前权限无法完成必填字段，请联系管理员");
      }

      values[field.id] = collectFieldIssues(issues, () => {
        return scalar(
          field,
          allowed ? (input[field.id] ?? defaultValue) : defaultValue,
          true,
          permission(grant, field) === "hidden" ? undefined : {},
        );
      });
      revisions[field.id] = 1;
    }
  }

  if (issues.length) throw new FieldValidationException(issues);
  return { values, revisions };
}

/**
 * 按用户授权对表单 Schema、记录值与单元格版本号执行服务端脱敏过滤：
 * - 移除 `hidden` 级别的顶层字段与子表列；
 * - 若默认值公式引用了不可见字段，剥离公式表达式配置以防泄露隐藏字段结构；
 * - 同步裁剪仅对可见字段生效的显隐规则与表单校验规则。
 */
export function masked(
  schema: FormSchema,
  values: FormValues,
  revisions: Record<string, number>,
  grant: AccessGrant,
) {
  const result: FormValues = {};
  const cells: Record<string, number> = {};
  const rows: Record<string, number> = {};

  const fields = schema.fields
    .filter((f) => permission(grant, f) !== "hidden")
    .map((field) => {
      const clone = structuredClone(field);
      if (field.type === "subform") {
        rows[field.id] = revisions[`@rows/${field.id}`] || 1;
        clone.children = clone.children.filter((c) => permission(grant, c, field) !== "hidden");
        result[field.id] = ((values[field.id] || []) as FormValues[]).map((row) => {
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
        });
      } else {
        result[field.id] = values[field.id];
        cells[field.id] = revisions[field.id]!;
      }
      return clone;
    });

  const allowed = new Set(
    fields.flatMap((field) => [field.id, ...field.children.map((child) => child.id)]),
  );

  // 默认值计算结果可在授权后展示，但若引用了隐藏字段，不得向前端暴露其公式源码
  for (const field of fields.flatMap((f) => [f, ...f.children])) {
    if (field.defaultFormula && formulaReferences(field.expression).some((id) => !allowed.has(id))) {
      field.defaultFormula = false;
      field.expression = "";
      delete field.formulaRemark;
    }
  }

  const rules = readableVisibilityRules(schema.settings.rules, allowed);
  const validations = readableFormValidations(schema.settings.validations, allowed);

  return {
    schema: { ...schema, fields, settings: { ...schema.settings, rules, validations } },
    values: result,
    cells,
    rows,
  };
}

/** 计算子表行操作策略：页面级配置只能收紧数据版本的权限，不能放大 */
export function rowPolicy(field: FormField, pageField?: FormField) {
  const policy = subformPermissions(
    pageField ? pageField.subformPermissions : field.subformPermissions,
  );
  if (pageField && field.subformPermissions) {
    const data = subformPermissions(field.subformPermissions);
    for (const key of Object.keys(policy) as (keyof typeof policy)[]) {
      policy[key] &&= data[key];
    }
  }
  return policy;
}

/** 汇总所有可见子表的行级操作权限（新增行、插入行、编辑存量行、删除存量行） */
export function rowActions(schema: FormSchema, access: AccessGrant, page?: FormSchema) {
  return Object.fromEntries(
    schema.fields
      .filter((field) => field.type === "subform" && permission(access, field) !== "hidden")
      .map((field) => {
        const editable = access.edit && permission(access, field) === "edit";
        const pageField = page?.fields.find((item) => item.id === field.id);
        const policy = rowPolicy(field, pageField);
        const canEditAllColumns = field.children.every(
          (child) => permission(access, child, field) === "edit",
        );

        return [
          field.id,
          {
            add: editable && policy.add,
            insert: editable && policy.insert,
            editExisting: editable && policy.editExisting,
            remove: editable && policy.deleteExisting && canEditAllColumns,
          },
        ];
      }),
  );
}
