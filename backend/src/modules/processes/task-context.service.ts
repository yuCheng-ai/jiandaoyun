import { BadRequestException, ForbiddenException, Injectable } from "@nestjs/common";
import type {
  FieldValidationIssue,
  FormField,
  FormSchema,
  FormValues,
  RecordDetail,
  TaskSpec,
} from "@platform/contracts";
import {
  emptyFieldValue,
  fieldPermission as permission,
  ruleFieldVisible,
} from "@platform/contracts";
import type { Actor } from "../../core/auth/auth.service";
import type { Transaction } from "../../core/database/database";
import { PageService } from "../pages/pages.service";
import { recordCreator } from "../records/organization-fields";
import { allFields, masked, rowActions } from "../records/record-schema";
import { pageAccess, validatePageSubmission, type RecordPageScope } from "../records/record-scope";
import { requireActiveRecord } from "../records/record-state";
import { RecordValuesService } from "../records/record-values.service";
import { RecordService, definitionDto, recordDto } from "../records/records.service";
import { FieldValidationException, collectFieldIssues, scalar } from "../records/field-values";


@Injectable()
export class TaskContextService {
  constructor(
    private readonly recordService: RecordService,
    private readonly values: RecordValuesService,
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
    if (!task.pageId) {
      return undefined;
    }

    const scope = await this.pages.recordScope(
      actor,
      task.pageId,
      task.pageVersion!,
      tx,
      allowArchived,
    );
    scope.taskId = task.id;
    scope.schema = structuredClone(scope.schema);

    const requiredFieldIds = new Set(task.requiredFields || []);
    const allSchemaFields = allFields(scope.schema);
    for (const fieldId of requiredFieldIds) {
      if (!allSchemaFields.some((field) => field.id === fieldId)) {
        throw new BadRequestException("任务要求的字段不在处理页面中");
      }
    }

    // 节点权限只收紧表单权限，不能借流程提高成员原有的数据权限。
    for (const field of allSchemaFields) {
      if (requiredFieldIds.has(field.id)) {
        field.required = true;
      }

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
        (field) =>
          field.id === task.subformId && field.type === "subform" && field.visible,
      );
      if (!task.rowId || !hasVisibleSubform) {
        throw new BadRequestException("处理页面不包含任务明细");
      }

      scope.row = { subformId: task.subformId, rowId: task.rowId };
      scope.schema.fields = scope.schema.fields
        .filter((field) => field.type !== "subform" || field.id === task.subformId)
        .map((field) =>
          field.id === task.subformId
            ? field
            : { ...field, editable: false, required: false },
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
    const source = await this.recordService.loadRecord(tx, actor, recordId);
    if (!source.access.read) {
      throw new ForbiddenException("当前成员没有任务记录的查看权限");
    }
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
      const field = schema.fields.find((field) => field.id === task.subformId);
      if (!field || permission(access, field) === "hidden") {
        throw new ForbiddenException("当前成员没有任务明细的访问权限");
      }
      const rows = source.row.values[task.subformId] as FormValues[] | undefined;
      if (!rows?.some((row) => row._rowId === task.rowId)) {
        throw new BadRequestException("任务绑定的明细行已不存在");
      }
    }

    const assertRequiredFieldVisible = (field: FormField, parent?: FormField) => {
      if (field.required && permission(access, field, parent) === "hidden") {
        throw new ForbiddenException("当前成员无法查看任务要求填写的字段");
      }
    };

    for (const field of schema.fields) {
      assertRequiredFieldVisible(field);
      for (const child of field.children) {
        assertRequiredFieldVisible(child, field);
      }
    }

    return { ...source, scope, access, schema };
  }

  /** 委托不能把待办交给无法补齐当前必填项的人；已填妥的只读审批仍允许接收。 */
  async assertDelegateRecipient(
    tx: Transaction,
    recipient: Actor,
    recordId: string,
    spec: TaskSpec,
  ) {
    const source = await this.load(tx, recipient, recordId, spec);
    if (!source.access.edit) {
      throw new ForbiddenException(
        "该成员没有任务记录的编辑权限，请先由管理员配置权限",
      );
    }
    // 未绑定页面的直接任务，完成时只检查明确指定的主表必填项。
    if (!source.scope) {
      for (const fieldId of spec.requiredFields || []) {
        const field = source.schema.fields.find(
          (item) => item.id === fieldId && item.type !== "subform",
        );
        if (!field || permission(source.access, field) === "hidden") {
          throw new ForbiddenException("该成员无法查看任务要求填写的字段");
        }
        if (
          emptyFieldValue(source.row.values[fieldId]) &&
          permission(source.access, field) !== "edit"
        ) {
          throw new ForbiddenException(
            `该成员无法填写必填字段「${field.label}」，请先配置权限`,
          );
        }
      }
      return;
    }
    const visible = masked(source.schema, source.row.values, {}, source.access);
    const actions = rowActions(
      source.version.schema,
      source.access,
      source.scope?.schema,
    );
    const check = (
      field: FormField,
      value: unknown,
      values: FormValues,
      parent?: FormField,
    ) => {
      if (!field.required || !emptyFieldValue(value)) return;
      if (!ruleFieldVisible(field, visible.schema, values)) return;
      let editable = permission(source.access, field, parent) === "edit";
      if (parent && actions[parent.id]?.editExisting === false) editable = false;
      if (
        field.type === "subform" &&
        !actions[field.id]?.add &&
        !actions[field.id]?.insert
      ) {
        editable = false;
      }
      if (!editable) {
        throw new ForbiddenException(
          `该成员无法填写必填字段「${field.label}」，请先配置权限`,
        );
      }
    };
    for (const field of visible.schema.fields) {
      if (!ruleFieldVisible(field, visible.schema, visible.values)) continue;
      const value = visible.values[field.id];
      check(field, value, visible.values);
      if (field.type !== "subform" || !Array.isArray(value)) continue;
      for (const row of value as FormValues[]) {
        if (spec.rowId && row._rowId !== spec.rowId) continue;
        const values = { ...visible.values, ...row };
        for (const child of field.children) {
          check(child, row[child.id], values, field);
        }
      }
    }
  }

  /** 在完成任务前校验页面提交约束及任务必填字段是否均已合规填写 */
  async validateCompletion(
    tx: Transaction,
    actor: Actor,
    recordId: string,
    task: TaskSpec,
  ) {
    const source = await this.load(tx, actor, recordId, task);
    validatePageSubmission(source.scope, source.row.values, source.access);

    if (source.scope) {
      return;
    }

    // 未绑定处理页面的任务，仍需按记录原始字段校验节点必填要求。
    const issues: FieldValidationIssue[] = [];
    for (const fieldId of task.requiredFields || []) {
      const field = source.schema.fields.find(
        (field) => field.id === fieldId && field.type !== "subform",
      );
      if (!field || permission(source.access, field) === "hidden") {
        throw new ForbiddenException("无法检查任务要求的字段");
      }
      collectFieldIssues(issues, () => {
        return scalar(
          { ...field, required: true },
          source.row.values[fieldId],
          true,
          {},
        );
      });
    }
    if (issues.length) throw new FieldValidationException(issues);
  }

  /** 生成任务节点专属的记录详情视图（对非 ready 任务自动降级为只读，并按权限脱敏字段与子表行） */
  async record(
    tx: Transaction,
    actor: Actor,
    processId: string,
    task: {
      id: string;
      record_id: string;
      status: string;
      spec: TaskSpec;
    },
    readOnly = false,
  ): Promise<RecordDetail> {
    const spec = task.spec;
    const source = await this.load(tx, actor, task.record_id, spec);

    const writable = !readOnly && task.status === "ready" && spec.kind !== "copy";
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
    const allowedRowActions = rowActions(
      source.version.schema,
      access,
      source.scope?.schema,
    );
    // 明细任务只处理绑定行，不能通过行操作新增或移除其他业务明细。
    if (spec.rowId) {
      for (const actions of Object.values(allowedRowActions)) {
        actions.add = false;
        actions.insert = false;
        actions.remove = false;
      }
    }

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
              title: source.scope.title,
            },
          }
        : {}),
      creator: await recordCreator(tx, actor, source.row.created_by),
      identities: await this.values.identityLabels(
        tx,
        actor,
        visible.schema,
        visible.values,
      ),
      definition: { ...definitionDto(source.version), schema: visible.schema },
      access,
      rowActions: allowedRowActions,
      record: {
        ...recordDto(source.row),
        values: visible.values,
        cellRevisions: visible.cells,
        rowRevisions: visible.rows,
      },
    };
  }
}
