import {
  copy,
  uid,
  isFieldVisible,
  prepareSubmission,
  validateValues,
  type FormSchema,
  type FormField,
  type FormValues,
} from "./form";
import {
  scopeFields,
  displayValue,
  applyFieldChange,
  resolveRuntimeValues,
} from "./relations";
import { validateDynamicValues } from "./fieldValidation";
import { blockingFormValidation } from "./formValidation";
import type { FormEntry, WorkspaceData } from "./workspace";

export interface TitlePart {
  id: string;
  kind: "text" | "field";
  value: string;
}
export interface CollaborationSettings {
  titleMode: "default" | "custom";
  titleParts: TitlePart[];
  inlineEdit: boolean;
}
export const defaultCollaboration = (): CollaborationSettings => ({
  titleMode: "default",
  titleParts: [],
  inlineEdit: false,
});
export function newTitlePart(kind: TitlePart["kind"]): TitlePart {
  return { id: uid("title"), kind, value: "" };
}
export function parseCollaboration(raw: any): CollaborationSettings {
  const seen = new Set<string>();
  return {
    titleMode: raw?.titleMode === "custom" ? "custom" : "default",
    inlineEdit: raw?.inlineEdit === true,
    titleParts: (Array.isArray(raw?.titleParts) ? raw.titleParts : [])
      .slice(0, 20)
      .map((p: any) => {
        if (
          !p ||
          typeof p.id !== "string" ||
          !p.id ||
          seen.has(p.id) ||
          !["text", "field"].includes(p.kind)
        )
          throw Error("数据标题片段无效或重复");
        seen.add(p.id);
        return {
          id: p.id,
          kind: p.kind,
          value: String(p.value || "").slice(0, 200),
        };
      }),
  };
}
const titleTypes = [
  "text",
  "textarea",
  "number",
  "datetime",
  "radio",
  "checkbox",
  "select",
  "multiselect",
  "member",
  "members",
  "department",
  "departments",
  "serial",
  "phone",
  "calculated",
  "address",
];
const editableTypes = [
  "text",
  "textarea",
  "number",
  "datetime",
  "radio",
  "checkbox",
  "select",
  "multiselect",
  "member",
  "members",
  "department",
  "departments",
  "phone",
  "address",
  "query",
  "lookup",
  "relation",
];
export function titleFields(schema: FormSchema): FormField[] {
  return scopeFields(schema.fields).filter((f) => titleTypes.includes(f.type));
}
export function fieldInContext(
  schema: FormSchema,
  id: string,
  values: FormValues,
  editing = false,
): FormField | undefined {
  function find(fields: FormField[]): FormField | undefined {
    for (const f of fields) {
      if (!isFieldVisible(f, schema, values) || (editing && !f.editable))
        continue;
      if (f.id === id) return f;
      if (f.type === "tabs") {
        const child = find(f.children);
        if (child) return child;
      }
    }
  }
  return find(schema.fields);
}
export function collaborationIssues(
  config: CollaborationSettings,
  schema: FormSchema,
): string[] {
  if (config.titleMode !== "custom") return [];
  const errors: string[] = [],
    fields = new Set(titleFields(schema).map((f) => f.id));
  if (
    !config.titleParts.length ||
    !config.titleParts.some((p) => p.value.trim())
  )
    errors.push("请添加标题内容");
  if (config.titleParts.length > 20) errors.push("数据标题最多包含 20 个片段");
  if (config.titleParts.some((p) => p.kind === "field" && !fields.has(p.value)))
    errors.push("标题引用的字段已失效，请重新选择");
  if (config.titleParts.some((p) => p.kind === "text" && p.value.length > 200))
    errors.push("每个固定文字片段最多 200 个字符");
  return errors;
}
export function renderDataTitle(
  config: CollaborationSettings | undefined,
  schema: FormSchema,
  values: FormValues,
  data: WorkspaceData,
  fallback: string,
): string {
  const fields = titleFields(schema),
    byId = new Map(fields.map((f) => [f.id, f]));
  const show = (id: string) => {
    const f = byId.get(id),
      value = values[id];
    return !f ||
      !fieldInContext(schema, id, values) ||
      value == null ||
      value === "" ||
      (Array.isArray(value) && !value.length)
      ? ""
      : displayValue(f, value, data);
  };
  const title =
    config?.titleMode === "custom"
      ? config.titleParts
          .map((p) => (p.kind === "text" ? p.value : show(p.value)))
          .join("")
      : fields.map((f) => show(f.id)).find(Boolean) || "";
  return (title.trim() || fallback).slice(0, 200);
}
export function entryDefinition(entry: FormEntry, data: WorkspaceData) {
  const form = data.forms.find((f) => f.id === entry.formId);
  return (
    form?.versions.find((v) => v.version === entry.definitionVersion) ||
    (form?.published?.version === entry.definitionVersion
      ? form.published
      : undefined)
  );
}
export function entryTitle(entry: FormEntry, data: WorkspaceData): string {
  const definition = entryDefinition(entry, data),
    form = data.forms.find((f) => f.id === entry.formId);
  const fallback = `${definition?.title || form?.title || "记录"} · ${entry.id.slice(-6)}`;
  return definition
    ? renderDataTitle(
        definition.extensions?.collaboration,
        definition.schema,
        entry.values,
        data,
        fallback,
      )
    : fallback;
}
export function inlineEditField(
  entry: FormEntry,
  id: string,
  data: WorkspaceData,
): FormField | undefined {
  const form = data.forms.find((f) => f.id === entry.formId),
    definition = entryDefinition(entry, data);
  if (
    !form ||
    form.archived ||
    entry.deletedAt ||
    entry.status === "draft" ||
    !definition?.extensions?.collaboration?.inlineEdit
  )
    return;
  const f = fieldInContext(definition.schema, id, entry.values, true);
  return f &&
    editableTypes.includes(f.type) &&
    !(
      ["query", "lookup", "relation"].includes(f.type) &&
      f.reference.mode === "reverse"
    )
    ? f
    : undefined;
}
export interface InlineEditResult {
  values: FormValues;
  changes: { id: string; label: string; before: string; after: string }[];
  errors: string[];
}
export function prepareInlineEdit(
  entry: FormEntry,
  id: string,
  value: unknown,
  data: WorkspaceData,
): InlineEditResult {
  const result: InlineEditResult = {
    values: copy(entry.values),
    changes: [],
    errors: [],
  };
  const field = inlineEditField(entry, id, data),
    definition = entryDefinition(entry, data);
  if (!field || !definition) {
    result.errors.push("此记录或字段不支持快捷编辑，请检查发布版本和字段权限");
    return result;
  }
  const next = prepareSubmission(
    definition.schema,
    resolveRuntimeValues(
      definition.schema,
      applyFieldChange(definition.schema.fields, entry.values, id, value, data),
      data,
      entry.values,
    ),
    entry.values,
    true,
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
  result.errors = [
    ...validateValues(definition.schema, next, others, entry.values),
    ...validateDynamicValues(definition.schema, next, data),
  ].map((e) => e.message);
  if (data.forms.find((form) => form.id === entry.formId)?.kind !== "workflow")
    result.errors.push(
      ...blockingFormValidation(definition.schema, next, { data }),
    );
  result.values = next;
  result.changes = scopeFields(definition.schema.fields)
    .filter(
      (f) => JSON.stringify(next[f.id]) !== JSON.stringify(entry.values[f.id]),
    )
    .map((f) => ({
      id: f.id,
      label: f.label,
      before: displayValue(f, entry.values[f.id], data),
      after: displayValue(f, next[f.id], data),
    }));
  return result;
}
