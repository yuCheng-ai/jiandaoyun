import {
  validSelectionColumnLabels,
  hasFieldValue,
  isNumericField,
  validDateValue,
  choiceValueLabel,
  isChoiceTextValue,
  type FrontendDataSelection,
  type FrontendFieldChange,
} from "@platform/contracts";
import {
  copy,
  uid,
  isFieldVisibleInSchema,
  type FormField,
  type FormSchema,
  type FormValues,
} from "./form";
import { frontendValueFields, mapFrontendValues } from "./frontendEventValues";
import {
  linkTypesMatch,
  selectionFilterOperators,
  type DataFilter,
  type SelectionFilter,
} from "./fieldConfig";
import {
  sourceEntries,
  resolveChoices,
  displayValue,
  matchesFilters,
} from "./relations";
import { filterAndSortRecords } from "./records";
import type { WorkspaceData, FormEntry } from "./workspace";
import type { ConfigIssue, ExtensionRun } from "./extensions";

const supported = new Set([
  "text",
  "textarea",
  "number",
  "calculated",
  "datetime",
  "radio",
  "select",
  "checkbox",
  "multiselect",
  "address",
]);
const choices = new Set(["radio", "select", "checkbox", "multiselect"]);
export type SelectionProfile = "event" | "lookup";
const lookupSupported = new Set([
  ...supported,
  "member",
  "members",
  "department",
  "departments",
  "file",
  "image",
  "serial",
  "phone",
  "richtext",
  "ocr",
  "relation",
  "relationTable",
]);
export function selectionTypesMatch(
  source: FormField,
  target: FormField,
  profile: SelectionProfile = "event",
) {
  if (profile === "lookup" && ["phone", "serial"].includes(source.type))
    return target.type === "text";
  return linkTypesMatch(source, target);
}
const accepts = (type: string, profile: SelectionProfile) =>
  (profile === "lookup" ? lookupSupported : supported).has(type);
export function selectionSortFields(
  fields: ScopedField[],
  profile: SelectionProfile = "event",
) {
  return fields.filter(
    (field) =>
      hasFieldValue(field) &&
      !field.parentId &&
      (profile !== "lookup" ||
        [
          "text",
          "number",
          "datetime",
          "radio",
          "select",
          "serial",
          "calculated",
        ].includes(field.type)),
  );
}
type ScopedField = FormField & { parentId: string; pathLabel: string };
export function newFrontendSelection(): FrontendDataSelection {
  return {
    formId: "",
    columns: [],
    filters: [],
    match: "all",
    sort: { fieldId: "$createdAt", direction: "asc" },
    mappings: [],
    subformFill: "replace",
  };
}
export function selectionSourceFields(
  data: WorkspaceData,
  formId: string,
  profile: SelectionProfile = "event",
): ScopedField[] {
  const form = data.forms.find((form) => form.id === formId && !form.archived);
  return form?.published
    ? frontendValueFields(form.published.schema).filter((field) =>
        accepts(field.type, profile),
      )
    : [];
}
export function selectionLocalReferences(
  selection: FrontendDataSelection,
): string[] {
  return selection.filters
    .filter(
      (filter) => filter.source === "field" && filter.operator !== "notEmpty",
    )
    .map((filter) => filter.value);
}
export function selectionIssues(
  selection: FrontendDataSelection,
  inputs: FormField[],
  outputs: FormField[],
  data?: WorkspaceData,
  profile: SelectionProfile = "event",
): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const fail = (target: string, message: string) =>
    issues.push({ step: 1, target, message });
  if (!selection.formId) fail("selection-source", "请选择数据源");
  const source = data
    ? selectionSourceFields(data, selection.formId, profile)
    : undefined;
  if (
    data &&
    !data.forms.some(
      (form) =>
        form.id === selection.formId && form.published && !form.archived,
    )
  )
    fail("selection-source", "数据源已移除或尚未发布");
  if (
    !selection.columns.length ||
    (source &&
      selection.columns.some((id) => !source.some((field) => field.id === id)))
  )
    fail("selection-columns", "请选择有效的显示字段");
  if (!validSelectionColumnLabels(selection.columnLabels, selection.columns))
    fail("selection-columns", "显示列名称无效，请检查改名字段");
  if (
    source &&
    selection.sort.fieldId !== "$createdAt" &&
    !selectionSortFields(source, profile).some(
      (field) => field.id === selection.sort.fieldId,
    )
  )
    fail("selection-sort", "排序字段已移除或不是主表字段");
  for (const filter of selection.filters) {
    if (
      source &&
      !source.some(
        (field) => field.id === filter.sourceFieldId && !field.parentId,
      )
    )
      fail("selection-filters", "过滤条件的来源字段已移除或不是主表字段");
    if (
      filter.source === "field" &&
      filter.operator !== "notEmpty" &&
      !inputs.some((field) => field.id === filter.value && hasFieldValue(field))
    )
      fail("selection-filters", "过滤条件引用字段已移除或不在触发范围");
  }
  if (profile === "event" && !selection.mappings.length)
    fail("selection-mappings", "请选择填充字段");
  const targets = new Set<string>();
  for (const mapping of selection.mappings) {
    const target = outputs.find((field) => field.id === mapping.targetFieldId);
    const original = source?.find(
      (field) => field.id === mapping.sourceFieldId,
    );
    if (
      !target ||
      !hasFieldValue(target) ||
      !accepts(target.type, profile) ||
      ["calculated", "serial"].includes(target.type) ||
      (target.type === "relationTable" &&
        target.reference.mode === "reverse") ||
      (source && (!original || !selectionTypesMatch(original, target, profile)))
    )
      fail("selection-mappings", "填充字段已移除、类型不兼容或不在触发范围");
    if (original?.parentId && !(target as ScopedField | undefined)?.parentId)
      fail("selection-mappings", "来源明细列应填充到明细列");
    if (targets.has(mapping.targetFieldId))
      fail("selection-mappings", "同一字段只能配置一个来源");
    targets.add(mapping.targetFieldId);
  }
  return issues;
}
function choiceText(
  field: FormField,
  value: unknown,
  data: WorkspaceData,
  values: FormValues,
): unknown {
  if (!choices.has(field.type) || value == null || value === "") return value;
  const options = resolveChoices({ ...field, choiceSource: { ...field.choiceSource, filters: [] } }, data, values);
  const label = (item: unknown) => {
    if (
      !isChoiceTextValue(item) &&
      !options.some((option) => option.id === item)
    )
      throw Error("来源选项已不可用");
    return choiceValueLabel(options, item);
  };
  return Array.isArray(value) ? value.map(label) : label(value);
}
/** The caller's runtime data already removes inaccessible records and values. Never read the global store. */
export function selectionSourceValue(
  entry: FormEntry,
  field: ScopedField,
  data: WorkspaceData,
  allowEmptyCells = false,
): unknown {
  const form = data.forms.find((form) => form.id === entry.formId);
  const version =
    form?.versions.find(
      (version) => version.version === entry.definitionVersion,
    ) ||
    (form?.published?.version === entry.definitionVersion
      ? form.published
      : undefined);
  const original =
    version &&
    frontendValueFields(version.schema).find((item) => item.id === field.id);
  if (
    !original ||
    original.parentId !== field.parentId ||
    !linkTypesMatch(original, field)
  )
    throw Error("来源记录版本与字段不兼容");
  const read = (values: FormValues, root = entry.values) => {
    if (entry.readableFieldIds && !entry.readableFieldIds.includes(field.id))
      throw Error("无权读取来源字段或字段已不存在");
    if (
      !isFieldVisibleInSchema(original, version!.schema, { ...root, ...values })
    )
      throw Error("无权读取来源字段或字段已不存在");
    if (!Object.hasOwn(values, field.id)) {
      if (allowEmptyCells && field.parentId) return null;
      throw Error("无权读取来源字段或字段已不存在");
    }
    if (
      allowEmptyCells &&
      (values[field.id] == null || values[field.id] === "")
    )
      return null;
    return choiceText(original, values[field.id], data, { ...root, ...values });
  };
  if (!field.parentId) return read(entry.values);
  if (!Array.isArray(entry.values[field.parentId]))
    throw Error("来源明细已不存在或不可读取");
  return (entry.values[field.parentId] as FormValues[]).map((values) =>
    read(values),
  );
}
export function selectionDisplayValue(
  field: ScopedField,
  entry: FormEntry,
  data: WorkspaceData,
): string {
  try {
    const raw = selectionSourceValue(entry, field, data);
    const text = (value: unknown) =>
      choices.has(field.type)
        ? Array.isArray(value)
          ? value.join("、")
          : String(value ?? "—")
        : displayValue(field, value, data);
    return field.parentId
      ? (raw as unknown[]).map(text).join("；") || "—"
      : text(raw);
  } catch {
    return "—";
  }
}
/** Temporary filters narrow already-authorized candidates; they never replace configuration. */
export function selectionFilterFields(
  selection: FrontendDataSelection,
  fields: ScopedField[],
) {
  return selection.columns
    .flatMap((id) => fields.find((field) => field.id === id) || [])
    .filter(
      (field) =>
        hasFieldValue(field) &&
        field.visible &&
        [
          "text",
          "textarea",
          "number",
          "calculated",
          "datetime",
          "radio",
          "select",
          "checkbox",
          "multiselect",
          "member",
          "members",
          "department",
          "departments",
          "serial",
          "phone",
          "ocr",
        ].includes(field.type),
    );
}
export function selectionFilterError(
  filters: SelectionFilter[],
  fields: FormField[],
): string {
  for (const [index, filter] of filters.entries()) {
    const field = fields.find((field) => field.id === filter.sourceFieldId);
    if (
      !field ||
      filter.source !== "constant" ||
      !selectionFilterOperators(field).includes(filter.operator)
    )
      return `请选择条件${index + 1}的有效字段和比较方式`;
    if (["empty", "notEmpty"].includes(filter.operator)) continue;
    if (["equalsAny", "notEqualsAny"].includes(filter.operator)) {
      if (
        !Array.isArray(filter.value) ||
        !filter.value.length ||
        filter.value.some((value) => typeof value !== "string") ||
        (filter.operator === "notEqualsAny" && filter.value.includes(""))
      )
        return `请选择条件${index + 1}的比较值`;
      continue;
    }
    if (typeof filter.value !== "string" || !filter.value.trim())
      return `请选择条件${index + 1}的比较值`;
    if (isNumericField(field) && !Number.isFinite(Number(filter.value)))
      return `条件${index + 1}需要有效数字`;
    if (
      field.type === "datetime" &&
      !validDateValue(field.format, filter.value)
    )
      return `条件${index + 1}需要有效日期`;
  }
  return "";
}
export function filterSelectionCandidates(
  entries: FormEntry[],
  selection: FrontendDataSelection,
  data: WorkspaceData,
  filters: SelectionFilter[],
  profile: SelectionProfile = "lookup",
): FormEntry[] {
  if (!filters.length) return entries;
  const fields = selectionFilterFields(
    selection,
    selectionSourceFields(data, selection.formId, profile),
  );
  if (selectionFilterError(filters, fields)) return [];
  return entries.filter((entry) =>
    filters.every((filter) => {
      const field = fields.find((field) => field.id === filter.sourceFieldId)!;
      try {
        const raw = selectionSourceValue(entry, field, data);
        const test = (value: unknown) => {
          const compare = (operator: DataFilter["operator"], expected = "") =>
            matchesFilters(
              [{ ...filter, operator, value: expected, ...(field.choiceConversion ? { valueType: "text" as const } : {}) }],
              { [field.id]: value },
              {},
              data,
              "all",
              [field],
              [choices.has(field.type) ? { ...field, type: "text" } : field],
            );
          if (filter.operator === "empty") return !compare("notEmpty");
          if (filter.operator === "notContains")
            return !compare("contains", filter.value as string);
          if (["equalsAny", "notEqualsAny"].includes(filter.operator)) {
            const matched = (filter.value as string[]).some((expected) =>
              expected === ""
                ? !compare("notEmpty")
                : compare("equals", expected),
            );
            return filter.operator === "equalsAny" ? matched : !matched;
          }
          return compare(
            filter.operator as DataFilter["operator"],
            filter.value as string,
          );
        };
        if (!field.parentId) return test(raw);
        const rows = raw as unknown[];
        if (!rows.length) return test("");
        return ["notEquals", "notEqualsAny", "notContains", "empty"].includes(
          filter.operator,
        )
          ? rows.every(test)
          : rows.some(test);
      } catch {
        return false;
      }
    }),
  );
}
export function selectionCandidates(
  selection: FrontendDataSelection,
  data: WorkspaceData,
  values: FormValues,
  inputFields: FormField[] = [],
  query = "",
  profile: SelectionProfile = "event",
): FormEntry[] {
  const form = data.forms.find(
    (form) => form.id === selection.formId && !form.archived,
  );
  if (!form?.published) return [];
  const fields = selectionSourceFields(data, selection.formId, profile);
  const required = new Set([
    ...selection.columns,
    ...selection.mappings.map((mapping) => mapping.sourceFieldId),
    ...selection.filters.map((filter) => filter.sourceFieldId),
    ...(selection.sort.fieldId === "$createdAt"
      ? []
      : [selection.sort.fieldId]),
  ]);
  const candidates = sourceEntries(data, selection.formId).filter((entry) => {
    try {
      const record: FormValues = {};
      for (const id of required) {
        const field = fields.find((field) => field.id === id);
        if (!field || !field.visible) return false;
        record[id] = selectionSourceValue(entry, field, data);
      }
      const local = { ...values };
      for (const filter of selection.filters)
        if (filter.source === "field" && filter.operator !== "notEmpty") {
          const field = inputFields.find((field) => field.id === filter.value);
          if (
            !field ||
            !hasFieldValue(field) ||
            !field.visible ||
            !Object.hasOwn(values, field.id)
          )
            return false;
          local[field.id] = choiceText(field, values[field.id], data, values);
        }
      const filters = selection.filters.map((filter) => {
        const field = fields.find(
          (field) => field.id === filter.sourceFieldId,
        )!;
        return filter.source === "constant" && choices.has(field.type) && !field.choiceConversion
          ? {
              ...filter,
              value: String(
                choiceText(field, filter.value, data, entry.values) ?? "",
              ),
            }
          : filter;
      });
      if (
        !matchesFilters(filters, record, local, data, selection.match, fields, fields.map(field => choices.has(field.type) ? { ...field, type: "text" } : field), inputFields.map(field => choices.has(field.type) ? { ...field, type: "text" } : field))
      )
        return false;
      return (
        !query.trim() ||
        selection.columns.slice(0, 10).some(
          (id) =>
            (profile !== "lookup" ||
              (!fields.find((field) => field.id === id)?.parentId &&
                ![
                  "datetime",
                  "image",
                  "file",
                  "member",
                  "members",
                  "department",
                  "departments",
                  "relation",
                  "relationTable",
                ].includes(fields.find((field) => field.id === id)!.type))) &&
            selectionDisplayValue(
              fields.find((field) => field.id === id)!,
              entry,
              data,
            )
              .toLocaleLowerCase()
              .includes(query.trim().toLocaleLowerCase()),
        )
      );
    } catch {
      return false;
    }
  });
  return filterAndSortRecords(candidates, form.published.schema, data, {
    query: "",
    filters: [],
    view: {
      fieldIds: selection.columns,
      sortField: selection.sort.fieldId,
      descending: selection.sort.direction === "desc",
      pageSize: 10,
    },
  });
}
export function runFrontendSelection(
  selection: FrontendDataSelection,
  schema: FormSchema,
  values: FormValues,
  data: WorkspaceData,
  inputs: FormField[],
  outputs: ScopedField[],
  entryId: string,
  row?: FrontendFieldChange["row"],
  profile: SelectionProfile = "event",
): ExtensionRun {
  const run: ExtensionRun = {
    id: uid("run"),
    formId: "",
    subjectId: "",
    name: "选择数据填充",
    kind: "plugin",
    time: new Date().toISOString(),
    status: "success",
    mode: "local",
    origin: "trial",
    input: {},
    output: {},
    mappedValues: {},
    steps: [],
    snapshot: { config: copy(selection), schema: copy(schema), values: {} },
  };
  try {
    const issue = selectionIssues(selection, inputs, outputs, data, profile)[0];
    if (issue) throw Error(issue.message);
    const entry = selectionCandidates(
      selection,
      data,
      values,
      inputs,
      "",
      profile,
    ).find((entry) => entry.id === entryId);
    if (!entry)
      throw Error("所选数据已变化、不可读取或不再符合条件，请重新选择");
    const source = selectionSourceFields(data, selection.formId, profile);
    const mapped = selection.mappings.map((mapping) => {
      const field = source.find((field) => field.id === mapping.sourceFieldId)!;
      const target = outputs.find(
        (field) => field.id === mapping.targetFieldId,
      )!;
      let value = selectionSourceValue(entry, field, data);
      if (value === "" || value === undefined) value = null;
      if (row && field.parentId)
        throw Error("当前明细行不支持填充来源明细数组");
      if (target.parentId && !row && !field.parentId) value = [value];
      return { fieldId: target.id, value };
    });
    run.mappedValues = mapFrontendValues(
      schema,
      values,
      data,
      outputs,
      mapped,
      selection.subformFill,
      row,
      profile === "lookup",
    );
    run.input = { record: entry.id };
    run.steps = [
      {
        label: "选择并回填",
        status: "success",
        detail: `已回填${mapped.length}个字段`,
      },
    ];
  } catch (error) {
    run.status = "failed";
    run.mappedValues = {};
    run.error = {
      step: 1,
      target: "selection-mappings",
      message: (error as Error).message,
    };
    run.steps = [
      { label: "选择并回填", status: "failed", detail: run.error.message },
    ];
  }
  return run;
}
