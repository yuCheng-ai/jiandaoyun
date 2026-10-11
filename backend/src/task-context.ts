import { requireActiveRecord } from "./record-state";
import { BadRequestException, ForbiddenException, Injectable } from "@nestjs/common";
import type { FormField, FormSchema, FormValues, RecordDetail, TaskSpec } from "@platform/contracts";
import { recordCreator } from "./historical-identities";
import type { Actor } from "./auth";
import type { Transaction } from "./database";
import { PageService } from "./pages";
import { PlatformService, definitionDto, recordDto } from "./platform";
import { pageAccess, validatePageSubmission, type RecordPageScope } from "./page-runtime";
import { allFields, masked, permission, rowActions, scalar } from "./schema";

@Injectable()
export class TaskContextService {
  constructor(private readonly platform: PlatformService, private readonly pages: PageService) {}
  async scope(actor: Actor, task: TaskSpec, tx?: Transaction, allowArchived = true): Promise<RecordPageScope | undefined> {
    if (!task.pageId) return undefined;
    const scope = await this.pages.recordScope(actor, task.pageId, task.pageVersion!, tx, allowArchived);
    scope.taskId = task.id;
    scope.schema = structuredClone(scope.schema);
    const required = new Set(task.requiredFields || []);
    if ([...required].some(id => !allFields(scope.schema).some(f => f.id === id))) throw new BadRequestException("任务要求的字段不在处理页面中");
    for (const field of scope.schema.fields) {
      if (required.has(field.id)) field.required = true;
      for (const child of field.children) if (required.has(child.id)) child.required = true;
    }
    if (task.subformId) {
      if (!task.rowId || !scope.schema.fields.some(f => f.id === task.subformId && f.type === "subform" && f.visible)) throw new BadRequestException("处理页面不包含任务明细");
      scope.row = { subformId: task.subformId, rowId: task.rowId };
      scope.schema.fields = scope.schema.fields.filter(f => f.type !== "subform" || f.id === task.subformId).map(f => f.id === task.subformId ? f : { ...f, editable: false, required: false });
    }
    return scope;
  }
  async load(tx: Transaction, actor: Actor, recordId: string, task: TaskSpec, allowArchived = true) {
    const source = await this.platform.loadRecord(tx, actor, recordId), scope = await this.scope(actor, task, tx, allowArchived);
    requireActiveRecord(source.row);
    const access = pageAccess(scope, source.row.definition_id, source.row.definition_version, source.access, source.version.schema);
    const schema = scope?.schema || source.version.schema as FormSchema;
    if (task.subformId) {
      const field = schema.fields.find(f => f.id === task.subformId);
      if (!field || permission(access, field) === "hidden") throw new ForbiddenException("当前成员没有任务明细的访问权限");
      if (!(source.row.values[task.subformId] as FormValues[])?.some(row => row._rowId === task.rowId)) throw new BadRequestException("任务绑定的明细行已不存在");
    }
    const assertRequired = (field: FormField, parent?: FormField) => {
      if (field.required && permission(access, field, parent) === "hidden") throw new ForbiddenException("当前成员无法查看任务要求填写的字段");
    };
    for (const field of schema.fields) { assertRequired(field); field.children.forEach(child => assertRequired(child, field)); }
    return { ...source, scope, access, schema };
  }
  async validateCompletion(tx: Transaction, actor: Actor, recordId: string, task: TaskSpec, allowArchived = true) {
    const source = await this.load(tx, actor, recordId, task);
    validatePageSubmission(source.scope, source.row.values, source.access);
    if (!source.scope) {
      for (const id of task.requiredFields || []) {
        const field = source.schema.fields.find(f => f.id === id && f.type !== "subform");
        if (!field || permission(source.access, field) === "hidden") throw new ForbiddenException("无法检查任务要求的字段");
        scalar({ ...field, required: true }, source.row.values[id]);
      }
    }
  }
  async record(tx: Transaction, actor: Actor, processId: string, task: any): Promise<RecordDetail> {
    const spec = task.spec as TaskSpec, source = await this.load(tx, actor, task.record_id, spec);
    const writable = task.status === "ready", access = { ...source.access, edit: source.access.edit && writable };
    if (!writable) access.fields = Object.fromEntries(Object.entries(access.fields).map(([key, value]) => [key, value === "edit" ? "read" : value]));
    const values = structuredClone(source.row.values);
    if (source.scope?.row) values[source.scope.row.subformId] = values[source.scope.row.subformId].filter((row: FormValues) => row._rowId === source.scope!.row!.rowId);
    const visible = masked(source.schema, values, source.row.cell_revisions, access);
    return {
      task: { processId, taskId: task.id, title: spec.title, writable: access.edit, ...(spec.rowId ? { rowId: spec.rowId, subformId: spec.subformId } : {}) },
      ...(source.scope ? { page: { id: source.scope.id, version: source.scope.version, title: (source.scope as any).title } } : {}),
      creator: await recordCreator(tx, actor, source.row.created_by),
      identities: await this.platform.identityLabels(tx, actor, visible.schema, visible.values),
      definition: { ...definitionDto(source.version), schema: visible.schema }, access,
      rowActions: spec.rowId ? Object.fromEntries(source.schema.fields.filter(f => f.type === "subform").map(f => [f.id, { add: false, remove: false }])) : rowActions(source.version.schema, access),
      record: { ...recordDto(source.row), values: visible.values, cellRevisions: visible.cells, rowRevisions: visible.rows },
    };
  }
}
