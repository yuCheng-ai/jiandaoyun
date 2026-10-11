import { BadRequestException, ConflictException } from "@nestjs/common";
import { dataModelChanges, separateFormSchema, formValidationResults, displayPlainFieldValue, selectionCountMessage, ruleFieldVisible, type DataModel, type AccessGrant, type FormField, type FormSchema, type FormValues } from "@platform/contracts";
import { permission, scalar, masked } from "./schema";

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
export function pageAcceptsVersion(scope: RecordPageScope, schema: FormSchema | undefined, version: number) {
  if (version === scope.definitionVersion) return true;
  if (version < scope.definitionVersion || !schema) return false;
  const changes = dataModelChanges(scope.model, separateFormSchema(schema).model);
  return !changes.removed.length && !changes.changed.length;
}
export function pageAccess(scope: RecordPageScope | undefined, definitionId: string, definitionVersion: number, access: AccessGrant, schema?: FormSchema): AccessGrant {
  if (!scope) return access;
  if (scope.definitionId !== definitionId || !pageAcceptsVersion(scope, schema, definitionVersion)) throw new ConflictException("页面与记录的数据版本不匹配，请选择适用的页面版本或更新记录数据版本");
  const fields: AccessGrant["fields"] = {};
  const add = (field: FormField, parent?: FormField) => {
    const current = permission(access, field, parent);
    if (!field.visible || (parent && !parent.visible) || current === "hidden") return;
    fields[field.id] = current === "edit" && field.editable && (!parent || parent.editable) ? "edit" : "read";
  };
  for (const field of scope.schema.fields) {
    add(field);
    for (const child of field.children) add(child, field);
  }
  return { ...access, fields };
}
export function validatePageSubmission(scope: RecordPageScope | undefined, values: FormValues, access: AccessGrant) {
  if (!scope) return;
  const readable = masked(scope.schema, values, {}, access);
  const validate = (field: FormField, value: unknown) => {
    scalar(field, value, !scope.deferRequired);
    const issue = !scope.deferRequired && selectionCountMessage(field, value);
    if (issue) throw new BadRequestException(`「${field.label}」${issue}`);
  };
  for (const field of readable.schema.fields) {
    if (!ruleFieldVisible(field, readable.schema, readable.values)) continue;
    if (field.type === "subform") {
      const rows = (values[field.id] as FormValues[]).filter(row => !scope.row || row._rowId === scope.row.rowId);
      if (field.required && !scope.deferRequired && !rows.length) throw new BadRequestException(`请填写${field.label}`);
      for (const row of rows) {
        const visibleRow = (readable.values[field.id] as FormValues[]).find(item => item._rowId === row._rowId) || {};
        for (const child of field.children) if (ruleFieldVisible(child, readable.schema, { ...readable.values, ...visibleRow })) validate(child, row[child.id]);
      }
    } else validate(field, values[field.id]);
  }
  // Whole-form submission rules do not change the existing workflow task path.
  if (scope.taskId) return;
  const readableRules = new Set(readable.schema.settings.validations?.map(rule => rule.id));
  // Evaluate the complete merged record; permission-hidden inputs cannot bypass constraints.
  const issue = formValidationResults(scope.schema, values, {
    displaySchema: readable.schema,
    display: displayPlainFieldValue,
  }).find(issue => issue.mode === "block");
  if (issue) throw new BadRequestException(readableRules.has(issue.ruleId)
    ? issue.message : "数据不符合表单校验条件，请联系表单管理员。");
}
