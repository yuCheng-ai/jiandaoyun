import {
  subformRowId,
  previousSubformRow,
  identifySubformRows,
  subformRowIdentityErrors,
  subformPermissions,
  subformOperationErrors,
  parseSubformPermissions,
  type SubformPermissions,
} from "@platform/contracts";
import {
  copy,
  flattenFields,
  uid,
  resolveCalculations,
  prepareSubmission,
  validateValues,
  isFieldVisible,
  type FormField,
  type FormSchema,
  type FormValues,
} from "./form";
import { parseFilters, type DataFilter } from "./fieldConfig";
import { resolveIdentities } from "./organization";
import {
  matchesFilters,
  recordFilterFields,
  applyFieldChange,
  runtimeDefaults,
  resolveRuntimeValues,
  scopeFields,
} from "./relations";
import { validateDynamicValues } from "./fieldValidation";
import { blockingFormValidation, validationReferences } from "./formValidation";
import { entryDefinition } from "./collaboration";
import { sameWorkspaceValue } from "./workspaceSync";
import type { WorkspaceData, FormRecord, FormEntry } from "./workspace";

export const memberActions = {
  view: "查看",
  create: "添加",
  edit: "编辑",
  delete: "删除",
  import: "导入",
  export: "导出",
  print: "打印",
} as const;
export type MemberAction = keyof typeof memberActions;
export type FieldAccess = "hidden" | "read" | "edit";
export interface AccessGroup {
  id: string;
  name: string;
  enabled: boolean;
  archived: boolean;
  identities: string[];
  actions: MemberAction[];
  scope: "all" | "self" | "department" | "custom";
  filters: DataFilter[];
  fields: Record<string, FieldAccess>;
  subformPermissions?: Record<string, SubformPermissions>;
}
export interface FormAccess {
  membersEnabled: boolean;
  publicEnabled: boolean;
  allowMerged: boolean;
  filling: {
    enabled: boolean;
    startsAt: string;
    endsAt: string;
    limit: number;
    allowRepeat: boolean;
  };
  groups: AccessGroup[];
}
export const defaultAccess = (): FormAccess => ({
  membersEnabled: false,
  publicEnabled: true,
  allowMerged: true,
  filling: {
    enabled: true,
    startsAt: "",
    endsAt: "",
    limit: 0,
    allowRepeat: true,
  },
  groups: [],
});
export function parseAccess(raw: any): FormAccess {
  const defaults = defaultAccess(),
    seen = new Set<string>();
  return {
    membersEnabled: raw?.membersEnabled === true,
    publicEnabled: raw?.publicEnabled !== false,
    allowMerged: raw?.allowMerged !== false,
    filling: {
      enabled: raw?.filling?.enabled !== false,
      startsAt: String(raw?.filling?.startsAt || ""),
      endsAt: String(raw?.filling?.endsAt || ""),
      limit: Math.max(0, Math.floor(Number(raw?.filling?.limit) || 0)),
      allowRepeat: raw?.filling?.allowRepeat !== false,
    },
    groups: (Array.isArray(raw?.groups) ? raw.groups : defaults.groups)
      .slice(0, 100)
      .map((g: any) => {
        if (!g || typeof g.id !== "string" || !g.id || seen.has(g.id))
          throw Error("权限组 ID 无效或重复");
        seen.add(g.id);
        return {
          id: g.id,
          name: String(g.name || ""),
          enabled: g.enabled === true,
          archived: g.archived === true,
          identities: Array.isArray(g.identities)
            ? [
                ...new Set(
                  g.identities.filter((id: any) => typeof id === "string"),
                ),
              ]
            : [],
          actions: Array.isArray(g.actions)
            ? [
                ...new Set(
                  g.actions.filter((a: any) => Object.hasOwn(memberActions, a)),
                ),
              ]
            : [],
          scope: ["self", "department", "custom"].includes(g.scope)
            ? g.scope
            : "all",
          filters: parseFilters(g.filters),
          ...(g.subformPermissions === undefined
            ? {}
            : {
                subformPermissions: parseGroupSubformPermissions(
                  g.subformPermissions,
                ),
              }),
          fields: Object.fromEntries(
            Object.entries(g.fields || {}).filter(([, p]) =>
              ["hidden", "read", "edit"].includes(String(p)),
            ),
          ),
        } as AccessGroup;
      }),
  };
}
function parseGroupSubformPermissions(
  raw: unknown,
): Record<string, SubformPermissions> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw Error("子表单操作权限格式无效");
  return Object.fromEntries(
    Object.entries(raw).map(([id, value]) => [
      id,
      parseSubformPermissions(value),
    ]),
  );
}
export function newAccessGroup(
  schema: FormSchema,
  preset = "read",
): AccessGroup {
  const rowFields = flattenFields(schema.fields).filter(
    (f) => f.type === "subform",
  );
  return {
    id: uid("access"),
    name:
      (
        {
          read: "查看全部数据",
          self: "添加并管理本人数据",
          manage: "管理全部数据",
          create: "仅添加数据",
        } as Record<string, string>
      )[preset] || "自定义权限组",
    enabled: true,
    archived: false,
    identities: [],
    actions:
      preset === "create"
        ? ["create"]
        : preset === "manage"
          ? ["view", "create", "edit", "delete", "import", "export", "print"]
          : preset === "self"
            ? ["view", "create", "edit", "delete"]
            : ["view"],
    scope: preset === "self" ? "self" : "all",
    filters: [],
    ...(rowFields.length
      ? {
          subformPermissions: Object.fromEntries(
            rowFields.map((f) => [f.id, subformPermissions()]),
          ),
        }
      : {}),
    fields: Object.fromEntries(
      flattenFields(schema.fields).map((f) => [
        f.id,
        ["manage", "self"].includes(preset) ? "edit" : "read",
      ]),
    ),
  };
}
export function accessConfig(data: WorkspaceData, formId: string): FormAccess {
  return data.formAccess?.[formId] || defaultAccess();
}
export function actorData(data: WorkspaceData, actor: string): WorkspaceData {
  return {
    ...data,
    organization: { ...data.organization, currentUserId: actor },
  };
}
export function accessIssues(
  config: FormAccess,
  form: FormRecord,
  data: WorkspaceData,
  schema = form.published?.schema || form.schema,
): string[] {
  const errors: string[] = [],
    fields = new Set(
      scopeFields(schema.fields)
        .filter((f) => !f.children.length)
        .map((f) => f.id),
    );
  const ids = new Set<string>();
  for (const g of config.groups.filter((g) => !g.archived)) {
    if (ids.has(g.id)) errors.push("权限组 ID 重复");
    ids.add(g.id);
    if (!g.name.trim()) errors.push("请填写权限组名称");
    if (!g.identities.length) errors.push(`${g.name}：请选择成员、部门或角色`);
    if (!g.actions.length) errors.push(`${g.name}：请选择操作权限`);
    if (g.actions.some((a) => !Object.hasOwn(memberActions, a)))
      errors.push(`${g.name}：操作权限无效`);
    if (
      g.actions.some((a) => !["view", "create"].includes(a)) &&
      !g.actions.includes("view")
    )
      errors.push(`${g.name}：管理已有数据需要查看权限`);
    if (
      g.scope === "custom" &&
      (!g.filters.length ||
        g.filters.some(
          (f) =>
            !fields.has(f.sourceFieldId) ||
            f.source === "field" ||
            (f.operator !== "notEmpty" &&
              f.source === "constant" &&
              !f.value.trim()),
        ))
    )
      errors.push(`${g.name}：请完整设置有效的数据筛选条件`);
    try {
      if (g.subformPermissions !== undefined)
        parseGroupSubformPermissions(g.subformPermissions);
    } catch {
      errors.push(`${g.name}：子表单操作权限格式无效`);
    }
    if (g.enabled && !resolveIdentities(data.organization, g.identities).length)
      errors.push(`${g.name}：当前没有有效的在职成员`);
  }
  const { startsAt, endsAt, limit } = config.filling;
  if ([startsAt, endsAt].some((t) => !!t && !Number.isFinite(Date.parse(t))))
    errors.push("填写时间格式无效");
  if (startsAt && endsAt && Date.parse(startsAt) >= Date.parse(endsAt))
    errors.push("结束时间必须晚于开始时间");
  if (!Number.isFinite(limit) || limit < 0 || !Number.isInteger(limit))
    errors.push("收集上限应为非负整数");
  return errors;
}
export function accessFieldImpacts(
  config: FormAccess,
  ids: string[],
): string[] {
  return config.groups
    .filter(
      (g) =>
        !g.archived &&
        g.scope === "custom" &&
        g.filters.some((f) => ids.includes(f.sourceFieldId)),
    )
    .map((g) => `成员发布权限组「${g.name}」的数据筛选条件`);
}
export function eligibleGroups(
  data: WorkspaceData,
  formId: string,
  actor: string,
  selection = "*",
): AccessGroup[] {
  const c = accessConfig(data, formId),
    form = data.forms.find((f) => f.id === formId);
  if (!c.membersEnabled || !form?.published || form.archived) return [];
  const all = c.groups.filter(
    (g) =>
      g.enabled &&
      !g.archived &&
      resolveIdentities(data.organization, g.identities).some(
        (e) => e.id === actor,
      ),
  );
  if (selection === "") return all;
  if (selection === "*") return c.allowMerged || all.length < 2 ? all : [];
  return all.filter((g) => g.id === selection);
}
export function groupsForEntry(
  data: WorkspaceData,
  entry: FormEntry,
  actor: string,
  selection = "*",
): AccessGroup[] {
  if (entry.deletedAt || entry.status === "draft") return [];
  const member = data.organization.employees.find(
    (e) => e.id === actor && e.status === "active",
  );
  if (!member) return [];
  return eligibleGroups(data, entry.formId, actor, selection).filter(
    (g) =>
      g.actions.includes("view") &&
      (g.scope === "all" ||
        (g.scope === "self" && entry.createdBy === actor) ||
        (g.scope === "department" &&
          (entry.createdDepartmentIds || []).some((id) =>
            member.departmentIds.includes(id),
          )) ||
        (g.scope === "custom" &&
          g.filters.length > 0 &&
          g.filters.every((f) => f.source !== "field") &&
          matchesFilters(
            g.filters,
            entry.values,
            {},
            actorData(data, actor),
            "all",
            flattenFields(
              data.forms.find((form) => form.id === entry.formId)?.schema
                .fields || [],
            ),
            recordFilterFields(data, entry),
          ))),
  );
}
export function canEntry(
  data: WorkspaceData,
  entry: FormEntry,
  actor: string,
  action: MemberAction,
  selection = "*",
): boolean {
  return groupsForEntry(data, entry, actor, selection).some((g) =>
    g.actions.includes(action),
  );
}
function fieldLevel(group: AccessGroup, path: FormField[]): FieldAccess {
  if (
    path.some(
      (f) =>
        group.fields[f.id] === undefined ||
        group.fields[f.id] === "hidden" ||
        !f.visible,
    )
  )
    return "hidden";
  return path.every((f) => group.fields[f.id] === "edit" && f.editable)
    ? "edit"
    : "read";
}
export function memberSchema(
  schema: FormSchema,
  groups: AccessGroup[],
  editing = false,
): FormSchema {
  const result = copy(schema);
  function visit(fields: FormField[], parents: FormField[] = []) {
    for (const f of fields) {
      const path = [...parents, copy(f)],
        levels = groups.map((g) => ({ g, level: fieldLevel(g, path) }));
      f.visible = f.visible && levels.some((l) => l.level !== "hidden");
      f.editable =
        editing &&
        f.type !== "serial" &&
        f.visible &&
        levels.some((l) => l.g.actions.includes("edit") && l.level === "edit");
      if (f.type === "subform") {
        const eligible = levels.filter(
          (l) => editing && l.g.actions.includes("edit") && l.level === "edit",
        );
        f.subformPermissions = {
          add: eligible.some(
            (l) => subformPermissions(l.g.subformPermissions?.[f.id]).add,
          ),
          insert: eligible.some(
            (l) => subformPermissions(l.g.subformPermissions?.[f.id]).insert,
          ),
          editExisting: eligible.some(
            (l) =>
              subformPermissions(l.g.subformPermissions?.[f.id]).editExisting,
          ),
          deleteExisting: eligible.some(
            (l) =>
              subformPermissions(l.g.subformPermissions?.[f.id]).deleteExisting,
          ),
        };
      }
      const parent = parents.find((p) => p.type === "subform");
      if (parent) {
        const grants = levels
          .filter(
            (l) =>
              editing && l.g.actions.includes("edit") && l.level === "edit",
          )
          .map((l) => subformPermissions(l.g.subformPermissions?.[parent.id]));
        f.rowEditAccess = {
          existing: grants.some((grant) => grant.editExisting),
          append: grants.some((grant) => grant.add || grant.insert),
          insert: grants.some((grant) => grant.insert),
        };
      }
      if (!f.editable) f.required = false;
      if (f.children.length) visit(f.children, path);
    }
  }
  visit(result.fields);
  const visible = new Set(
    flattenFields(result.fields)
      .filter((field) => field.visible)
      .map((field) => field.id),
  );
  // The local persistence path rechecks whole-record rules after protected values are merged.
  result.settings.validations = (result.settings.validations || []).filter(
    (rule) => validationReferences(rule).every((id) => visible.has(id)),
  );
  result.settings.allowDraft = false;
  result.settings.cacheDraft = editing && schema.settings.cacheDraft;
  result.settings.submitLabel = "保存修改";
  // Record editing uses its operation grant, independently of the new-entry button.
  result.settings.allowSubmit = true;
  // Permission masking must not clear stored values when a hidden field is omitted.
  result.settings.hiddenValues = "retain";
  return result;
}
/** Keep the operation and field grants in the same record-scoped group. */
export function entryAccessSchema(
  data: WorkspaceData,
  entry: FormEntry,
  actor: string,
  selection = "*",
  action: MemberAction = "view",
): FormSchema | undefined {
  const definition = entryDefinition(entry, data);
  return definition
    ? memberSchema(
        definition.schema,
        groupsForEntry(data, entry, actor, selection).filter((g) =>
          g.actions.includes(action),
        ),
        action === "edit",
      )
    : undefined;
}
export function visibleValues(
  schema: FormSchema,
  values: FormValues,
): FormValues {
  const out: FormValues = {};
  function visit(
    fields: FormField[],
    source: FormValues,
    target: FormValues,
    root: FormValues = {},
  ) {
    for (const f of fields) {
      if (!isFieldVisible(f, schema, { ...root, ...source })) continue;
      if (f.type === "tabs") visit(f.children, source, target, root);
      else if (f.type === "subform")
        target[f.id] = (
          Array.isArray(source[f.id]) ? (source[f.id] as FormValues[]) : []
        ).map((row) => {
          const next: FormValues =
            row._rowId !== undefined ? { _rowId: row._rowId } : {};
          visit(f.children, row, next, { ...root, ...source });
          return next;
        });
      else if (source[f.id] !== undefined) target[f.id] = copy(source[f.id]);
    }
  }
  visit(schema.fields, values, out);
  return out;
}
export function memberContext(
  data: WorkspaceData,
  actor: string,
): WorkspaceData {
  return {
    ...actorData(data, actor),
    entries: data.entries.flatMap((e) => {
      const definition = entryDefinition(e, data),
        groups = groupsForEntry(data, e, actor, "");
      const schema =
        definition && groups.length
          ? memberSchema(definition.schema, groups)
          : undefined;
      return definition && groups.length
        ? [
            {
              ...e,
              readableFieldIds: flattenFields(schema!.fields)
                .filter((field) => field.visible)
                .map((field) => field.id),
              values: visibleValues(schema!, e.values),
            },
          ]
        : [];
    }),
  };
}
export function fillingIssue(
  data: WorkspaceData,
  formId: string,
  actor: string,
  now = Date.now(),
): string {
  const form = data.forms.find((f) => f.id === formId),
    c = accessConfig(data, formId).filling;
  if (!form?.published || form.archived) return "表单尚未发布或已归档";
  if (!c.enabled) return "表单已暂停收集";
  if (c.startsAt && now < Date.parse(c.startsAt)) return "尚未到开始填写时间";
  if (c.endsAt && now >= Date.parse(c.endsAt)) return "填写时间已结束";
  const entries = data.entries.filter(
    (e) => e.formId === formId && !e.deletedAt && e.status !== "draft",
  );
  if (c.limit > 0 && entries.length >= c.limit) return "已达到收集数量上限";
  if (!c.allowRepeat && entries.some((e) => e.createdBy === actor))
    return "该成员已提交，不能重复填写";
  return "";
}
export function creationSchema(form: FormRecord): FormSchema {
  const schema = copy(form.published!.schema);
  if (form.kind === "workflow") {
    const permissions =
      form.published!.workflow.nodes.find((n) => n.data.kind === "start")?.data
        .permissions || {};
    for (const f of flattenFields(schema.fields)) {
      if (permissions[f.id] === "hidden") f.visible = false;
      if (permissions[f.id] === "read") f.editable = false;
    }
  }
  schema.settings.allowDraft = false;
  return schema;
}
export function prepareMemberUpdate(
  data: WorkspaceData,
  entry: FormEntry,
  actor: string,
  selection: string,
  input: FormValues,
  expectedSchema?: FormSchema,
) {
  const definition = entryDefinition(entry, data),
    groups = groupsForEntry(data, entry, actor, selection);
  if (!definition || !groups.some((g) => g.actions.includes("edit")))
    return { errors: ["没有编辑这条记录的权限"], values: copy(entry.values) };
  const schema = memberSchema(definition.schema, groups, true),
    errors: string[] = [],
    context = memberContext(data, actor);
  if (expectedSchema && !sameWorkspaceValue(expectedSchema, schema))
    return {
      errors: ["这条记录的编辑权限已变化，当前输入已保留，请重新打开后核对。"],
      values: copy(entry.values),
    };
  const identityErrors = subformRowIdentityErrors(schema.fields, input);
  if (identityErrors.length)
    return {
      errors: identityErrors.map((e) => e.message),
      values: copy(entry.values),
    };
  function merge(
    fields: FormField[],
    before: FormValues,
    incoming: FormValues,
    root: FormValues = {},
    rowMode?: "existing" | "append" | "insert",
  ): FormValues {
    let next = copy(before);
    // Visibility can change within the same edit. Only permitted inputs may
    // influence it; readonly/hidden request values never enter this context.
    const visibility = { ...root, ...before };
    for (const field of scopeFields(fields))
      if (
        field.visible &&
        field.editable &&
        (!rowMode || field.rowEditAccess?.[rowMode] !== false) &&
        Object.hasOwn(incoming, field.id)
      )
        visibility[field.id] = incoming[field.id];
    for (const f of fields) {
      const shown =
        isFieldVisible(f, schema, { ...root, ...before }) ||
        isFieldVisible(f, schema, visibility);
      if (f.type === "tabs") {
        if (f.editable && shown)
          next = merge(f.children, next, incoming, root, rowMode);
        continue;
      }
      if (
        !f.editable ||
        (rowMode && f.rowEditAccess?.[rowMode] === false) ||
        !shown ||
        !Object.hasOwn(incoming, f.id)
      )
        continue;
      if (f.type === "subform") {
        const oldRows = Array.isArray(before[f.id])
            ? (before[f.id] as FormValues[])
            : [],
          rows = Array.isArray(incoming[f.id])
            ? (incoming[f.id] as FormValues[])
            : [];
        if (
          rows.length > 0 &&
          oldRows.length !== rows.length &&
          rows.some((row) => row._rowId === undefined) &&
          flattenFields(f.children).some((c) => !c.editable)
        ) {
          errors.push(`${f.label}的明细行信息已变化，请重新打开记录后再修改`);
          continue;
        }
        const operationErrors = subformOperationErrors(
          [f],
          before,
          incoming,
          before,
        );
        if (operationErrors.length) {
          errors.push(...operationErrors.map((issue) => issue.message));
          continue;
        }
        next[f.id] = rows.map((row, i) => {
          const old = previousSubformRow(f.id, oldRows, row, i);
          const merged = merge(
            f.children,
            old || runtimeDefaults(f.children, context),
            row,
            { ...root, ...next },
            old
              ? "existing"
              : rows
                    .slice(i + 1)
                    .some((later, offset) =>
                      previousSubformRow(f.id, oldRows, later, i + offset + 1),
                    )
                ? "insert"
                : "append",
          );
          if (row._rowId !== undefined) merged._rowId = row._rowId;
          return merged;
        });
      } else next[f.id] = copy(incoming[f.id]);
    }
    return next;
  }
  let values = merge(schema.fields, entry.values, input);
  function applyChanges(
    fields: FormField[],
    before: FormValues,
    next: FormValues,
    root: FormValues = {},
  ): FormValues {
    const list = scopeFields(fields),
      permitted = new Map(flattenFields(schema.fields).map((f) => [f.id, f]));
    const submittedRows = copy(next);
    for (const f of list.filter((f) => !["tabs", "subform"].includes(f.type)))
      if (
        permitted.get(f.id)?.editable &&
        JSON.stringify(next[f.id]) !== JSON.stringify(before[f.id])
      )
        next = applyFieldChange(fields, next, f.id, next[f.id], context, root);
    for (const f of list.filter((f) => f.type === "subform")) {
      // Whole-table links initialize rows; permitted explicit edits remain editable.
      if (
        f.defaultLink?.enabled &&
        permitted.get(f.id)?.editable &&
        Object.hasOwn(input, f.id)
      )
        next[f.id] = copy(submittedRows[f.id]);
      const previous = Array.isArray(before[f.id])
        ? (before[f.id] as FormValues[])
        : [];
      if (Array.isArray(next[f.id]))
        next[f.id] = (next[f.id] as FormValues[]).map((row, i) =>
          applyChanges(
            f.children,
            previousSubformRow(f.id, previous, row, i) || {},
            row,
            {
              ...root,
              ...next,
            },
          ),
        );
    }
    return next;
  }
  values = prepareSubmission(
    definition.schema,
    resolveRuntimeValues(
      definition.schema,
      applyChanges(definition.schema.fields, entry.values, values),
      context,
      entry.values,
    ),
    entry.values,
    true,
  );
  function checkProtected(
    fields: FormField[],
    before: FormValues,
    next: FormValues,
    existingRow = false,
  ) {
    for (const f of scopeFields(fields)) {
      if (f.type === "subform") {
        const oldRows = Array.isArray(before[f.id])
            ? (before[f.id] as FormValues[])
            : [],
          rows = Array.isArray(next[f.id]) ? (next[f.id] as FormValues[]) : [];
        if (
          !f.editable &&
          JSON.stringify(identifySubformRows([f], before)[f.id]) !==
            JSON.stringify(identifySubformRows([f], next)[f.id])
        )
          errors.push("字段联动会修改无编辑权限的明细，请联系管理员调整规则");
        oldRows.forEach((row, i) => {
          const existing = rows.find(
            (value, index) =>
              subformRowId(f.id, value, index) === subformRowId(f.id, row, i),
          );
          // Deleting an editable row also deletes its protected cells; retained rows stay protected.
          if (existing) checkProtected(f.children, row, existing, true);
        });
        rows.forEach((row, i) => {
          if (previousSubformRow(f.id, oldRows, row, i)) return;
          const mode = rows
            .slice(i + 1)
            .some((later, offset) =>
              previousSubformRow(f.id, oldRows, later, i + offset + 1),
            )
            ? "insert"
            : "append";
          const defaults = runtimeDefaults(f.children, context);
          if (
            scopeFields(f.children).some(
              (child) =>
                (!child.editable || child.rowEditAccess?.[mode] === false) &&
                !["calculated", "serial", "divider", "button", "tabs"].includes(
                  child.type,
                ) &&
                JSON.stringify(row[child.id]) !==
                  JSON.stringify(defaults[child.id]),
            )
          )
            errors.push("字段联动会修改无编辑权限的字段，请联系管理员调整规则");
        });
      } else if (
        (!f.editable || (existingRow && f.rowEditAccess?.existing === false)) &&
        !["calculated", "serial", "divider", "button", "tabs"].includes(
          f.type,
        ) &&
        JSON.stringify(next[f.id]) !== JSON.stringify(before[f.id])
      )
        errors.push("字段联动会修改无编辑权限的字段，请联系管理员调整规则");
    }
  }
  checkProtected(schema.fields, entry.values, values);
  errors.push(
    ...subformOperationErrors(
      schema.fields,
      entry.values,
      values,
      entry.values,
    ).map((issue) => issue.message),
  );
  const others = data.entries
    .filter(
      (e) =>
        e.id !== entry.id &&
        e.formId === entry.formId &&
        !e.deletedAt &&
        e.status !== "draft",
    )
    .map((e) => e.values);
  errors.push(
    ...validateValues(definition.schema, values, others, entry.values).map(
      (e) => e.message,
    ),
    ...validateDynamicValues(schema, values, context, true).map(
      (e) => e.message,
    ),
  );
  if (data.forms.find((form) => form.id === entry.formId)?.kind !== "workflow")
    errors.push(
      ...blockingFormValidation(definition.schema, values, {
        data: context,
        displaySchema: schema,
      }),
    );
  return { values: errors.length ? copy(entry.values) : values, errors };
}

export function prepareMemberCreate(
  schema: FormSchema,
  input: FormValues,
  data: WorkspaceData,
): FormValues {
  function visit(
    fields: FormField[],
    values: FormValues,
    root: FormValues = {},
  ): FormValues {
    let result = runtimeDefaults(fields, data, root);
    for (const f of fields) {
      if (
        !f.visible ||
        !f.editable ||
        ["calculated", "serial"].includes(f.type)
      )
        continue;
      if (f.type === "tabs")
        Object.assign(result, visit(f.children, values, root));
      else if (f.type !== "subform" && Object.hasOwn(values, f.id))
        result[f.id] = copy(values[f.id]);
    }
    for (const f of scopeFields(fields, true))
      if (
        f.visible &&
        f.editable &&
        !["calculated", "serial", "tabs", "subform"].includes(f.type) &&
        Object.hasOwn(values, f.id)
      )
        result = applyFieldChange(
          fields,
          result,
          f.id,
          result[f.id],
          data,
          root,
        );
    // Resolve root dependencies first, then retain the user's submitted rows.
    for (const f of scopeFields(fields, true).filter(
      (f) => f.type === "subform" && f.visible && f.editable,
    ))
      if (Object.hasOwn(values, f.id))
        result[f.id] = (
          Array.isArray(values[f.id]) ? (values[f.id] as FormValues[]) : []
        ).map((row) => ({
          ...visit(f.children, row, { ...root, ...result }),
          ...(row._rowId !== undefined ? { _rowId: row._rowId } : {}),
        }));
    return result;
  }
  return resolveCalculations(schema.fields, visit(schema.fields, input));
}
