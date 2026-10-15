import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import {
  dataModelChanges,
  displayPlainFieldValue,
  formValidationResults,
  fieldPermission as permission,
  ruleFieldVisible,
  selectionCountMessage,
  separateFormSchema,
  type AccessGrant,
  type DataModel,
  type FieldValidationIssue,
  type FormField,
  type FormSchema,
  type FormValues,
} from "@platform/contracts";
import type { Actor } from "../../core/auth/auth.service";
import type { Database } from "../../core/database/database";
import { FieldValidationException, collectFieldIssues, scalar } from "./field-values";
import { masked } from "./record-schema";

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
  if (
    scope.definitionId !== definitionId ||
    !pageAcceptsVersion(scope, schema, definitionVersion)
  ) {
    throw new ConflictException(
      "页面与记录的数据版本不匹配，请选择适用的页面版本或更新记录数据版本",
    );
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
  const issues: FieldValidationIssue[] = [];
  const validateScalar = (
    field: FormField,
    value: unknown,
    location: Omit<FieldValidationIssue, "fieldId" | "message"> = {},
  ) => {
    collectFieldIssues(issues, () => {
      scalar(field, value, !scope.deferRequired, location);
      const message = !scope.deferRequired && selectionCountMessage(field, value);
      if (message) {
        throw new FieldValidationException([
          {
            fieldId: field.id,
            ...location,
            message: `「${field.label}」${message}`,
          },
        ]);
      }
    });
  };

  for (const field of readable.schema.fields) {
    if (!ruleFieldVisible(field, readable.schema, readable.values)) continue;

    if (field.type === "subform") {
      const rows = values[field.id] as FormValues[];
      const scopedRows = rows.filter((row) => !scope.row || row._rowId === scope.row.rowId);
      if (field.required && !scope.deferRequired && !scopedRows.length) {
        issues.push({ fieldId: field.id, message: `请填写${field.label}` });
      }
      for (const [rowIndex, row] of rows.entries()) {
        if (scope.row && row._rowId !== scope.row.rowId) continue;
        const visibleRow =
          (readable.values[field.id] as FormValues[]).find((item) => item._rowId === row._rowId) ||
          {};
        for (const child of field.children) {
          if (ruleFieldVisible(child, readable.schema, { ...readable.values, ...visibleRow })) {
            validateScalar(child, row[child.id], {
              subformId: field.id,
              rowId: row._rowId as string,
              rowIndex,
            });
          }
        }
      }
    } else {
      validateScalar(field, values[field.id]);
    }
  }
  if (issues.length) throw new FieldValidationException(issues);

  // 流程节点任务沿用原有节点必填校验路径，不触发整表拦截规则
  if (scope.taskId) return;

  const readableRules = new Set(readable.schema.settings.validations?.map((rule) => rule.id));
  // 对完整合并后的记录执行表单级校验，避免权限隐藏字段绕过校验约束
  const issue = formValidationResults(scope.schema, values, {
    displaySchema: readable.schema,
    display: displayPlainFieldValue,
  }).find((item) => item.mode === "block");

  if (issue) {
    if (!readableRules.has(issue.ruleId)) {
      throw new BadRequestException("数据不符合表单校验条件，请联系表单管理员。");
    }
    const locations = (issue.fieldIds || []).map((fieldId) => {
      const parent = readable.schema.fields.find((field) =>
        field.children.some((child) => child.id === fieldId),
      );
      return {
        fieldId,
        ...(parent ? { subformId: parent.id } : {}),
        message: issue.message,
      };
    });
    // 汇总公式只能定位参与的列，不能推断某一行填写错误。
    if (locations.length) throw new FieldValidationException(locations);
    throw new BadRequestException(issue.message);
  }
}

type Queryable = Pick<Database, "query">;

/**
 * 校验目标页面存在且处于未归档状态（调用方需持有所属数据定义的锁）
 */
export async function assertPageActive(tx: Pick<Database, "query">, actor: Actor, id: string) {
  const { rows } = await tx.query(
    "SELECT archived_at, title FROM pages WHERE id = $1 AND workspace_id = $2",
    [id, actor.workspaceId],
  );
  const page = rows[0];
  if (!page) {
    throw new NotFoundException("表单不存在或不可访问");
  }
  if (page.archived_at) {
    throw new ConflictException(
      `「${page.title}」已归档，请打开其他表单或由管理员恢复；已发任务可从待办继续处理`,
    );
  }
}

/** 已配置提交自动发起的表单必须走表单入口，不能通过底层记录接口绕开流程。 */
export async function requireWorkflowEntry(
  tx: Queryable,
  definitionId: string,
  page?: RecordPageScope,
) {
  const { rows } = await tx.query(
    `SELECT t.start_page_id FROM process_templates t
     JOIN pages p ON p.id=t.start_page_id
     WHERE p.definition_id=$1 AND t.enabled AND t.active_version IS NOT NULL`,
    [definitionId],
  );
  if (rows.length && !rows.some((row) => row.start_page_id === page?.id)) {
    throw new ConflictException("此表单已启用流程，请从填写表单入口提交");
  }
}

/** 查询记录关联的流程状态，只供已经完成记录授权的调用方使用。 */
export async function recordWorkflow(tx: Queryable, id: string) {
  const { rows } = await tx.query<{ id: string; status: string }>(
    "SELECT id,status FROM processes WHERE submission_record_id=$1",
    [id],
  );
  return rows[0];
}

/** 普通成员必须从任务入口办理运行中的流程，管理员保留原有管理权限。 */
export async function requireRecordEditable(
  tx: Queryable,
  actor: Actor,
  id: string,
  page?: RecordPageScope,
) {
  if (actor.role !== "admin" && !page?.taskId) {
    const running = await tx.query(
      "SELECT 1 FROM processes WHERE submission_record_id=$1 AND status='running'",
      [id],
    );
    if (running.rowCount) {
      throw new ForbiddenException("流程处理中，请从待办中办理此记录");
    }
  }
}

/** 关系和任务仍引用记录时拒绝归档，引用检查与记录更新必须共用锁和事务。 */
export async function requireRecordUnreferenced(tx: Queryable, id: string) {
  const depSql = `
    SELECT
      EXISTS(SELECT 1 FROM record_links WHERE source_record_id = $1 OR target_record_id = $1)
      OR EXISTS(SELECT 1 FROM tasks WHERE record_id = $1)
      OR EXISTS(
        SELECT 1 FROM processes p
        CROSS JOIN LATERAL jsonb_each_text(p.bindings) b
        WHERE b.value = $1::text
      ) AS referenced
  `;
  const dependency = (await tx.query(depSql, [id])).rows[0];
  if (dependency.referenced) {
    throw new ConflictException("记录已被关系或任务引用，不能归档");
  }
}
