import {
  uid,
  isFieldVisible,
  type FormField,
  type FormSchema,
  type FormValues,
} from "./form";
import { scopeFields, displayValue, relationCandidates } from "./relations";
import type { WorkspaceData } from "./workspace";
import {
  hasFieldValue,
  isFileValue,
  type FileValue,
} from "@platform/contracts";
import { lookupDisplay } from "./lookup";
import { selectionSourceFields } from "./frontendSelections";
import { titleFields } from "./collaboration";
import { templateReferences } from "./reminders";

export interface DetailSettings {
  fieldMode: "all" | "custom";
  fieldIds: string[];
  columns: 1 | 2;
  hideEmpty: boolean;
  showMetadata: boolean;
  showHistory: boolean;
}
export interface PrintTemplate extends DetailSettings {
  id: string;
  name: string;
  title: string;
  subtitle: string;
  footer: string;
  paper: "A4" | "A5";
  orientation: "portrait" | "landscape";
  fontSize: 12 | 14 | 16;
  archived: boolean;
  fileName?: { mode: "default" | "title" | "custom"; value: string };
}
export interface RecordBlock {
  id: string;
  label: string;
  text: string;
  images: string[];
  headers?: string[];
  rows?: string[][];
  files?: FileValue[];
  columnIds?: string[];
  rowFiles?: (FileValue[] | undefined)[][];
  rowImages?: string[][][];
  sourceField?: FormField;
  columnFields?: FormField[];
}
export const defaultDetailSettings = (): DetailSettings => ({
  fieldMode: "all",
  fieldIds: [],
  columns: 2,
  hideEmpty: false,
  showMetadata: true,
  showHistory: true,
});
export function presentationFields(
  schema: FormSchema,
  includeLookup = false,
): FormField[] {
  return scopeFields(schema.fields).filter(
    (f) => hasFieldValue(f) && (includeLookup || f.type !== "lookup"),
  );
}
export function newPrintTemplate(
  schema: FormSchema,
  title: string,
): PrintTemplate {
  return {
    ...defaultDetailSettings(),
    fieldMode: "custom",
    fieldIds: presentationFields(schema, true).map((f) => f.id),
    id: uid("print"),
    name: "标准打印模板",
    title,
    subtitle: "",
    footer: "",
    paper: "A4",
    orientation: "portrait",
    fontSize: 14,
    archived: false,
    fileName: { mode: "default", value: "" },
  };
}

/** Print bindings reuse field IDs; lookup values add the configured source ID. */
export function printFieldChoices(schema: FormSchema, data?: WorkspaceData) {
  return presentationFields(schema, true).flatMap((root) => {
    const fields =
      root.type === "subform" ? scopeFields(root.children) : [root];
    return fields.filter(hasFieldValue).flatMap((field) => {
      const label = `${root === field ? "" : `${root.label} · `}${field.label}`;
      if (field.type !== "lookup")
        return [{ id: field.id, label, rootId: root.id, field, sourceId: "" }];
      const sources = data
        ? selectionSourceFields(data, field.referenceFormId, "lookup")
        : undefined;
      return [
        ...new Set([
          ...(field.reference.displayColumns || []),
          ...field.reference.columns,
        ]),
      ].flatMap((sourceId) => {
        const source = sources?.find((source) => source.id === sourceId);
        if (sources && !source) return [];
        return [
          {
            id: `${field.id}:${sourceId}`,
            label: `${label} · ${source?.pathLabel || sourceId}`,
            rootId: root.id,
            field,
            sourceId,
          },
        ];
      });
    });
  });
}

/** Editing an old whole-group binding exposes only its existing printed content. */
export function expandedPrintFieldIds(schema: FormSchema, fieldIds: string[]) {
  const roots = presentationFields(schema, true);
  const lookupIds = (field: FormField) =>
    (field.reference.displayColumns || []).map((id) => `${field.id}:${id}`);
  return [
    ...new Set(
      fieldIds.flatMap((id) => {
        const field = roots.find((field) => field.id === id);
        if (field?.type === "lookup") return lookupIds(field);
        if (field?.type === "subform")
          return scopeFields(field.children)
            .filter(hasFieldValue)
            .flatMap((child) =>
              child.type === "lookup" ? lookupIds(child) : [child.id],
            );
        return [id];
      }),
    ),
  ];
}

export function printTemplateReferences(
  config: PrintTemplate,
  schema: FormSchema,
) {
  const choices = printFieldChoices(schema);
  return [
    ...new Set(
      [
        ...(config.fieldMode === "custom" ? config.fieldIds : []),
        ...(config.fileName?.mode === "custom"
          ? templateReferences(config.fileName.value)
          : []),
      ].flatMap((id) => {
        const choice = choices.find((choice) => choice.id === id);
        return choice ? [choice.rootId, choice.field.id] : [id];
      }),
    ),
  ];
}
const ids = (raw: unknown) =>
  Array.isArray(raw)
    ? [...new Set(raw.filter((s): s is string => typeof s === "string"))].slice(
        0,
        300,
      )
    : [];
export function parseDetailSettings(raw: any): DetailSettings {
  return {
    fieldMode: raw?.fieldMode === "custom" ? "custom" : "all",
    fieldIds: ids(raw?.fieldIds),
    columns: raw?.columns === 1 ? 1 : 2,
    hideEmpty: raw?.hideEmpty === true,
    showMetadata: raw?.showMetadata !== false,
    showHistory: raw?.showHistory !== false,
  };
}
export function parsePrintTemplates(raw: unknown): PrintTemplate[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  return raw.slice(0, 50).map((c) => {
    if (!c || typeof c.id !== "string" || seen.has(c.id))
      throw Error("打印模板 ID 无效或重复");
    seen.add(c.id);
    return {
      ...parseDetailSettings(c),
      id: c.id,
      name: String(c.name || "").slice(0, 80),
      title: String(c.title || "").slice(0, 120),
      subtitle: String(c.subtitle || "").slice(0, 300),
      footer: String(c.footer || "").slice(0, 300),
      paper: c.paper === "A5" ? "A5" : "A4",
      orientation: c.orientation === "landscape" ? "landscape" : "portrait",
      fontSize: [12, 14, 16].includes(c.fontSize) ? c.fontSize : 14,
      archived: c.archived === true,
      ...(c.fileName
        ? {
            fileName: {
              mode:
                c.fileName.mode === "custom"
                  ? ("custom" as const)
                  : c.fileName.mode === "title"
                    ? ("title" as const)
                    : ("default" as const),
              value: String(c.fileName.value || ""),
            },
          }
        : {}),
    };
  });
}
export function presentationIssues(
  config: DetailSettings,
  schema: FormSchema,
): string[] {
  if (config.fieldMode !== "custom") return [];
  const fields = presentationFields(schema, true);
  const errors: string[] = [];
  if (!config.fieldIds.length) errors.push("请至少选择一个展示字段");
  if (config.fieldIds.some((id) => !fields.some((f) => f.id === id)))
    errors.push("存在已删除的字段，请从展示列表移除");
  return errors;
}
export function printTemplateIssues(
  config: PrintTemplate,
  schema: FormSchema,
  data?: WorkspaceData,
): string[] {
  const fields = [
    ...presentationFields(schema, true),
    ...printFieldChoices(schema, data),
  ];
  const name = config.fileName;
  const references =
    name?.mode === "custom" ? templateReferences(name.value) : [];
  const fixedName = name?.value.replace(/\{\{[^{}]+\}\}/g, "") || "";
  return [
    ...(!config.name.trim() ? ["请填写模板名称"] : []),
    ...(config.fieldMode === "custom" && !config.fieldIds.length
      ? ["请至少选择一个展示字段"]
      : []),
    ...(config.fieldMode === "custom" && config.fieldIds.length > 300
      ? ["最多选择 300 个展示字段"]
      : []),
    ...(config.fieldMode === "custom" &&
    config.fieldIds.some((id) => !fields.some((field) => field.id === id))
      ? ["存在已删除或不再可用的字段，请从展示列表移除"]
      : []),
    ...(name?.mode === "custom"
      ? [
          ...(!name.value.trim() ? ["请填写自定义文件名称"] : []),
          ...([...fixedName].length + references.length > 50
            ? ["自定义文件名称最多 50 个字符"]
            : []),
          ...(references.length > 10 ? ["文件名称最多插入 10 个字段"] : []),
          ...(/[\u0000-\u001f?*:"<>\\/|$\s]/.test(fixedName)
            ? ['文件名称不能包含空格或 ? * : " < > \\ / | $']
            : []),
          ...(/[{}]/.test(fixedName)
            ? ["文件名称的字段内容不完整，请使用插入字段"]
            : []),
          ...(references.some(
            (id) => !titleFields(schema).some((field) => field.id === id),
          )
            ? ["文件名称引用的字段已失效，请重新选择"]
            : []),
        ]
      : []),
  ];
}

function selectedPrintFields(
  schema: FormSchema,
  config: PrintTemplate,
  data: WorkspaceData,
) {
  const roots = presentationFields(schema, true);
  if (config.fieldMode === "all") return roots;
  const choices = printFieldChoices(schema, data);
  const selected = config.fieldIds
    .map((id) => choices.find((choice) => choice.id === id))
    .filter((choice): choice is NonNullable<typeof choice> => !!choice);
  const select = (field: FormField, sourceId: string) => {
    if (field.type !== "lookup") return field;
    return {
      ...field,
      reference: {
        ...field.reference,
        displayColumns: [sourceId],
      },
    };
  };
  const rowGroups = new Set<string>();
  return [...new Set(config.fieldIds)].flatMap((id) => {
    const legacy = roots.find((field) => field.id === id);
    // Persisted whole-field templates retain exactly their original behavior.
    if (legacy) return [legacy];
    const choice = selected.find((choice) => choice.id === id);
    if (!choice || config.fieldIds.includes(choice.rootId)) return [];
    const root = roots.find((field) => field.id === choice.rootId)!;
    if (root.type !== "subform") return [select(root, choice.sourceId)];
    if (rowGroups.has(root.id)) return [];
    rowGroups.add(root.id);
    const within = selected.filter((choice) => choice.rootId === root.id);
    return [
      {
        ...root,
        children: within.map((choice) => select(choice.field, choice.sourceId)),
      },
    ];
  });
}
export function selectedPresentationFields(
  schema: FormSchema,
  config: DetailSettings,
): FormField[] {
  const fields = presentationFields(schema, true);
  return config.fieldMode === "all"
    ? fields
    : config.fieldIds
        .map((id) => fields.find((f) => f.id === id))
        .filter((f): f is FormField => !!f);
}
const empty = (v: unknown) =>
  v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length);
function recordImages(type: string, value: unknown): string[] {
  const localRaster = (preview: unknown): preview is string =>
    typeof preview === "string" &&
    /^data:image\/(png|jpeg|gif|webp);base64,/.test(preview);
  if (type === "signature") return localRaster(value) ? [value] : [];
  return type === "image" && Array.isArray(value)
    ? value.map((v) => v?.preview).filter(localRaster)
    : [];
}
export function buildRecordBlocks(
  schema: FormSchema,
  values: FormValues,
  config: DetailSettings,
  data: WorkspaceData,
  entryId?: string,
): RecordBlock[] {
  const visibleIds = new Set<string>();
  const visit = (fields: FormField[]) => {
    for (const f of fields) {
      if (!isFieldVisible(f, schema, values)) continue;
      if (f.type === "tabs") visit(f.children);
      else visibleIds.add(f.id);
    }
  };
  visit(schema.fields);
  const fields =
    "paper" in config
      ? selectedPrintFields(schema, config as PrintTemplate, data)
      : selectedPresentationFields(schema, config);
  return fields.flatMap((field) => {
    if (!visibleIds.has(field.id)) return [];
    const value = values[field.id];
    if (field.type === "lookup")
      return lookupDisplay(field, value, data).map((item) => ({
        id: `${field.id}:${item.id}`,
        label: item.label,
        text: item.text,
        images: recordImages(item.sourceField.type, item.files),
        files: item.files,
        sourceField: item.sourceField,
      }));
    const block: RecordBlock = {
      id: field.id,
      label: field.label,
      text: displayValue(field, value, data),
      images: [],
    };
    if (field.type === "subform") {
      const children = scopeFields(field.children)
        .filter((f) => hasFieldValue(f) && f.visible)
        .flatMap((f) =>
          f.type === "lookup"
            ? lookupDisplay(f, undefined, data).map((item) => ({
                field: f,
                id: `${f.id}:${item.id}`,
                label: item.label,
                sourceId: item.id,
                sourceField: item.sourceField,
              }))
            : [
                {
                  field: f,
                  id: f.id,
                  label: f.label,
                  sourceId: "",
                  sourceField: f,
                },
              ],
        );
      block.headers = children.map((f) => f.label);
      block.columnIds = children.map((f) => f.id);
      block.columnFields = children.map((f) => f.sourceField);
      block.rowFiles = (Array.isArray(value) ? value : [])
        .filter((row) => row && typeof row === "object")
        .map((row) =>
          children.map(({ field: f, sourceId }) => {
            if (!isFieldVisible(f, schema, { ...values, ...row }))
              return undefined;
            if (sourceId)
              return lookupDisplay(f, row[f.id], data).find(
                (item) => item.id === sourceId,
              )?.files;
            return ["file", "image"].includes(f.type)
              ? Array.isArray(row[f.id])
                ? row[f.id].filter(isFileValue)
                : []
              : undefined;
          }),
        );
      block.rowImages = (Array.isArray(value) ? value : [])
        .filter((row) => row && typeof row === "object")
        .map((row, index) =>
          children.map(({ field: f, sourceId, sourceField }, col) =>
            isFieldVisible(f, schema, { ...values, ...row })
              ? recordImages(
                  sourceField.type,
                  sourceId ? block.rowFiles?.[index]?.[col] : row[f.id],
                )
              : [],
          ),
        );
      block.rows = (Array.isArray(value) ? value : [])
        .filter((row) => row && typeof row === "object")
        .map((row) =>
          children.map(({ field: f, sourceId }) =>
            isFieldVisible(f, schema, { ...values, ...row })
              ? sourceId
                ? lookupDisplay(f, row[f.id], data).find(
                    (item) => item.id === sourceId,
                  )?.text || "—"
                : displayValue(f, row[f.id], data)
              : "—",
          ),
        );
    } else if (field.type === "relationTable") {
      const source = data.forms.find((f) => f.id === field.referenceFormId);
      const candidates =
        field.reference.mode === "reverse"
          ? relationCandidates(field, data, values, entryId, schema.fields)
          : data.entries.filter(
              (e) => e.formId === field.referenceFormId && !e.deletedAt,
            );
      const selected =
        field.reference.mode === "reverse"
          ? candidates
          : candidates.filter((e) =>
              (Array.isArray(value) ? value : [value]).includes(e.id),
            );
      const available = source
        ? scopeFields(source.schema.fields).filter(hasFieldValue)
        : [];
      const columns = field.reference.columns.length
        ? field.reference.columns
            .map((id) => available.find((f) => f.id === id))
            .filter((f): f is FormField => !!f)
        : available.slice(0, 3);
      block.headers = columns.map((f) => f.label);
      block.rows = selected.map((e) =>
        columns.map((f) => displayValue(f, e.values[f.id], data)),
      );
      block.text = `${selected.length} 条关联`;
    }
    if (["file", "image"].includes(field.type) && Array.isArray(value))
      block.files = value.filter(isFileValue);
    // Only locally stored raster previews are rendered; URLs and SVG are not fetched.
    block.images = recordImages(field.type, value);
    if (config.hideEmpty && (block.rows ? !block.rows.length : empty(value)))
      return [];
    return [block];
  });
}
