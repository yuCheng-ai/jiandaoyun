import { BadRequestException, ConflictException } from "@nestjs/common";
import {
  dataModelChanges,
  separateFormSchema,
  formValidationResults,
  displayPlainFieldValue,
  selectionCountMessage,
  ruleFieldVisible,
  type DataModel,
  type AccessGrant,
  type FormField,
  type FormSchema,
  type FormValues,
} from "@platform/contracts";
import { permission, scalar, masked } from "../../core/database/schema";

/** 页面级记录读写上下文：绑定页面版本、关联的数据模型版本及可选的任务/明细行范围 */
export interface RecordPageScope {
  id: string;
  title: string;
  version: number;
  definitionId: string;
  definitionVersion: number;
  schema: FormSchema;
  model: DataModel;
  taskId?: string;
  deferRequired?: boolean;
  row?: { subformId: string; rowId: string };
}

/**
 * 判断指定页面版本是否兼容目标数据定义版本：
 * - 版本相同直接兼容；
 * - 若记录数据版本高于页面绑定版本，仅在未发生字段移除与约束变更（纯增量字段）时兼容。
 */
export function pageAcceptsVersion(
  scope: RecordPageScope,
  schema: FormSchema | undefined,
  version: number,
): boolean {
  if (version === scope.definitionVersion) return true;
  if (version < scope.definitionVersion || !schema) return false;
  const changes = dataModelChanges(scope.model, separateFormSchema(schema).model);
  return !changes.removed.length && !changes.changed.length;
}

/**
 * 结合页面控件的显隐与可编辑属性，收敛用户在底层数据对象上的字段权限
 */
export function pageAccess(
  scope: RecordPageScope | undefined,
  definitionId: string,
  definitionVersion: number,
  access: AccessGrant,
  schema?: FormSchema,
): AccessGrant {
  if (!scope) return access;
  if (scope.definitionId !== definitionId || !pageAcceptsVersion(scope, schema, definitionVersion)) {
    throw new ConflictException("页面与记录的数据版本不匹配，请选择适用的页面版本或更新记录数据版本");
  }

  const fields: AccessGrant["fields"] = {};
  const addFieldPermission = (field: FormField, parent?: FormField) => {
    const current = permission(access, field, parent);
    if (!field.visible || (parent && !parent.visible) || current === "hidden") return;
    const canEdit = current === "edit" && field.editable && (!parent || parent.editable);
    fields[field.id] = canEdit ? "edit" : "read";
  };

  for (const field of scope.schema.fields) {
    addFieldPermission(field);
    for (const child of field.children) {
      addFieldPermission(child, field);
    }
  }

  return { ...access, fields };
}

/**
 * 校验基于特定页面提交的记录数据：
 * - 按条件显隐规则（基于当前用户可见字段计算）校验必填项、标量格式与多选数量限制；
 * - 非流程任务直提时，对完整合并后的记录执行整表校验规则（防止通过隐藏字段绕过业务约束）。
 */
export function validatePageSubmission(
  scope: RecordPageScope | undefined,
  values: FormValues,
  access: AccessGrant,
) {
  if (!scope) return;

  const readable = masked(scope.schema, values, {}, access);
  const validateScalar = (field: FormField, value: unknown) => {
    scalar(field, value, !scope.deferRequired);
    const issue = !scope.deferRequired && selectionCountMessage(field, value);
    if (issue) throw new BadRequestException(`「${field.label}」${issue}`);
  };

  for (const field of readable.schema.fields) {
    if (!ruleFieldVisible(field, readable.schema, readable.values)) continue;

    if (field.type === "subform") {
      const rows = (values[field.id] as FormValues[]).filter(
        (row) => !scope.row || row._rowId === scope.row.rowId,
      );
      if (field.required && !scope.deferRequired && !rows.length) {
        throw new BadRequestException(`请填写${field.label}`);
      }
      for (const row of rows) {
        const visibleRow =
          (readable.values[field.id] as FormValues[]).find((item) => item._rowId === row._rowId) || {};
        for (const child of field.children) {
          if (ruleFieldVisible(child, readable.schema, { ...readable.values, ...visibleRow })) {
            validateScalar(child, row[child.id]);
          }
        }
      }
    } else {
      validateScalar(field, values[field.id]);
    }
  }

  // 流程节点任务沿用原有节点必填校验路径，不触发整表拦截规则
  if (scope.taskId) return;

  const readableRules = new Set(readable.schema.settings.validations?.map((rule) => rule.id));
  // 对完整合并后的记录执行表单级校验，避免权限隐藏字段绕过校验约束
  const issue = formValidationResults(scope.schema, values, {
    displaySchema: readable.schema,
    display: displayPlainFieldValue,
  }).find((item) => item.mode === "block");

  if (issue) {
    const message = readableRules.has(issue.ruleId)
      ? issue.message
      : "数据不符合表单校验条件，请联系表单管理员。";
    throw new BadRequestException(message);
  }
}
