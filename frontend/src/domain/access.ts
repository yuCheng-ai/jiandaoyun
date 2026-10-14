import {
  readableFormValidations,
  subformPermissions,
  type SubformPermissions,
} from "@platform/contracts";
import { entryDefinition } from "./collaboration";
import { type DataFilter } from "./fieldConfig";
import {
  copy,
  flattenFields,
  isFieldVisible,
  uid,
  type FormField,
  type FormSchema,
  type FormValues,
} from "./form";
import { resolveIdentities } from "./organization";
import { matchesFilters, recordFilterFields } from "./relations";
import type { FormEntry, FormRecord, WorkspaceData } from "./workspace";

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
/** 构造权限预览数据，不保存配置或授予真实访问权。 */
export function newAccessGroup(
  schema: FormSchema,
  preset = "read",
): AccessGroup {
  const group: AccessGroup = {
    id: uid("access"),
    name: "自定义权限组",
    enabled: true,
    archived: false,
    identities: [],
    actions: ["view"],
    scope: "all",
    filters: [],
    fields: {},
  };
  if (preset === "read") group.name = "查看全部数据";
  if (preset === "create") {
    group.name = "仅添加数据";
    group.actions = ["create"];
  }
  if (preset === "self") {
    group.name = "添加并管理本人数据";
    group.actions = ["view", "create", "edit", "delete"];
    group.scope = "self";
  }
  if (preset === "manage") {
    group.name = "管理全部数据";
    group.actions = [
      "view",
      "create",
      "edit",
      "delete",
      "import",
      "export",
      "print",
    ];
  }
  for (const field of flattenFields(schema.fields)) {
    group.fields[field.id] = ["manage", "self"].includes(preset)
      ? "edit"
      : "read";
    if (field.type === "subform") {
      group.subformPermissions ??= {};
      group.subformPermissions[field.id] = subformPermissions();
    }
  }
  return group;
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
  result.settings.validations = readableFormValidations(
    result.settings.validations,
    visible,
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
