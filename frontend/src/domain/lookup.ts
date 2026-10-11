import { subformRowCountIssue, isNumericField } from "@platform/contracts";
import {
  isFileValue,
  type FileValue,
  type FrontendDataSelection,
  type FrontendFieldChange,
} from "@platform/contracts";
import {
  copy,
  createField,
  uid,
  findField,
  findFieldContainer,
  flattenFields,
  countFormFields,
  fieldDepth,
  isFieldVisibleInSchema,
  type FormField,
  type FormSchema,
  type FormValues,
} from "./form";
import { frontendValueFields } from "./frontendEventValues";
import {
  newFrontendSelection,
  runFrontendSelection,
  selectionDisplayValue,
  selectionSourceValue,
  selectionSourceFields,
  selectionIssues,
} from "./frontendSelections";
import { applyFieldChange, idsOf, runtimeDefaults } from "./relations";
import type { WorkspaceData } from "./workspace";

/** Adapt the existing field configuration; no second event or stored schema. */
export function lookupSelection(
  field: FormField,
  data: WorkspaceData,
): FrontendDataSelection {
  return {
    ...newFrontendSelection(),
    formId: field.referenceFormId,
    columns: field.reference.columns.length
      ? field.reference.columns
      : selectionSourceFields(data, field.referenceFormId, "lookup")
          .slice(0, 3)
          .map((field) => field.id),
    ...(field.reference.columnLabels !== undefined
      ? { columnLabels: field.reference.columnLabels }
      : {}),
    filters: field.reference.filters,
    match: field.reference.match || "all",
    sort: field.reference.sort || { fieldId: "$createdAt", direction: "asc" },
    mappings: field.reference.mappings,
  };
}
export function lookupScope(field: FormField, schema: FormSchema) {
  const fields = frontendValueFields(schema);
  const owner = fields.find((item) => item.id === field.id)?.parentId || "";
  return {
    inputs: fields.filter((item) => !item.parentId || item.parentId === owner),
    outputs: fields.filter(
      (item) => item.id !== field.id && (!owner || item.parentId === owner),
    ),
    owner,
  };
}
/** Create ordinary receivers and their mappings in one designer transaction. */
export function createLookupFields(
  schema: FormSchema,
  fieldId: string,
  sourceIds: string[],
  data: WorkspaceData,
): FormSchema {
  const original = findField(schema.fields, fieldId);
  if (!original || original.type !== "lookup")
    throw Error("请选择有效的选择数据字段");
  const scope = lookupScope(original, schema);
  const available = selectionSourceFields(
    data,
    original.referenceFormId,
    "lookup",
  );
  const sources = sourceIds.map((id) =>
    available.find((field) => field.id === id),
  );
  if (
    new Set(sourceIds).size !== sourceIds.length ||
    sources.some((field) => !field || (scope.owner && field.parentId))
  )
    throw Error("来源字段已移除或不在当前可填充范围");
  const next = copy(schema);
  const lookup = findField(next.fields, fieldId)!;
  const container = findFieldContainer(next.fields, fieldId)!;
  const ids = new Map(sourceIds.map((id) => [id, uid()]));
  const additions: FormField[] = [];
  const groups = new Map<string, FormField>();
  const sourceSchema = data.forms.find(
    (form) => form.id === original.referenceFormId,
  )?.published?.schema;
  function localId(id: string) {
    const mapped = ids.get(id);
    if (!mapped) {
      const name = sourceSchema && findField(sourceSchema.fields, id)?.label;
      throw Error(`请同时选择${name ? `「${name}」` : "依赖的来源字段"}`);
    }
    return mapped;
  }
  const remapFilters = (filters: FormField["reference"]["filters"]) =>
    copy(filters).map((filter) => ({
      ...filter,
      id: uid("filter"),
      ...(filter.source === "field" && filter.operator !== "notEmpty"
        ? { value: localId(filter.value) }
        : {}),
    }));
  for (const source of sources) {
    const field = source!;
    const type = ["serial", "phone"].includes(field.type)
      ? "text"
      : field.type === "calculated"
        ? isNumericField(field)
          ? "number"
          : "text"
        : field.type;
    const receiver = createField(type, {
      id: ids.get(field.id)!,
      label: field.label,
      defaultValue: "",
      format: type === "text" ? "none" : field.format,
      precision: field.precision,
      retainPrecision: field.retainPrecision,
      numberGrouping: field.numberGrouping,
      maxLength: field.maxLength,
      rows: field.rows,
      accept: field.accept,
      multiple: field.multiple,
      limitFileTypes: field.limitFileTypes,
      maxFileSize: field.maxFileSize,
      uploadStyle: field.uploadStyle,
    });
    if (["radio", "select", "checkbox", "multiselect"].includes(type)) {
      const options = new Map(
        field.options.map((option) => [option.id, uid("option")]),
      );
      receiver.options = field.options.map((option) => ({
        ...copy(option),
        id: options.get(option.id)!,
      }));
      if (field.choiceSource.mode === "form")
        receiver.choiceSource = {
          ...copy(field.choiceSource),
          filters: remapFilters(field.choiceSource.filters),
        };
      receiver.choiceLayout = field.choiceLayout;
      receiver.coloredOptions = field.coloredOptions;
      receiver.allowCustomChoices = field.allowCustomChoices;
      if (field.optionColors)
        receiver.optionColors = Object.fromEntries(
          Object.entries(field.optionColors).flatMap(([id, color]) =>
            options.has(id) ? [[options.get(id)!, color]] : [],
          ),
        );
    }
    if (["member", "members", "department", "departments"].includes(type)) {
      receiver.organization.scope = copy(field.organization.scope);
      if (receiver.organization.scope.mode === "fieldDepartment")
        receiver.organization.scope.fieldId = localId(
          receiver.organization.scope.fieldId,
        );
    }
    if (["relation", "relationTable"].includes(type)) {
      if (type === "relationTable" && field.reference.mode === "reverse")
        throw Error("反向关联子表请填充到已有字段");
      receiver.referenceFormId = field.referenceFormId;
      receiver.referenceFieldId = field.referenceFieldId;
      receiver.reference = {
        ...copy(field.reference),
        filters: remapFilters(field.reference.filters),
        mappings: [],
      };
    }
    if (field.parentId) {
      let group = groups.get(field.parentId);
      if (!group) {
        group = createField("subform", {
          label:
            findField(sourceSchema!.fields, field.parentId)?.label || "明细",
          tabId: lookup.tabId,
        });
        groups.set(field.parentId, group);
        additions.push(group);
      }
      group.children.push(receiver);
    } else {
      receiver.tabId = lookup.tabId;
      additions.push(receiver);
    }
  }
  if (groups.size && fieldDepth(schema.fields, fieldId) >= 4)
    throw Error("字段嵌套最多四层");
  if (countFormFields(schema.fields) + countFormFields(additions) > 300)
    throw Error("单个表单最多 300 个字段");
  container.splice(container.indexOf(lookup) + 1, 0, ...additions);
  lookup.reference.mappings = sourceIds.map((id) => ({
    sourceFieldId: id,
    targetFieldId: ids.get(id)!,
  }));
  const issue = lookupIssues(lookup, next, data)[0];
  if (issue) throw Error(issue);
  return next;
}
export function lookupIssues(
  field: FormField,
  schema: FormSchema,
  data: WorkspaceData,
): string[] {
  const scope = lookupScope(field, schema),
    selection = lookupSelection(field, data);
  const source = selectionSourceFields(data, field.referenceFormId, "lookup");
  return [
    ...selectionIssues(
      selection,
      scope.inputs,
      scope.outputs,
      data,
      "lookup",
    ).map((issue) => issue.message),
    ...(field.reference.displayColumns?.some(
      (id) => !source.some((field) => field.id === id),
    )
      ? ["表单显示字段已移除"]
      : []),
    ...(scope.owner &&
    selection.mappings.some(
      (mapping) =>
        source.find((field) => field.id === mapping.sourceFieldId)?.parentId,
    )
      ? ["子表单选择数据只能填充来源主字段"]
      : []),
  ];
}
export function lookupMultiple(
  field: FormField,
  schema: FormSchema,
  values: FormValues,
  row?: FrontendFieldChange["row"],
): boolean {
  if (!row) return false;
  const current = (values[row.subformId] as FormValues[] | undefined)?.[
    row.index
  ];
  if (!current || idsOf(current[field.id]).length) return false;
  const scope = lookupScope(field, schema);
  return !field.reference.filters.some(
    (filter) =>
      filter.source === "field" &&
      filter.operator !== "notEmpty" &&
      scope.inputs.find((field) => field.id === filter.value)?.parentId,
  );
}
export function lookupDisplay(
  field: FormField,
  value: unknown,
  data: WorkspaceData,
) {
  const entry = data.entries.find(
    (entry) =>
      idsOf(value).includes(entry.id) &&
      entry.formId === field.referenceFormId &&
      !entry.deletedAt &&
      entry.status !== "draft",
  );
  const fields = selectionSourceFields(data, field.referenceFormId, "lookup");
  return (field.reference.displayColumns || []).flatMap((id) => {
    const source = fields.find((field) => field.id === id);
    let files: FileValue[] | undefined;
    if (source && ["file", "image"].includes(source.type)) {
      files = [];
      if (entry) {
        try {
          const value = selectionSourceValue(entry, source, data);
          // Source child columns may return one file list for each source row.
          files = Array.isArray(value) ? value.flat().filter(isFileValue) : [];
        } catch {
          // Masked, missing or incompatible source values remain unavailable.
        }
      }
    }
    return source
      ? [
          {
            id,
            label: source.pathLabel,
            text: entry ? selectionDisplayValue(source, entry, data) : "—",
            sourceField: source,
            files,
          },
        ]
      : [];
  });
}
export function applyLookupSelection(
  field: FormField,
  schema: FormSchema,
  values: FormValues,
  data: WorkspaceData,
  entryIds: string[],
  row?: FrontendFieldChange["row"],
): FormValues {
  const scope = lookupScope(field, schema),
    selection = lookupSelection(field, data);
  const issue = lookupIssues(field, schema, data)[0];
  if (issue) throw Error(issue);
  const current =
    row && Array.isArray(values[row.subformId])
      ? (values[row.subformId] as FormValues[])[row.index]
      : undefined;
  const trigger = frontendValueFields(schema).find(
    (item) => item.id === field.id,
  );
  if (
    selection.filters.some(
      (filter) =>
        filter.source === "field" &&
        filter.operator !== "notEmpty" &&
        !scope.inputs.some(
          (input) =>
            input.id === filter.value &&
            isFieldVisibleInSchema(input, schema, { ...values, ...current }),
        ),
    )
  )
    throw Error("当前无权读取数据过滤字段");
  if (
    !trigger?.editable ||
    !isFieldVisibleInSchema(trigger, schema, { ...values, ...current }) ||
    (row && (!current || scope.owner !== row.subformId))
  )
    throw Error("当前选择数据字段不可编辑");
  if (
    !entryIds.length ||
    new Set(entryIds).size !== entryIds.length ||
    (!lookupMultiple(field, schema, values, row) && entryIds.length !== 1)
  )
    throw Error("请按当前字段的选择范围重新选择数据");
  const next = copy(values);
  const fill = (entryId: string, local: FormValues) => {
    const run = runFrontendSelection(
      {
        ...selection,
        columns: [
          ...new Set([
            ...selection.columns,
            ...(field.reference.displayColumns || []),
          ]),
        ],
      },
      schema,
      local,
      data,
      scope.inputs,
      scope.outputs,
      entryId,
      row,
      "lookup",
    );
    if (run.status !== "success")
      throw Error(run.error?.message || "数据填充失败");
    let result = copy(local);
    const fields = row
      ? findField(schema.fields, row.subformId)!.children
      : schema.fields;
    for (const [id, value] of Object.entries(run.mappedValues))
      result = applyFieldChange(
        fields,
        result,
        id,
        value,
        data,
        row ? values : {},
        schema.fields,
      );
    result[field.id] = entryId;
    return result;
  };
  if (!row) return fill(entryIds[0]!, next);
  const parent = findField(schema.fields, row.subformId)!;
  const rows = copy(next[row.subformId] as FormValues[]);
  const rowIssue = subformRowCountIssue(
    parent,
    rows.length - 1 + entryIds.length,
    rows.length,
  );
  if (rowIssue) throw Error(rowIssue);
  // All selected rows are converted before a single parent-value update.
  const added = entryIds.map((entryId, index) => {
    const base =
      index === 0
        ? current!
        : runtimeDefaults(parent.children, data, values, schema.fields);
    const result = fill(entryId, { ...values, ...base });
    return Object.fromEntries(
      Object.keys(base)
        .concat(parent.children.map((field) => field.id))
        .map((id) => [id, result[id]])
        .filter(([, value]) => value !== undefined),
    );
  });
  rows.splice(row.index, 1, ...added);

  return applyFieldChange(schema.fields, next, parent.id, rows, data);
}
