import {
  hasFieldValue,
  isNumericField,
  validSelectionColumnLabels,
} from "@platform/contracts";
import type { OrganizationFieldConfig } from "./organization";
import type {
  DataFilter,
  ChoiceSource,
  ReferenceConfig,
  DefaultLink,
  FormField,
} from "@platform/contracts";
export type {
  DataFilter,
  ChoiceSource,
  ReferenceConfig,
  DefaultLink,
} from "@platform/contracts";
/** Unpersisted conditions used to narrow an already authorized selection. */
export type SelectionFilter = Omit<DataFilter, "operator" | "value"> & {
  operator:
    | DataFilter["operator"]
    | "equalsAny"
    | "notEqualsAny"
    | "notContains"
    | "empty";
  value: string | string[];
};
export function selectionFilterOperators(
  field?: FormField,
): SelectionFilter["operator"][] {
  if (!field || !hasFieldValue(field)) return [];
  return [
    "equals",
    "notEquals",
    ...(isNumericField(field) || field.type === "datetime"
      ? (["greater", "less"] as const)
      : ([
          "equalsAny",
          "notEqualsAny",
          ...([
            "text",
            "textarea",
            "serial",
            "phone",
            "ocr",
            "calculated",
          ].includes(field.type)
            ? (["contains", "notContains"] as const)
            : []),
        ] as const)),
    "empty",
    "notEmpty",
  ];
}
export const defaultLinkTypes = [
  "text",
  "textarea",
  "richtext",
  "number",
  "datetime",
  "address",
  "location",
  "file",
  "image",
  "subform",
];
export const emptyDefaultLink = (): DefaultLink => ({
  enabled: false,
  formId: "",
  fieldId: "",
  filters: [],
  match: "all",
});
export function parseDefaultLink(raw: unknown): DefaultLink | undefined {
  if (raw === undefined) return;
  const value = raw as DefaultLink;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof value.enabled !== "boolean" ||
    typeof value.formId !== "string" ||
    typeof value.fieldId !== "string" ||
    !["all", "any"].includes(value.match) ||
    !Array.isArray(value.filters) ||
    parseFilters(value.filters).length !== value.filters.length ||
    value.filters.some(
      (f) => typeof f.sourceFieldId !== "string" || typeof f.value !== "string",
    ) ||
    (value.mappings !== undefined &&
      (!Array.isArray(value.mappings) ||
        value.mappings.some(
          (m) =>
            !m ||
            typeof m.sourceFieldId !== "string" ||
            typeof m.targetFieldId !== "string",
        )))
  )
    throw Error("默认值联动配置无效");
  return {
    enabled: value.enabled,
    formId: value.formId,
    fieldId: value.fieldId,
    filters: parseFilters(value.filters),
    match: value.match,
    ...(value.mappings !== undefined
      ? { mappings: value.mappings.map((m) => ({ ...m })) }
      : {}),
  };
}
/** The source product treats text/single-choice and multiple-choice shapes as compatible. */
export function linkTypesMatch(a: FormField, b: FormField): boolean {
  if (!hasFieldValue(a) || !hasFieldValue(b)) return false;
  const type = (field: FormField) =>
    field.type === "calculated"
      ? isNumericField(field)
        ? "number"
        : "text"
      : field.type;
  const from = type(a),
    to = type(b);
  if (from === to) return from !== "datetime" || a.format === b.format;
  return [
    ["text", "textarea", "radio", "select"],
    ["checkbox", "multiselect"],
  ].some((types) => types.includes(from) && types.includes(to));
}
export const emptyChoiceSource = (): ChoiceSource => ({
  mode: "manual",
  formId: "",
  labelFieldId: "",
  valueFieldId: "",
  filters: [],
  sort: "none",
  deduplicate: true,
});
export const emptyReference = (): ReferenceConfig => ({
  mode: "forward",
  filters: [],
  columns: [],
  mappings: [],
  reverseFieldId: "",
});
export const emptyOrganizationConfig = (): OrganizationFieldConfig => ({
  scope: {
    mode: "all",
    departmentIds: [],
    employeeIds: [],
    roleIds: [],
    includeChildren: true,
    fieldId: "",
  },
  defaultMode: "none",
  defaultIds: [],
});
const str = (v: unknown) => (typeof v === "string" ? v : "");
const list = (v: unknown): string[] =>
  Array.isArray(v)
    ? [...new Set(v.filter((x): x is string => typeof x === "string"))]
    : [];
export function parseFilters(raw: unknown): DataFilter[] {
  if (
    Array.isArray(raw) &&
    raw.some(
      (f) =>
        f &&
        f.valueType !== undefined &&
        !["text", "choice"].includes(f.valueType),
    )
  )
    throw Error("筛选条件值类型无效");
  return Array.isArray(raw)
    ? raw
        .filter(
          (f) =>
            f &&
            typeof f === "object" &&
            typeof f.id === "string" &&
            [
              "equals",
              "notEquals",
              "contains",
              "greater",
              "less",
              "notEmpty",
            ].includes(f.operator) &&
            ["constant", "field", "currentUser", "currentDepartment"].includes(
              f.source,
            ),
        )
        .map((f) => ({
          id: f.id,
          sourceFieldId: str(f.sourceFieldId),
          operator: f.operator,
          source: f.source,
          value: str(f.value),
          ...(["text", "choice"].includes(f.valueType)
            ? { valueType: f.valueType }
            : {}),
        }))
    : [];
}
export function parseChoiceSource(
  raw: Partial<ChoiceSource> | undefined,
): ChoiceSource {
  const base = emptyChoiceSource();
  if (!raw) return base;
  return {
    mode: raw.mode === "form" ? "form" : "manual",
    formId: str(raw.formId),
    labelFieldId: str(raw.labelFieldId),
    valueFieldId: str(raw.valueFieldId),
    filters: parseFilters(raw.filters),
    sort: raw.sort === "asc" || raw.sort === "desc" ? raw.sort : "none",
    deduplicate: raw.deduplicate !== false,
  };
}
export function parseReference(
  raw: Partial<ReferenceConfig> | undefined,
): ReferenceConfig {
  if (!validSelectionColumnLabels(raw?.columnLabels, list(raw?.columns)))
    throw Error("显示列名称配置无效");
  if (
    raw?.displayColumns !== undefined &&
    (!Array.isArray(raw.displayColumns) ||
      raw.displayColumns.some((id) => typeof id !== "string" || !id) ||
      new Set(raw.displayColumns).size !== raw.displayColumns.length)
  )
    throw Error("表单显示字段配置无效");
  if (raw?.match !== undefined && !["all", "any"].includes(raw.match))
    throw Error("数据过滤关系配置无效");
  if (
    raw?.sort !== undefined &&
    (!raw.sort ||
      typeof raw.sort.fieldId !== "string" ||
      !raw.sort.fieldId ||
      !["asc", "desc"].includes(raw.sort.direction))
  )
    throw Error("数据排序配置无效");
  return {
    mode: raw?.mode === "reverse" ? "reverse" : "forward",
    filters: parseFilters(raw?.filters),
    columns: list(raw?.columns),
    ...(raw?.columnLabels !== undefined
      ? { columnLabels: { ...raw.columnLabels } }
      : {}),
    mappings: Array.isArray(raw?.mappings)
      ? raw.mappings
          .filter(
            (m) =>
              m &&
              typeof m.sourceFieldId === "string" &&
              typeof m.targetFieldId === "string",
          )
          .map((m) => ({
            sourceFieldId: m.sourceFieldId,
            targetFieldId: m.targetFieldId,
          }))
      : [],
    reverseFieldId: str(raw?.reverseFieldId),
    ...(raw?.displayColumns !== undefined
      ? { displayColumns: list(raw.displayColumns) }
      : {}),
    ...(raw?.match !== undefined
      ? { match: raw.match === "any" ? ("any" as const) : ("all" as const) }
      : {}),
    ...(raw?.sort !== undefined
      ? {
          sort: {
            fieldId: str(raw.sort.fieldId),
            direction:
              raw.sort.direction === "desc"
                ? ("desc" as const)
                : ("asc" as const),
          },
        }
      : {}),
  };
}
export function parseOrganizationConfig(
  raw: Partial<OrganizationFieldConfig> | undefined,
): OrganizationFieldConfig {
  const base = emptyOrganizationConfig();
  const s = raw?.scope;
  return {
    defaultMode:
      raw &&
      [
        "none",
        "currentUser",
        "currentDepartment",
        "departmentManager",
      ].includes(raw.defaultMode!)
        ? raw.defaultMode!
        : base.defaultMode,
    defaultIds: list(raw?.defaultIds),
    scope: {
      mode:
        s &&
        ["all", "custom", "currentDepartment", "fieldDepartment"].includes(
          s.mode,
        )
          ? s.mode
          : "all",
      departmentIds: list(s?.departmentIds),
      employeeIds: list(s?.employeeIds),
      roleIds: list(s?.roleIds),
      includeChildren: s?.includeChildren !== false,
      fieldId: str(s?.fieldId),
    },
  };
}
