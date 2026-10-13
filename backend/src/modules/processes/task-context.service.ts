import { requireActiveRecord } from "../records/record-state";
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import type {
  FormField,
  FormSchema,
  FormValues,
  RecordDetail,
  TaskSpec,
} from "@platform/contracts";
import { recordCreator } from "../directory/organization-fields";
import type { Actor } from "../../core/auth/auth.service";
import type { Transaction } from "../../core/database/database";
import { PageService } from "../pages/pages.service";
import {
  PlatformService,
  definitionDto,
  recordDto,
} from "../pages/platform.service";
import {
  pageAccess,
  validatePageSubmission,
  type RecordPageScope,
} from "../pages/page-runtime";
import {
  allFields,
  masked,
  permission,
  rowActions,
  scalar,
} from "../../core/database/schema";

@Injectable()
export class TaskContextService {
  constructor(
    private readonly platform: PlatformService,
    private readonly pages: PageService,
  ) {}

  /**
   * 构建任务节点的页面作用域（RecordPageScope）：
   * - 将任务级必填字段叠加到页面 Schema；
   * - 若为子表明细行任务，则锁定目标子表行并将主表字段置为只读、非必填。
   */
  async scope(
    actor: Actor,
    task: TaskSpec,
    tx?: Transaction,
    allowArchived = true,
  ): Promise<RecordPageScope | undefined> {
    if (!task.pageId) return undefined;

    const scope = await this.pages.recordScope(
      actor,
      task.pageId,
      task.pageVersion!,
      tx,
      allowArchived,
    );
    scope.taskId = task.id;
    scope.schema = structuredClone(scope.schema);

    const required = new Set(task.requiredFields || []);
    const allSchemaFields = allFields(scope.schema);
    if ([...required].some((id) => !allSchemaFields.some((f) => f.id === id))) {
      throw new BadRequestException("任务要求的字段不在处理页面中");
    }

    for (const field of scope.schema.fields) {
      if (required.has(field.id)) field.required = true;
      for (const child of field.children) {
        if (required.has(child.id)) child.required = true;
      }
    }

    // 节点权限只收紧表单权限，不能借流程提高成员原有的数据权限。
    for (const field of allSchemaFields) {
      const nodePermission = task.fieldPermissions?.[field.id];
      const parent = scope.schema.fields.find((item) =>
        item.children.some((child) => child.id === field.id),
      );
      const hiddenByParent =
        parent && task.fieldPermissions?.[parent.id] === "hidden";
      if (nodePermission === "hidden" || hiddenByParent) {
        field.visible = false;
        field.editable = false;
        field.required = false;
      } else if (nodePermission === "read" || task.kind === "copy") {
        field.editable = false;
      }
    }

    if (task.subformId) {
      const hasVisibleSubform = scope.schema.fields.some(
        (f) => f.id === task.subformId && f.type === "subform" && f.visible,
      );
      if (!task.rowId || !hasVisibleSubform) {
        throw new BadRequestException("处理页面不包含任务明细");
      }

      scope.row = { subformId: task.subformId, rowId: task.rowId };
      scope.schema.fields = scope.schema.fields
        .filter((f) => f.type !== "subform" || f.id === task.subformId)
        .map((f) =>
          f.id === task.subformId
            ? f
            : { ...f, editable: false, required: false },
        );
    }

    return scope;
  }

  /** 加载任务绑定的记录、页面作用域与字段权限，并校验处理人具备所有必填字段的可见权限 */
  async load(
    tx: Transaction,
    actor: Actor,
    recordId: string,
    task: TaskSpec,
    allowArchived = true,
  ) {
    const source = await this.platform.loadRecord(tx, actor, recordId);
    if (!source.access.read)
      throw new ForbiddenException("当前成员没有任务记录的查看权限");
    const scope = await this.scope(actor, task, tx, allowArchived);
    requireActiveRecord(source.row);

    const access = pageAccess(
      scope,
      source.row.definition_id,
      source.row.definition_version,
      source.access,
      source.version.schema,
    );
    const schema = scope?.schema || (source.version.schema as FormSchema);

    if (task.subformId) {
      const field = schema.fields.find((f) => f.id === task.subformId);
      if (!field || permission(access, field) === "hidden") {
        throw new ForbiddenException("当前成员没有任务明细的访问权限");
      }
      const rows = source.row.values[task.subformId] as
        FormValues[] | undefined;
      if (!rows?.some((row) => row._rowId === task.rowId)) {
        throw new BadRequestException("任务绑定的明细行已不存在");
      }
    }

    const assertRequired = (field: FormField, parent?: FormField) => {
      if (field.required && permission(access, field, parent) === "hidden") {
        throw new ForbiddenException("当前成员无法查看任务要求填写的字段");
      }
    };

    for (const field of schema.fields) {
      assertRequired(field);
      field.children.forEach((child) => assertRequired(child, field));
    }

    return { ...source, scope, access, schema };
  }

  /** 在完成任务前校验页面提交约束及任务必填字段是否均已合规填写 */
  async validateCompletion(
    tx: Transaction,
    actor: Actor,
    recordId: string,
    task: TaskSpec,
    allowArchived = true,
  ) {
    const source = await this.load(tx, actor, recordId, task);
    validatePageSubmission(source.scope, source.row.values, source.access);

    if (!source.scope) {
      for (const id of task.requiredFields || []) {
        const field = source.schema.fields.find(
          (f) => f.id === id && f.type !== "subform",
        );
        if (!field || permission(source.access, field) === "hidden") {
          throw new ForbiddenException("无法检查任务要求的字段");
        }
        scalar({ ...field, required: true }, source.row.values[id]);
      }
    }
  }

  /** 生成任务节点专属的记录详情视图（对非 ready 任务自动降级为只读，并按权限脱敏字段与子表行） */
  async record(
    tx: Transaction,
    actor: Actor,
    processId: string,
    task: any,
  ): Promise<RecordDetail> {
    const spec = task.spec as TaskSpec;
    const source = await this.load(tx, actor, task.record_id, spec);

    const writable = task.status === "ready" && spec.kind !== "copy";
    const access = { ...source.access, edit: source.access.edit && writable };
    if (!writable) {
      access.fields = Object.fromEntries(
        Object.entries(access.fields).map(([key, value]) => [
          key,
          value === "edit" ? "read" : value,
        ]),
      );
    }

    const values = structuredClone(source.row.values);
    if (source.scope?.row) {
      const { subformId, rowId } = source.scope.row;
      values[subformId] = values[subformId].filter(
        (row: FormValues) => row._rowId === rowId,
      );
    }

    const visible = masked(
      source.schema,
      values,
      source.row.cell_revisions,
      access,
    );
    const rawRowActions = rowActions(
      source.version.schema,
      access,
      source.scope?.schema,
    );

    return {
      task: {
        processId,
        taskId: task.id,
        title: spec.title,
        writable: access.edit,
        ...(spec.rowId ? { rowId: spec.rowId, subformId: spec.subformId } : {}),
      },
      ...(source.scope
        ? {
            page: {
              id: source.scope.id,
              version: source.scope.version,
              title: (source.scope as any).title,
            },
          }
        : {}),
      creator: await recordCreator(tx, actor, source.row.created_by),
      identities: await this.platform.identityLabels(
        tx,
        actor,
        visible.schema,
        visible.values,
      ),
      definition: { ...definitionDto(source.version), schema: visible.schema },
      access,
      rowActions: Object.fromEntries(
        Object.entries(rawRowActions).map(([id, actions]) => [
          id,
          spec.rowId
            ? { ...actions, add: false, insert: false, remove: false }
            : actions,
        ]),
      ),
      record: {
        ...recordDto(source.row),
        values: visible.values,
        cellRevisions: visible.cells,
        rowRevisions: visible.rows,
      },
    };
  }
}
