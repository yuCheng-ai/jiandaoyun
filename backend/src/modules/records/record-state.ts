import { BadRequestException, ConflictException } from "@nestjs/common";
import {
  maxSubformRows,
  fieldPermission as permission,
  type AccessGrant,
  type FieldValidationIssue,
  type FormSchema,
  type FormValues,
} from "@platform/contracts";
import { FieldValidationException, collectFieldIssues, scalar } from "./field-values";


/** 将表单 Schema 转换为草稿模式 Schema（移除所有主表字段与子表字段的必填限制） */
export function draftSchema(schema: FormSchema): FormSchema {
  return {
    ...schema,
    fields: schema.fields.map((field) => ({
      ...field,
      required: false,
      children: field.children.map((child) => ({ ...child, required: false })),
    })),
  };
}

/** 校验记录必须处于已提交的活跃状态（非草稿且未归档），否则禁止用于业务关联或流程任务 */
export function requireActiveRecord(record: { state?: string; archived_at?: unknown }) {
  if (record.state === "draft") {
    throw new ConflictException("记录尚未提交，不能用于业务关联或流程任务");
  }
  if (record.archived_at) {
    throw new ConflictException("记录已归档，不能用于业务关联或流程任务");
  }
}

/**
 * 校验正式提交记录的字段值是否符合已绑定的数据模型约束（仅做校验，不填充默认值或覆盖原存储值）
 */
export function validateSubmittedRecord(
  schema: FormSchema,
  values: FormValues,
  access: AccessGrant,
) {
  const issues: FieldValidationIssue[] = [];
  for (const field of schema.fields) {
    if (field.type !== "subform") {
      collectFieldIssues(issues, () => {
        return scalar(
          field,
          values[field.id],
          true,
          permission(access, field) === "hidden" ? undefined : {},
        );
      });
      continue;
    }

    const rows = values[field.id] ?? [];
    if (!Array.isArray(rows) || rows.length > maxSubformRows || (field.required && !rows.length)) {
      const message = `「${field.label}」的明细数量不符合要求`;
      if (permission(access, field) === "hidden") throw new BadRequestException(message);
      throw new FieldValidationException([{ fieldId: field.id, message }]);
    }

    for (const [rowIndex, row] of rows.entries()) {
      for (const child of field.children) {
        collectFieldIssues(issues, () => {
          return scalar(
            child,
            row[child.id],
            true,
            permission(access, child, field) === "hidden"
              ? undefined
              : { subformId: field.id, rowId: row._rowId, rowIndex },
          );
        });
      }
    }
  }
  if (issues.length) throw new FieldValidationException(issues);
}
