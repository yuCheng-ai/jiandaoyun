import {
  identifySubformRows,
  hasFieldValue,
  isNumericField,
  subformRowLimitErrors,
} from "@platform/contracts";
import {
  copy,
  defaultValues,
  flattenFields,
  resolveCalculations,
  resolveFormValues,
  type FormField,
  type FormValues,
  type FieldOption,
  type FormSchema,
} from "./form";
import { formulaReferences, usesFormula } from "./formula";
import { richTextPlainText } from "./richText";
import { conditionValues, fieldConditionValues } from "./conditionValues";
import {
  defaultLinkTypes,
  linkTypesMatch,
  type DataFilter,
} from "./fieldConfig";
import {
  allowedEmployees,
  allowedDepartments,
  organizationDefault,
  identityLabel,
} from "./organization";
import type { WorkspaceData, FormEntry } from "./workspace";
import {
  coerceFrontendValue,
  mapFrontendScopeValues,
  frontendValueFields,
} from "./frontendEventValues";
import {
  selectionSourceFields,
  selectionSourceValue,
} from "./frontendSelections";
import {
  formatNumberValue,
  choiceValueLabel,
  choiceConditionValue,
  isChoiceTextValue,
  dateScopeFields,
  isFileValue,
  validDateValue,
  normalizeDateValue,
  addressText,
  addressParts,
  addressDefault,
  addressKeys,
  isLocationValue,
  locationText,
  isAddressValue,
} from "@platform/contracts";
export const relationTypes = ["query", "lookup", "relation", "relationTable"];
export const organizationTypes = [
  "member",
  "members",
  "department",
  "departments",
];
export const choiceTypes = ["radio", "checkbox", "select", "multiselect"];
/** Only currently active sources can invalidate a field's value. */
export function fieldInputDependencies(field: FormField): string[] {
  const filters = [
    ...(choiceTypes.includes(field.type) && field.choiceSource.mode === "form"
      ? field.choiceSource.filters
      : []),
    ...(relationTypes.includes(field.type) ? field.reference.filters : []),
    ...(field.defaultLink?.enabled ? field.defaultLink.filters : []),
  ];
  return [
    ...new Set([
      ...filters
        .filter((f) => f.source === "field" && f.operator !== "notEmpty")
        .map((f) => f.value),
      ...(organizationTypes.includes(field.type) &&
      field.organization.scope.mode === "fieldDepartment"
        ? [field.organization.scope.fieldId]
        : []),
      ...(field.location?.rangeEnabled && field.location.rangeMode === "field"
        ? [field.location.centerFieldId]
        : []),
      ...(usesFormula(field) ? formulaReferences(field.expression) : []),
    ]),
  ];
}
export function referenceDependencies(field: FormField) {
  const reference = {
    formId: field.referenceFormId,
    source: [
      field.referenceFieldId,
      field.reference.reverseFieldId,
      ...field.reference.columns,
      ...(field.reference.displayColumns || []),
      ...(field.reference.sort && !field.reference.sort.fieldId.startsWith("$")
        ? [field.reference.sort.fieldId]
        : []),
      ...field.reference.mappings.map((mapping) => mapping.sourceFieldId),
      ...field.reference.filters.map((filter) => filter.sourceFieldId),
    ].filter(Boolean),
    local: [
      ...field.reference.mappings.map((mapping) => mapping.targetFieldId),
      ...field.reference.filters
        .filter(
          (filter) =>
            filter.source === "field" && filter.operator !== "notEmpty",
        )
        .map((filter) => filter.value),
    ],
  };
  const choice = choiceTypes.includes(field.type) && field.choiceSource.mode === "form"
    ? field.choiceSource : undefined;
  const defaults = field.defaultLink;
  return {
    ...reference,
    local: [...new Set([
      ...reference.local,
      ...[...(choice?.filters || []), ...(defaults?.filters || [])]
        .filter(filter => filter.source === "field" && filter.operator !== "notEmpty")
        .map(filter => filter.value),
    ])],
    external: [
      { formId: reference.formId, fields: reference.source },
      ...(choice ? [{ formId: choice.formId, fields: [choice.labelFieldId, choice.valueFieldId, ...choice.filters.map(filter => filter.sourceFieldId)] }] : []),
      ...(defaults ? [{ formId: defaults.formId, fields: [defaults.fieldId, ...defaults.filters.map(filter => filter.sourceFieldId)] }] : []),
      ...(field.choiceConversion?.sources || []).map(source => ({ formId: source.formId, fields: [source.labelFieldId, source.valueFieldId] })),
    ].filter(source => source.formId).map(source => ({ ...source, fields: [...new Set(source.fields.filter(Boolean))] })),
  };
}
export function idsOf(value: unknown): string[] {
  value = choiceConditionValue(value);
  if (isLocationValue(value))
    return [JSON.stringify([value.coordinateSystem, value.lng, value.lat])];
  if (isAddressValue(value))
    return addressText(value)
      ? [JSON.stringify(addressKeys.map((key) => value[key]?.trim() || ""))]
      : [];
  return Array.isArray(value)
    ? value.map(String)
    : value === undefined || value === null || value === ""
      ? []
      : [String(value)];
}
export function sourceFields(data: WorkspaceData, formId: string): FormField[] {
  const form = data.forms.find((f) => f.id === formId && !f.archived);
  return form ? scopeFields(form.schema.fields).filter(hasFieldValue) : [];
}
/** Fields sharing a value object. Subform children have their own row scope. */
// Input acceptance also honors the permissions of flattened tab containers.
export function scopeFields(
  fields: FormField[],
  inheritPermissions = false,
): FormField[] {
  return fields.flatMap((f) =>
    f.type === "tabs"
      ? scopeFields(
          inheritPermissions
            ? f.children.map((child) => ({
                ...child,
                visible: f.visible && child.visible,
                editable: f.editable && child.editable,
              }))
            : f.children,
          inheritPermissions,
        )
      : [f],
  );
}
function text(value: unknown): string {
  if (isChoiceTextValue(value)) return value.text || "其他";
  return value == null
    ? ""
    : typeof value === "object"
      ? Array.isArray(value)
        ? value.map(text).join("、")
        : Object.values(value).map(text).filter(Boolean).join(" ")
      : String(value);
}
export function displayValue(
  field: FormField | undefined,
  value: unknown,
  data: WorkspaceData,
  depth = 0,
): string {
  if (field?.type === "richtext")
    return typeof value === "string" ? richTextPlainText(value) : "";
  if (value == null || value === "") return "—";
  if (!field) return text(value);
  if (field.type === "location")
    return locationText(value, field.location?.showCoordinates) || "—";
  if (field.type === "address")
    return addressText(value, "", addressParts(field)) || "—";
  if (isNumericField(field)) return formatNumberValue(field, value);
  if (organizationTypes.includes(field.type))
    return (
      idsOf(value)
        .map((id) => identityLabel(data.organization, id))
        .join("、") || "—"
    );
  if (choiceTypes.includes(field.type)) {
    const options = resolveChoices(
      { ...field, choiceSource: { ...field.choiceSource, filters: [] } },
      data,
      {},
    );
    return (
      (Array.isArray(value) ? value : [value])
        .map((item) => choiceValueLabel(options, item))
        .join("、") || "—"
    );
  }
  if (relationTypes.includes(field.type) && depth < 2)
    return (
      idsOf(value)
        .map((id) => {
          const entry = data.entries.find(
            (e) =>
              e.id === id && e.formId === field.referenceFormId && !e.deletedAt,
          );
          return entry
            ? recordLabel(field, entry, data, depth + 1)
            : "记录已移除";
        })
        .join("、") || "—"
    );
  if (field.type === "signature") return value ? "已签名" : "—";
  if (field.type === "file" || field.type === "image")
    return Array.isArray(value)
      ? value.map((f) => f?.name || "文件").join("、")
      : "—";
  if (field.type === "subform")
    return Array.isArray(value) ? `${value.length} 行明细` : "—";
  return text(value) || "—";
}
export function recordFilterFields(data: WorkspaceData, entry: FormEntry): FormField[] {
  const form = data.forms.find(form => form.id === entry.formId);
  const definition = form?.versions.find(version => version.version === entry.definitionVersion) ||
    (form?.published?.version === entry.definitionVersion ? form.published : undefined);
  return definition ? flattenFields(definition.schema.fields) : [];
}

/** Resolve an old choice identity from permitted runtime data, never from a
 * snapshot of source records embedded in the field definition. */
export function resolveConditionOption(field: FormField, id: unknown, data: WorkspaceData): FieldOption | undefined {
  if (typeof id !== "string") return;
  const sources = choiceTypes.includes(field.type) && field.choiceSource.mode === "form"
    ? [field.choiceSource]
    : field.choiceConversion?.sources || [];
  const matches = sources.flatMap(source => resolveChoices({
    ...field,
    choiceSource: { ...source, mode: "form", filters: [], sort: "none", deduplicate: false },
  }, data, {}).filter(option => option.id === id));
  if (!matches.length || new Set(matches.map(option => option.label)).size !== 1) return;
  return matches[0];
}

export function matchesFilters(
  filters: DataFilter[],
  record: FormValues,
  values: FormValues,
  data: WorkspaceData,
  match: "all" | "any" = "all",
  fields: FormField[] = [],
  recordFields: FormField[] = fields,
  inputFields: FormField[] = recordFields,
): boolean {
  const test = (f: DataFilter) => {
    const field = fields.find((field) => field.id === f.sourceFieldId);
    if (fields.length && (!field || !hasFieldValue(field))) return false;
    let actual = choiceConditionValue(record[f.sourceFieldId]);
    if (!f.sourceFieldId) return false;
    if (f.operator === "notEmpty") return idsOf(actual).length > 0;
    const current = data.organization.employees.find(
      (e) => e.id === data.organization.currentUserId,
    );
    let expected = choiceConditionValue(
      f.source === "field"
        ? values[f.value]
        : f.source === "currentUser"
          ? current?.id
          : f.source === "currentDepartment"
            ? current?.primaryDepartmentId
            : f.value,
    );
    if (f.source !== "constant" && !idsOf(expected).length) return false;
    if (f.source === "constant") {
      const pair = conditionValues(field, recordFields.find(item => item.id === f.sourceFieldId), record[f.sourceFieldId], f.value, f.valueType,
        (field, id) => resolveConditionOption(field, id, data));
      if (!pair) return false;
      actual = pair.actual;
      expected = pair.expected;
    }
    if (f.source === "field") {
      const original = recordFields.find(item => item.id === f.sourceFieldId);
      if (field && !original) return false;
      const pair = fieldConditionValues(
        original,
        flattenFields(inputFields).find(item => item.id === f.value),
        record[f.sourceFieldId], values[f.value],
        field => resolveChoices({ ...field, choiceSource: { ...field.choiceSource, filters: [] } }, data, {}),
      );
      if (!pair) return false;
      actual = pair.actual;
      expected = pair.expected;
    }
    if (isLocationValue(actual) || isLocationValue(expected)) {
      if (!isLocationValue(actual)) return false;
      if (f.operator === "contains" && typeof expected === "string")
        return locationText(actual).includes(expected);
      if (
        !isLocationValue(expected) ||
        !["equals", "notEquals"].includes(f.operator)
      )
        return false;
      const same =
        actual.coordinateSystem === expected.coordinateSystem &&
        actual.lng === expected.lng &&
        actual.lat === expected.lat;
      return f.operator === "equals" ? same : !same;
    }
    if (
      field?.type === "address" ||
      isAddressValue(actual) ||
      isAddressValue(expected)
    ) {
      if (
        !isAddressValue(actual) ||
        !isAddressValue(expected) ||
        !["equals", "notEquals"].includes(f.operator)
      )
        return false;
    }
    if (
      field?.type === "datetime" &&
      ["equals", "notEquals", "greater", "less"].includes(f.operator)
    ) {
      if (
        !validDateValue(field.format, actual) ||
        !validDateValue(field.format, expected)
      )
        return false;
      const a = normalizeDateValue(field.format, actual),
        b = normalizeDateValue(field.format, expected);
      return f.operator === "equals"
        ? a === b
        : f.operator === "notEquals"
          ? a !== b
          : f.operator === "greater"
            ? a > b
            : a < b;
    }
    if (
      field &&
      isNumericField(field) &&
      ["equals", "notEquals", "greater", "less"].includes(f.operator)
    ) {
      if (
        actual == null ||
        actual === "" ||
        expected == null ||
        expected === "" ||
        !Number.isFinite(Number(actual)) ||
        !Number.isFinite(Number(expected))
      )
        return false;
      actual = Number(actual);
      expected = Number(expected);
    }
    const a = idsOf(actual),
      b = idsOf(expected);
    const same = a.some((v) => b.includes(v));
    if (f.operator === "equals") return same;
    if (f.operator === "notEquals") return !same;
    if (f.operator === "contains")
      return Array.isArray(actual)
        ? same
        : text(actual).includes(text(expected));
    const n = Number(actual),
      m = Number(expected);
    return (
      actual !== "" &&
      expected !== "" &&
      Number.isFinite(n) &&
      Number.isFinite(m) &&
      (f.operator === "greater" ? n > m : n < m)
    );
  };
  return (
    !filters.length ||
    (match === "any" ? filters.some(test) : filters.every(test))
  );
}
export function sourceEntries(data: WorkspaceData, formId: string) {
  return data.forms.some((f) => f.id === formId && !f.archived)
    ? data.entries.filter(
        (e) => e.formId === formId && e.status !== "draft" && !e.deletedAt,
      )
    : [];
}
/** Root values and the selected subform row are available; sibling rows are not. */
export function defaultLinkLocalFields(
  fields: FormField[],
  id: string,
): ReturnType<typeof frontendValueFields> {
  const available = new Set(
    [...scopeFields(fields), ...dateScopeFields(fields, id)].map((f) => f.id),
  );
  return frontendValueFields({ fields }).filter(
    (f) => f.id !== id && available.has(f.id),
  );
}
export function defaultLinkSourceFields(
  data: WorkspaceData,
  formId: string,
): FormField[] {
  const form = data.forms.find((f) => f.id === formId && !f.archived);
  return form
    ? scopeFields((form.published?.schema || form.schema).fields).filter(
        hasFieldValue,
      )
    : [];
}
/** Uses only records/values present in the caller's permitted runtime context. */
export function linkedDefault(
  field: FormField,
  data: WorkspaceData,
  values: FormValues,
  allFields: FormField[] = [field],
): unknown {
  const config = field.defaultLink;
  const empty = ["file", "image", "subform"].includes(field.type) ? [] : "";
  if (!config?.enabled || !defaultLinkTypes.includes(field.type)) return empty;
  const form = data.forms.find((f) => f.id === config.formId && !f.archived);
  const fields = defaultLinkSourceFields(data, config.formId);
  const source = fields.find((f) => f.id === config.fieldId);
  if (!form?.published || !source || !linkTypesMatch(field, source))
    return empty;
  if (
    config.filters.some(
      (filter) => !fields.some((field) => field.id === filter.sourceFieldId),
    )
  )
    return empty;
  const matches = sourceEntries(data, config.formId)
    .map((entry) => {
      const definition =
        form.versions.find((v) => v.version === entry.definitionVersion) ||
        (form.published?.version === entry.definitionVersion
          ? form.published
          : undefined);
      const original =
        definition &&
        scopeFields(definition.schema.fields).find(
          (f) => f.id === config.fieldId,
        );
      return { entry, original, recordFields: definition ? flattenFields(definition.schema.fields) : [] };
    })
    .filter(
      ({ entry, original, recordFields }) =>
        original &&
        linkTypesMatch(field, original) &&
        Object.hasOwn(entry.values, config.fieldId) &&
        config.filters.every((f) =>
          Object.hasOwn(entry.values, f.sourceFieldId),
        ) &&
        matchesFilters(
          config.filters,
          entry.values,
          values,
          data,
          config.match,
          fields,
          recordFields,
          allFields,
        ),
    )
    .sort(
      (a, b) =>
        Date.parse(a.entry.createdAt) - Date.parse(b.entry.createdAt) ||
        a.entry.id.localeCompare(b.entry.id),
    );
  const first = matches[0],
    result = first?.entry.values[config.fieldId];
  if (field.type === "subform") {
    if (!first || !Array.isArray(result) || !config.mappings?.length) return [];
    try {
      const columns = config.mappings.map((mapping) => {
        const target = field.children.find(
          (child) => child.id === mapping.targetFieldId,
        );
        const from = source.children.find(
          (child) => child.id === mapping.sourceFieldId,
        );
        if (!target || !from || !linkTypesMatch(target, from))
          throw Error("子字段对应已失效");
        const values = selectionSourceValue(
          first.entry,
          {
            ...from,
            parentId: source.id,
            pathLabel: `${source.label} / ${from.label}`,
          },
          data,
          true,
        );
        if (!Array.isArray(values) || values.length !== result.length)
          throw Error("来源明细不可读取");
        return { target, values };
      });
      return result.map((_, index) => {
        const row: FormValues = Object.fromEntries(
          field.children.map((child) => [
            child.id,
            coerceFrontendValue(child, null, data, values),
          ]),
        );
        const mapped = mapFrontendScopeValues(
          columns.map((column) => ({
            field: column.target,
            value: column.values[index] ?? null,
          })),
          row,
          field.children,
          data,
          values,
          allFields,
        ).current;
        // Whole rows are filled first; their child defaults run on the completed row.
        return initializeLinkedDefaults(
          field.children,
          mapped,
          data,
          values,
          allFields,
        );
      });
    } catch {
      // Unreadable or incompatible source values cannot become a partial row.
      return [];
    }
  }
  if (["file", "image"].includes(field.type))
    return Array.isArray(result) && result.every(isFileValue)
      ? copy(result)
      : empty;
  if (field.type === "number")
    return typeof result === "number" && Number.isFinite(result)
      ? result
      : empty;
  if (field.type === "datetime")
    return validDateValue(field.format, result) ? result : empty;
  if (field.type === "location")
    return isLocationValue(result)
      ? copy(result)
      : !field.location && typeof result === "string"
        ? result
        : empty;
  if (field.type === "address")
    return first?.original && isAddressValue(result)
      ? addressDefault({
          ...field,
          defaultValue: addressDefault({
            ...first.original,
            defaultValue: result,
          }),
        })
      : empty;
  if (first?.original && ["radio", "select"].includes(first.original.type))
    return choiceValueLabel(
      resolveChoices(first.original, data, first.entry.values, first.recordFields),
      result,
    );
  return typeof result === "string" ? result : empty;
}
export function resolveChoices(
  field: FormField,
  data: WorkspaceData,
  values: FormValues,
  inputFields: FormField[] = [],
): FieldOption[] {
  const config = field.choiceSource;
  if (config.mode === "manual") return field.options;
  const fields = sourceFields(data, config.formId);
  if (
    [
      config.labelFieldId,
      config.valueFieldId,
      ...config.filters.map((f) => f.sourceFieldId),
    ]
      .filter(Boolean)
      .some((id) => !fields.some((f) => f.id === id))
  )
    return [];
  let options = sourceEntries(data, config.formId)
    .filter(e => [config.labelFieldId, config.valueFieldId].filter(Boolean).every(id =>
      Object.hasOwn(e.values, id) && (!e.readableFieldIds || e.readableFieldIds.includes(id)),
    ))
    .filter((e) =>
      matchesFilters(config.filters, e.values, values, data, "all", fields, recordFilterFields(data, e), inputFields),
    )
    .map((e) => ({
      id: config.valueFieldId
        ? text(choiceConditionValue(e.values[config.valueFieldId]))
        : e.id,
      label: text(e.values[config.labelFieldId]) || e.id,
    }))
    .filter((o) => o.id !== "");
  const seen = new Set<string>(),
    seenIds = new Set<string>();
  options = options.filter((o) => {
    const key = config.deduplicate ? o.label : o.id;
    if (seen.has(key) || seenIds.has(o.id)) return false;
    seen.add(key);
    seenIds.add(o.id);
    return true;
  });
  if (config.sort !== "none")
    options.sort(
      (a, b) =>
        a.label.localeCompare(b.label, "zh-CN") *
        (config.sort === "asc" ? 1 : -1),
    );
  return options;
}
export function relationCandidates(
  field: FormField,
  data: WorkspaceData,
  values: FormValues,
  entryId = "",
  inputFields: FormField[] = [],
): FormEntry[] {
  const fields =
    field.type === "lookup"
      ? selectionSourceFields(data, field.referenceFormId, "lookup")
      : sourceFields(data, field.referenceFormId);
  if (
    referenceDependencies(field).source.some(
      (id) => !fields.some((f) => f.id === id),
    )
  )
    return [];
  let rows = sourceEntries(data, field.referenceFormId);
  if (field.reference.mode === "reverse")
    rows =
      entryId && field.reference.reverseFieldId
        ? rows.filter((e) =>
            idsOf(e.values[field.reference.reverseFieldId]).includes(entryId),
          )
        : [];
  return rows.filter((e) =>
    matchesFilters(
      field.reference.filters,
      e.values,
      values,
      data,
      field.reference.match,
      fields,
      recordFilterFields(data, e),
      inputFields,
    ),
  );
}
export function recordLabel(
  field: FormField,
  entry: FormEntry,
  data: WorkspaceData,
  depth = 0,
) {
  const fields = sourceFields(data, field.referenceFormId);
  const display =
    fields.find((f) => f.id === field.referenceFieldId) ||
    fields.find((f) => !["tabs", "divider", "subform"].includes(f.type));
  return display
    ? displayValue(display, entry.values[display.id], data, depth)
    : entry.id;
}
export function runtimeDefaults(
  fields: FormField[],
  data: WorkspaceData,
  context: FormValues = {},
  allFields: FormField[] = fields,
): FormValues {
  const values = defaultValues(fields);
  const organizationFields = scopeFields(fields).filter((f) =>
    organizationTypes.includes(f.type),
  );
  const done = new Set<string>(),
    resolving = new Set<string>();
  function resolve(f: FormField) {
    if (done.has(f.id) || resolving.has(f.id)) return;
    resolving.add(f.id);
    if (f.organization.scope.mode === "fieldDepartment") {
      const parent = organizationFields.find(
        (p) => p.id === f.organization.scope.fieldId,
      );
      if (parent) resolve(parent);
    }
    values[f.id] = organizationDefault(
      data.organization,
      f.organization,
      f.type.startsWith("department") ? "department" : "member",
      ["members", "departments"].includes(f.type),
      { ...context, ...values },
    );
    resolving.delete(f.id);
    done.add(f.id);
  }
  organizationFields.forEach(resolve);
  for (const field of scopeFields(fields).filter(
    (field) => field.type === "subform" && !field.defaultLink?.enabled,
  ))
    values[field.id] = (field.defaultRows || []).map((row) => ({
      ...runtimeDefaults(
        field.children,
        data,
        { ...context, ...values },
        allFields,
      ),
      ...Object.fromEntries(
        field.children
          .filter((child) => Object.hasOwn(row, child.id))
          .map((child) => [child.id, copy(row[child.id])]),
      ),
    }));
  let result = resolveCalculations(fields, values, context, {
    defaults: flattenFields(fields)
      .filter(usesFormula)
      .map((f) => f.id),
    fields: allFields,
    choices: (f, input) => resolveChoices(f, data, input, allFields),
  });
  return initializeLinkedDefaults(fields, result, data, context, allFields);
}
function initializeLinkedDefaults(
  fields: FormField[],
  values: FormValues,
  data: WorkspaceData,
  context: FormValues = {},
  allFields: FormField[] = fields,
): FormValues {
  let result = values;
  for (const field of scopeFields(fields).filter((f) => f.defaultLink?.enabled))
    result = applyFieldChange(
      fields,
      result,
      field.id,
      linkedDefault(field, data, { ...context, ...result }, allFields),
      data,
      context,
      allFields,
      false,
    );
  return result;
}
export function resolveRuntimeValues(
  schema: FormSchema,
  values: FormValues,
  data: WorkspaceData,
  original?: FormValues,
): FormValues {
  return resolveFormValues(schema, values, original, {
    choices: (field, context) => resolveChoices(field, data, context, schema.fields),
    defaultValue: (field, context) =>
      field.defaultLink?.enabled
        ? linkedDefault(field, data, context, schema.fields)
        : organizationTypes.includes(field.type)
          ? organizationDefault(
              data.organization,
              field.organization,
              field.type.startsWith("department") ? "department" : "member",
              ["members", "departments"].includes(field.type),
              context,
            )
          : defaultValues([field])[field.id],
  });
}
function assignMappings(
  field: FormField,
  record: FormEntry | undefined,
  result: FormValues,
  fields: FormField[],
  data: WorkspaceData,
) {
  const available = new Map(scopeFields(fields).map((f) => [f.id, f]));
  const form = data.forms.find((f) => f.id === record?.formId);
  const definition =
    form?.versions.find((v) => v.version === record?.definitionVersion) ||
    (form?.published && form.published.version === record?.definitionVersion
      ? form.published
      : undefined);
  const source = scopeFields(
    definition?.schema.fields || form?.schema.fields || [],
  );
  for (const m of field.reference.mappings) {
    const target = available.get(m.targetFieldId);
    const original = source.find((f) => f.id === m.sourceFieldId);
    if (
      !target ||
      !hasFieldValue(target) ||
      (original && !hasFieldValue(original)) ||
      target.id === field.id ||
      ["calculated", "serial"].includes(target.type)
    )
      continue;
    result[target.id] =
      record && record.values[m.sourceFieldId] !== undefined
        ? copy(record.values[m.sourceFieldId])
        : defaultValues([target])[target.id];
  }
}
/** Generated initial rows stay distinct from rows entered by the person filling the form. */
export function subformFillingBaseline(
  fields: FormField[],
  data: WorkspaceData,
  values: FormValues,
): FormValues {
  const result = copy(values);
  for (const field of scopeFields(fields).filter(
    (field) => field.type === "subform",
  ))
    result[field.id] = runtimeDefaults([field], data, values, fields)[field.id];
  return identifySubformRows(fields, result);
}
/** Apply selection mapping and clear only dependent values that are no longer eligible. */
export function applyFieldChange(
  fields: FormField[],
  values: FormValues,
  id: string,
  value: unknown,
  data: WorkspaceData,
  root: FormValues = {},
  allFields: FormField[] = fields,
  checkRowLimits = true,
): FormValues {
  const result = copy({ ...values, [id]: value });
  const list = scopeFields(fields);
  const changed = list.find((f) => f.id === id);
  if (changed && !hasFieldValue(changed)) return copy(values);
  if (
    changed &&
    relationTypes.includes(changed.type) &&
    !["relationTable", "lookup"].includes(changed.type)
  )
    assignMappings(
      changed,
      data.entries.find(
        (e) =>
          e.id === value &&
          e.formId === changed.referenceFormId &&
          !e.deletedAt,
      ),
      result,
      fields,
      data,
    );
  const affected = new Set<string>([
    id,
    ...(changed?.type === "subform"
      ? flattenFields(changed.children).map((f) => f.id)
      : []),
    ...(changed?.reference.mappings.map((m) => m.targetFieldId) || []),
  ]);
  for (let pass = 0; pass < list.length + 1; pass++) {
    let any = false;
    const calculated = resolveCalculations(fields, result, root, {
      defaults: list
        .filter(
          (f) =>
            f.defaultFormula &&
            formulaReferences(f.expression).some((dep) => affected.has(dep)),
        )
        .map((f) => f.id),
      fields: allFields,
      choices: (f, input) => resolveChoices(f, data, input, allFields),
    });
    for (const field of list.filter(usesFormula))
      if (
        JSON.stringify(calculated[field.id]) !==
        JSON.stringify(result[field.id])
      ) {
        affected.add(field.id);
        any = true;
      }
    Object.assign(result, calculated);
    for (const field of list) {
      if (field.id === id) continue;
      const deps = fieldInputDependencies(field);
      if (!deps.some((dep) => affected.has(dep))) continue;
      const context = { ...root, ...result };
      if (field.defaultLink?.enabled) {
        const next = linkedDefault(field, data, context, allFields);
        if (JSON.stringify(next) !== JSON.stringify(result[field.id])) {
          result[field.id] = next;
          affected.add(field.id);
          if (field.type === "subform")
            flattenFields(field.children).forEach((child) =>
              affected.add(child.id),
            );
          any = true;
        }
        continue;
      }
      let allowed: string[] | undefined;
      if (
        choiceTypes.includes(field.type) &&
        field.choiceSource.mode === "form"
      )
        allowed = resolveChoices(field, data, context, allFields).map((o) => o.id);
      if (
        relationTypes.includes(field.type) &&
        field.reference.mode === "forward"
      )
        allowed = relationCandidates(field, data, context, "", allFields).map((e) => e.id);
      if (organizationTypes.includes(field.type))
        allowed = (
          field.type.startsWith("department")
            ? allowedDepartments(
                data.organization,
                field.organization.scope,
                context,
              )
            : allowedEmployees(
                data.organization,
                field.organization.scope,
                context,
              )
        ).map((i) => i.id);
      if (!allowed) continue;
      const current = idsOf(result[field.id]);
      const next = current.filter((v) => allowed!.includes(v));
      if (next.length === current.length) continue;
      result[field.id] = Array.isArray(result[field.id]) ? next : next[0] || "";
      affected.add(field.id);
      any = true;
      if (
        relationTypes.includes(field.type) &&
        !["relationTable", "lookup"].includes(field.type)
      ) {
        assignMappings(field, undefined, result, fields, data);
        field.reference.mappings.forEach((m) => affected.add(m.targetFieldId));
      }
    }
    if (!any) break;
  }
  // Reevaluate row-scoped dependencies when a parent value changes.
  for (const field of list.filter((f) => f.type === "subform"))
    if (Array.isArray(result[field.id]) && field.id !== id) {
      const original = JSON.stringify(result[field.id]);
      result[field.id] = (result[field.id] as FormValues[]).map((row) => {
        let updated = row;
        const localIds = new Set(scopeFields(field.children).map((f) => f.id));
        for (const dependency of affected) {
          updated = applyFieldChange(
            field.children,
            updated,
            dependency,
            localIds.has(dependency) ? updated[dependency] : result[dependency],
            data,
            { ...root, ...result },
            allFields,
          );
          if (!localIds.has(dependency)) delete updated[dependency];
        }
        return updated;
      });
      if (original !== JSON.stringify(result[field.id])) {
        Object.assign(
          result,
          applyFieldChange(
            fields,
            result,
            field.id,
            result[field.id],
            data,
            root,
            allFields,
          ),
        );
      }
    }
  const resolved = resolveCalculations(fields, result, root, {
    fields: allFields,
    choices: (f, input) => resolveChoices(f, data, input, allFields),
  });
  const issue =
    checkRowLimits && subformRowLimitErrors(fields, resolved, values)[0];
  if (issue) throw Error(issue.message);
  return resolved;
}
