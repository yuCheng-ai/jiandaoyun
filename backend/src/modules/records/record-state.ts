import { BadRequestException, ConflictException } from "@nestjs/common";
import { maxSubformRows, type FormSchema, type FormValues } from "@platform/contracts";
import { scalar } from "../../core/database/schema";

export function draftSchema(schema: FormSchema): FormSchema {
  return { ...schema, fields: schema.fields.map(field => ({ ...field, required: false, children: field.children.map(child => ({ ...child, required: false })) })) };
}
export function requireActiveRecord(record: { state?: string; archived_at?: unknown }) {
  if (record.state === "draft") throw new ConflictException("记录尚未提交，不能用于业务关联或流程任务");
  if (record.archived_at) throw new ConflictException("记录已归档，不能用于业务关联或流程任务");
}
/** Check the pinned data contract without filling defaults or replacing stored values. */
export function validateSubmittedRecord(schema: FormSchema, values: FormValues) {
  for (const field of schema.fields) {
    if (field.type !== "subform") { scalar(field, values[field.id]); continue; }
    const rows = values[field.id] ?? [];
    if (!Array.isArray(rows) || rows.length > maxSubformRows || (field.required && !rows.length)) throw new BadRequestException(`「${field.label}」的明细数量不符合要求`);
    for (const row of rows) for (const child of field.children) scalar(child, row[child.id]);
  }
}
