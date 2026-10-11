import {
  validDateValue,
  choiceValueLabel,
  choiceValueIssue,
  emptyFieldValue,
  addressParts,
  addressText,
  isAddressValue,
  subformRowLimitErrors,
  type AddressValue,
} from "@platform/contracts";
import {
  copy,
  validateValues,
  type FormField,
  type FormValues,
  type FormSchema,
} from "./form";
import { scopeFields, resolveChoices, sourceEntries, idsOf } from "./relations";
import { entryDefinition, entryTitle } from "./collaboration";
import { allowedEmployees, allowedDepartments } from "./organization";
import type { FormEntry, FormRecord, WorkspaceData } from "./workspace";
import type { ExcelValue, ExcelSheet, ExcelMerge } from "../services/excel";
import type { RecordBatchSelection } from "./recordBatch";
import {
  creationSchema,
  eligibleGroups,
  groupsForEntry,
  memberSchema,
  memberContext,
} from "./access";

export type MemberImportScope = { actorId: string; selection: string };

export type ImportMode = "create" | "update" | "both";
export type ImportMapping = {
  column: number;
  fieldId: string;
  type: FormField["type"] | "data_id";
  parentId?: string;
  matchFieldId?: string;
  addressPart?: keyof AddressValue;
};
export type RecordImportRequest = {
  mode: ImportMode;
  definitionVersion: number;
  rows: ExcelValue[][];
  firstRow: number;
  mapping: ImportMapping[];
  validate: boolean;
  triggerWorkflow: boolean;
  targets: RecordBatchSelection[];
  merges?: ExcelMerge[];
  member?: MemberImportScope;
  /** Original data-row offsets; a retry never includes previously accepted groups. */
  onlyRows?: number[];
};
export type ImportRow = {
  row: number;
  lastRow?: number;
  kind: "create" | "update" | "skip" | "error";
  id?: string;
  values?: FormValues;
  message?: string;
  warnings: string[];
  issues?: { fieldId: string; row: number; message: string }[];
};
export type ImportResult = {
  created: number;
  updated: number;
  rows: ImportRow[];
};
const types = [
  "text",
  "textarea",
  "number",
  "datetime",
  "phone",
  "serial",
  "radio",
  "select",
  "checkbox",
  "multiselect",
  "member",
  "members",
  "department",
  "departments",
  "relation",
  "address",
];
const orgTypes = ["member", "members", "department", "departments"];
const multiple = ["checkbox", "multiselect", "members", "departments"];
const relationMatchTypes = ["text", "select", "radio", "serial", "phone"];
const canImportField = (field: FormField) =>
  types.includes(field.type) &&
  !(field.type === "relation" && field.reference.mode === "reverse");
export const importFieldKey = (fieldId: string, part?: keyof AddressValue) =>
  part ? `${fieldId}.${part}` : fieldId;
const addressLabels = {
  province: "省/自治区/直辖市",
  city: "市",
  district: "县/区",
  detail: "详细地址",
};
export type ImportColumn = {
  field: FormField;
  parent?: FormField;
  label: string;
  addressPart?: keyof AddressValue;
};
function fieldColumns(field: FormField, parent?: FormField): ImportColumn[] {
  const label = parent ? `${parent.label} · ${field.label}` : field.label;
  return field.type === "address"
    ? addressParts(field).map((addressPart) => ({
        field,
        parent,
        addressPart,
        label: `${label}（${addressLabels[addressPart]}）`,
      }))
    : [{ field, parent, label }];
}
/** Relation imports choose a scalar key from the published main table. */
export function importRelationFields(
  field: FormField,
  data: WorkspaceData,
  actor?: string,
) {
  const source = data.forms.find(
    (form) => form.id === field.referenceFormId && !form.archived,
  );
  const schema =
    source?.published &&
    (actor
      ? memberSchema(
          source.published.schema,
          eligibleGroups(data, source.id, actor, "").filter((g) =>
            g.actions.includes("view"),
          ),
        )
      : source.published.schema);
  return schema
    ? scopeFields(schema.fields).filter(
        (f) => relationMatchTypes.includes(f.type) && (!actor || f.visible),
      )
    : [];
}
export function recordImportColumns(schema: FormSchema) {
  return scopeFields(schema.fields).flatMap<ImportColumn>((field) =>
    field.type === "subform"
      ? scopeFields(field.children)
          .filter(
            (child) =>
              canImportField(child) &&
              !["serial", "relation"].includes(child.type),
          )
          .flatMap((child) => fieldColumns(child, field))
      : canImportField(field)
        ? fieldColumns(field)
        : [],
  );
}

/** Import is its own action. Updating requires edit in that same single group. */
export function recordImportModes(
  form: FormRecord,
  data: WorkspaceData,
  member?: MemberImportScope,
): ImportMode[] {
  if (!member) return ["create", "update", "both"];
  const groups = eligibleGroups(
    data,
    form.id,
    member.actorId,
    member.selection,
  ).filter((g) => g.actions.includes("import"));
  if (!groups.length) return [];
  return [
    "create",
    ...(!["*", ""].includes(member.selection) &&
    groups.length === 1 &&
    groups[0]!.actions.includes("edit")
      ? ["update" as const]
      : []),
  ];
}
export function memberImportColumns(
  form: FormRecord,
  mode: ImportMode,
  data: WorkspaceData,
  member?: MemberImportScope,
  original = form.published!.schema,
) {
  if (!member) return recordImportColumns(original);
  const schema =
    mode === "create"
      ? creationSchema(form)
      : memberSchema(
          original,
          eligibleGroups(
            data,
            form.id,
            member.actorId,
            member.selection,
          ).filter(
            (g) => g.actions.includes("import") && g.actions.includes("edit"),
          ),
          true,
        );
  // Prune containers before flattening tabs, so a hidden/read-only parent cannot expose children.
  const writable = (fields: FormField[]): FormField[] =>
    fields
      .filter(
        (f) =>
          f.visible &&
          (f.editable || (mode === "create" && f.type === "serial")),
      )
      .map((f) => ({ ...f, children: writable(f.children) }));
  return recordImportColumns({ ...schema, fields: writable(schema.fields) });
}
export function importExcelLayout(
  columns: ReturnType<typeof recordImportColumns>,
  extraHeaders: string[] = [],
  extraIds: string[] = [],
) {
  if (columns.length + extraHeaders.length > 500)
    throw Error("模板超过500列，请减少导出字段后重试");
  const detailed = columns.some((c) => c.parent);
  const top: ExcelValue[] = [
    ...extraHeaders,
    ...columns.map((c) => c.parent?.label || c.label),
  ];
  const headers = detailed
    ? [
        top,
        [
          ...extraHeaders.map(() => null),
          ...columns.map((c) =>
            c.parent ? c.label.slice(c.parent.label.length + 3) : null,
          ),
        ],
      ]
    : [top];
  const merges: ExcelMerge[] = [];
  if (detailed) {
    for (let c = 0; c < extraHeaders.length; c++)
      merges.push({ s: { r: 0, c }, e: { r: 1, c } });
    for (let i = 0; i < columns.length;) {
      const c = i + extraHeaders.length,
        parent = columns[i]!.parent;
      if (!parent) {
        merges.push({ s: { r: 0, c }, e: { r: 1, c } });
        i++;
        continue;
      }
      let end = i;
      while (columns[end + 1]?.parent?.id === parent.id) end++;
      if (end > i)
        merges.push({
          s: { r: 0, c },
          e: { r: 0, c: end + extraHeaders.length },
        });
      for (let child = i + 1; child <= end; child++)
        top[child + extraHeaders.length] = null;
      i = end + 1;
    }
  }
  return {
    headers,
    fieldIds: [
      ...extraIds,
      ...columns.map((c) => importFieldKey(c.field.id, c.addressPart)),
    ],
    merges,
  };
}
/** The source template has two visible header rows when subforms are present. */
export function importHeaderRows(sheet: ExcelSheet, header: number) {
  return sheet.merges?.some(
    (m) =>
      m.s.r === header &&
      ((m.e.r === header + 1 && m.s.c === m.e.c) ||
        (m.e.r === header && m.e.c > m.s.c)),
  )
    ? 2
    : 1;
}
export function importHeaders(sheet: ExcelSheet, header: number): ExcelValue[] {
  if (importHeaderRows(sheet, header) === 1) return sheet.rows[header] || [];
  return (sheet.rows[header] || []).map((title, c) => {
    const merge = sheet.merges?.find(
      (m) => m.s.r === header && m.s.c <= c && m.e.c >= c,
    );
    const parent = merge ? sheet.rows[header]?.[merge.s.c] : title;
    const child = sheet.rows[header + 1]?.[c];
    return child ? `${parent ? `${parent} · ` : ""}${child}` : (parent ?? null);
  });
}
/** Some Excel converters lose row visibility. Recognize only exact owned field IDs. */
export function recognizeImportTemplate(
  sheet: ExcelSheet,
  schema: FormSchema,
): ExcelSheet {
  if (sheet.fieldIds || sheet.rows.length < 2) return sheet;
  const ids = new Set(
    recordImportColumns(schema).map((c) =>
      importFieldKey(c.field.id, c.addressPart),
    ),
  );
  return sheet.rows[0]!.some(
    (value) => typeof value === "string" && ids.has(value),
  )
    ? {
        ...sheet,
        headerRow: 1,
        fieldIds: sheet.rows[0]!.map((value) => String(value ?? "")),
      }
    : sheet;
}
export function suggestImportMapping(
  sheet: ExcelSheet,
  header: number,
  schema: FormSchema,
): string[] {
  const columns = recordImportColumns(schema);
  const keys = columns.map((c) => importFieldKey(c.field.id, c.addressPart));
  const used = new Set<string>();
  return importHeaders(sheet, header).map((title, index) => {
    let id = "";
    if (sheet.fieldIds && header === sheet.headerRow) {
      const source = sheet.fieldIds[index];
      id = source === "data_id" || keys.includes(source || "") ? source! : "";
    } else if (String(title ?? "").trim() === "data_id") id = "data_id";
    else {
      const exact = columns.filter(
        (c) => c.label === String(title ?? "").trim(),
      );
      const matched = exact.length
        ? exact
        : columns.filter(
            (c) =>
              !c.addressPart && c.field.label === String(title ?? "").trim(),
          );
      if (matched.length === 1)
        id = importFieldKey(matched[0]!.field.id, matched[0]!.addressPart);
    }
    if (used.has(id)) return "";
    if (id) used.add(id);
    return id;
  });
}
/** A main-cell merge defines one record; blank cells never imply grouping. */
function importGroups(
  request: RecordImportRequest,
  columns: ReturnType<typeof recordImportColumns>,
) {
  const spans = new Map<number, number>();
  for (const m of request.merges || []) {
    if (
      ![m.s.r, m.e.r, m.s.c, m.e.c].every(Number.isInteger) ||
      m.s.r < 0 ||
      m.e.r >= request.rows.length ||
      m.e.r < m.s.r ||
      m.s.c < 0 ||
      m.e.c >= 500 ||
      m.s.c !== m.e.c
    )
      throw Error("数据区域的合并单元格无效，请核对合并范围");
    if (m.e.r === m.s.r) continue;
    const binding = request.mapping.find((b) => b.column === m.s.c);
    if (binding && columns.find((c) => c.field.id === binding.fieldId)?.parent)
      throw Error("子表字段每条明细占一行，请勿合并明细单元格");
    const end = spans.get(m.s.r);
    if (end !== undefined && end !== m.e.r)
      throw Error("主表字段的合并行数不一致");
    spans.set(m.s.r, m.e.r);
  }
  let previous = -1;
  for (const [start, end] of [...spans].sort((a, b) => a[0] - b[0])) {
    if (start <= previous) throw Error("主表字段的合并范围相互交叉");
    previous = end;
  }
  const groups: { start: number; end: number }[] = [];
  for (let start = 0; start < request.rows.length;) {
    const end = spans.get(start) ?? start;
    groups.push({ start, end });
    start = end + 1;
  }
  return groups;
}
function importedDate(field: FormField, value: string): string {
  const match =
    /^(\d{4})[-/.年](\d{1,2})(?:[-/.月](\d{1,2})日?)?(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/.exec(
      value.trim(),
    );
  if (!match) return "";
  const [, year, month, day = "1", hour = "0", minute = "0", second = "0"] =
    match;
  const pad = (v: string) => v.padStart(2, "0");
  const date = `${year}-${pad(month!)}-${pad(day)}`;
  const result =
    field.format === "month"
      ? date.slice(0, 7)
      : field.format === "date"
        ? date
        : `${date}T${pad(hour)}:${pad(minute)}${field.format === "datetime-second" ? `:${pad(second)}` : ""}`;
  return validDateValue(field.format, result) ? result : "";
}
/** Excel address parts still write one field value. Unmapped/blank update cells retain their original parts. */
function importInputs(
  columns: (ImportColumn & { binding: ImportMapping; input: ExcelValue })[],
  previous?: FormValues,
) {
  const result: {
    field: FormField;
    label: string;
    input: ExcelValue | AddressValue;
  }[] = [];
  for (const column of columns) {
    if (!column.addressPart) {
      result.push({
        field: column.field,
        label: column.label,
        input: column.input,
      });
      continue;
    }
    let grouped = result.find((c) => c.field.id === column.field.id);
    if (!grouped) {
      const original = previous?.[column.field.id];
      grouped = {
        field: column.field,
        label: column.field.label,
        input: isAddressValue(original) ? copy(original) : {},
      };
      result.push(grouped);
    }
    if (previous && emptyFieldValue(column.input)) continue;
    (grouped.input as AddressValue)[column.addressPart] =
      column.input == null ? "" : String(column.input);
  }
  return result;
}
export function importFieldValue(
  field: FormField,
  input: ExcelValue | AddressValue,
  values: FormValues,
  data: WorkspaceData,
  validate: boolean,
  relationIndex?: Map<string, string[]>,
  inputFields: FormField[] = [],
) {
  if (emptyFieldValue(input))
    return multiple.includes(field.type)
      ? []
      : field.type === "number"
        ? null
        : "";
  if (field.type === "address") {
    if (!isAddressValue(input))
      throw Error(`「${field.label}」请分别匹配省、市、县区和详细地址列`);
    return input;
  }
  const text = String(input).trim();
  if (field.type === "relation") {
    const matches = relationIndex?.get(String(input)) || [];
    if (matches.length !== 1)
      throw Error(
        `「${field.label}」${matches.length ? "匹配到多条主表数据，请使用唯一字段值" : "未在主表找到对应记录"}`,
      );
    return matches[0]!;
  }
  if (field.type === "number") {
    const number =
      typeof input === "number"
        ? input
        : /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)
          ? Number(text)
          : NaN;
    return Number.isFinite(number) &&
      Math.abs(number) <= Number.MAX_SAFE_INTEGER
      ? number
      : null;
  }
  if (field.type === "datetime") return importedDate(field, text);
  if (field.type === "phone") return /^1[3-9]\d{9}$/.test(text) ? text : "";
  if (["radio", "select", "checkbox", "multiselect"].includes(field.type)) {
    const options = resolveChoices(field, data, values, inputFields);
    const labels = multiple.includes(field.type)
      ? text
          .split(",")
          .map((v) => v.trim())
          .filter(Boolean)
      : [text];
    const selected = labels.map((label) => {
      const matches = options.filter((option) => option.label === label);
      if (matches.length > 1) throw Error(`${field.label}的选项名称重复`);
      return matches[0]?.id || label;
    });
    const result = multiple.includes(field.type) ? selected : selected[0]!;
    if (
      validate &&
      field.choiceSource.mode === "manual" &&
      !field.defaultLink?.enabled &&
      !field.allowCustomChoices
    ) {
      const issue = choiceValueIssue(field, result, options);
      if (issue) throw Error(`${field.label}：${issue}`);
    }
    return result;
  }
  if (orgTypes.includes(field.type)) {
    const department = field.type.startsWith("department");
    const options = department
      ? allowedDepartments(data.organization, field.organization.scope, values)
      : allowedEmployees(data.organization, field.organization.scope, values);
    const labels = multiple.includes(field.type)
      ? text
          .split(",")
          .map((v) => v.trim())
          .filter(Boolean)
      : [text];
    const ids = labels.map((label) => {
      // Jiandaoyun uses #member-number# / #department-id# for same-name entries.
      const identifier = /^[^#]*#([^#]+)#[^#]*$/.exec(label)?.[1];
      const matched = options.filter((option) =>
        identifier
          ? ("number" in option ? option.number : option.id) === identifier
          : option.id === label || option.name === label,
      );
      if (matched.length !== 1)
        throw Error(
          `${field.label}：${matched.length ? `名称重复，请填写 ${department ? "#部门ID#" : "#工号#"}` : "成员或部门不存在或不在可选范围"}`,
        );
      return matched[0]!.id;
    });
    if (new Set(ids).size !== ids.length)
      throw Error(`${field.label}不能重复选择`);
    return multiple.includes(field.type) ? ids : ids[0]!;
  }
  return String(input);
}

/** Preview and commit share import semantics, without form filling/defaults/events. */
export function prepareImportRows(
  form: FormRecord,
  request: RecordImportRequest,
  data: WorkspaceData,
): ImportRow[] {
  if (!form.published || form.published.version !== request.definitionVersion)
    throw Error("表单已重新发布，请重新打开导入；文件尚未导入");
  if (!["create", "update", "both"].includes(request.mode))
    throw Error("请选择导入模式");
  if (request.member) {
    if (!recordImportModes(form, data, request.member).includes(request.mode))
      throw Error(
        request.mode === "update"
          ? "请在有导入和编辑权限的单个权限组中更新数据"
          : "当前成员没有此导入权限",
      );
    // Members cannot disable validation. Imports intentionally bypass required/default/formula rules.
    request = { ...request, validate: true };
    if (request.rows.length > 10000) throw Error("成员每次最多导入 1 万行数据");
  }
  if (!request.rows.length || request.rows.length > 100000)
    throw Error("请选择 1 至 10 万条数据");
  if (
    !request.mapping.length ||
    !request.mapping.some((m) => m.fieldId !== "data_id") ||
    new Set(
      request.mapping.map((m) => importFieldKey(m.fieldId, m.addressPart)),
    ).size !== request.mapping.length ||
    new Set(request.mapping.map((m) => m.column)).size !==
      request.mapping.length
  )
    throw Error("请匹配至少一个表单字段，同一字段不能重复匹配");
  if (
    request.mode !== "create" &&
    !request.mapping.some((m) => m.fieldId === "data_id")
  )
    throw Error("更新数据需要匹配 data_id 列，请先导出记录 ID");
  if (
    request.mapping.some(
      (m) => !Number.isInteger(m.column) || m.column < 0 || m.column >= 500,
    )
  )
    throw Error("Excel 列不合法");
  if (
    request.mapping.some(
      (m) => m.fieldId === "data_id" && m.addressPart !== undefined,
    )
  )
    throw Error("data_id 匹配无效，请重新匹配");
  if (
    request.mapping.some((m) => orgTypes.includes(m.type)) &&
    request.rows.length > 10000
  )
    throw Error("包含成员或部门字段时最多导入 1 万条数据");
  const entries = new Map(
    data.entries
      .filter(
        (e) => e.formId === form.id && !e.deletedAt && e.status !== "draft",
      )
      .map((e) => [e.id, e]),
  );
  const currentColumns = recordImportColumns(form.published.schema);
  const allowedColumns = memberImportColumns(
    form,
    request.mode,
    data,
    request.member,
  );
  const conversionData = request.member
    ? memberContext(data, request.member.actorId)
    : data;
  const relationIndexes = new Map<string, Map<string, string[]>>();
  for (const binding of request.mapping.filter(
    (m) => m.fieldId !== "data_id",
  )) {
    const column = currentColumns.find(
      (c) =>
        c.field.id === binding.fieldId && c.addressPart === binding.addressPart,
    );
    if (
      !column ||
      column.field.type !== binding.type ||
      column.parent?.id !== binding.parentId
    )
      throw Error("匹配字段的类型或子表归属已变化，请重新匹配");
    if (
      request.member &&
      !allowedColumns.some(
        (c) =>
          c.field.id === binding.fieldId &&
          c.parent?.id === binding.parentId &&
          c.addressPart === binding.addressPart,
      )
    )
      throw Error("匹配字段已无导入权限，文件已保留，请重新核对字段");
    if (
      column.parent &&
      scopeFields(column.parent.children).filter(
        (f) => !["divider", "button"].includes(f.type),
      ).length < 2
    )
      throw Error(`「${column.parent.label}」至少需要两个子字段才能导入`);
    if (column.field.type === "relation") {
      if (
        !data.forms.some(
          (form) =>
            form.id === column.field.referenceFormId &&
            !form.archived &&
            form.published,
        )
      )
        throw Error(`「${column.label}」的关联主表未发布或已移入回收站`);
      const key = importRelationFields(
        column.field,
        data,
        request.member?.actorId,
      ).find((field) => field.id === binding.matchFieldId);
      if (!key) throw Error(`请选择「${column.label}」的主表匹配字段`);
      const index = new Map<string, string[]>();
      for (const entry of sourceEntries(
        conversionData,
        column.field.referenceFormId,
      )) {
        const definition = entryDefinition(entry, data);
        if (!definition)
          throw Error("关联主表的记录原版本不可用，请核对后导入");
        const original = scopeFields(definition.schema.fields).find(
          (field) =>
            field.id === key.id && relationMatchTypes.includes(field.type),
        );
        if (!original || emptyFieldValue(entry.values[key.id])) continue;
        const value = String(importExcelValue(original, entry, conversionData));
        const ids = index.get(value) || [];
        ids.push(entry.id);
        index.set(value, ids);
      }
      relationIndexes.set(column.field.id, index);
    }
  }
  const groups = importGroups(request, currentColumns);
  const selectedRows = request.onlyRows && new Set(request.onlyRows);
  if (selectedRows) {
    const starts = new Set(groups.map((g) => g.start));
    if (
      !selectedRows.size ||
      selectedRows.size !== request.onlyRows!.length ||
      request.onlyRows!.some(
        (row) => !Number.isInteger(row) || !starts.has(row),
      )
    )
      throw Error("请选择完整的失败数据重新导入");
  }
  const staged = new Map<string, FormValues>();
  const uniqueIds = new Set(
    request.validate
      ? form.versions.flatMap((v) =>
          recordImportColumns(v.schema)
            .filter(
              (c) => !c.parent && c.field.unique && c.field.type !== "serial",
            )
            .map((c) => c.field.id),
        )
      : [],
  );
  const unique = new Map<string, Map<string, Set<string>>>();
  for (const fieldId of uniqueIds) {
    const index = new Map<string, Set<string>>();
    for (const entry of entries.values()) {
      const value = entry.values[fieldId];
      if (emptyFieldValue(value)) continue;
      const key = JSON.stringify(value),
        ids = index.get(key) || new Set<string>();
      ids.add(entry.id);
      index.set(key, ids);
    }
    unique.set(fieldId, index);
  }
  const seen = new Set<string>(),
    result: ImportRow[] = [];
  const idColumn = request.mapping.find((m) => m.fieldId === "data_id")?.column;
  for (const { start: index, end } of groups) {
    if (selectedRows && !selectedRows.has(index)) continue;
    const row = request.rows[index]!;
    const item: ImportRow = {
      row: request.firstRow + index,
      ...(end > index ? { lastRow: request.firstRow + end } : {}),
      kind: "skip",
      warnings: [],
    };
    result.push(item);
    if (
      request.rows
        .slice(index, end + 1)
        .every((row) => row.every(emptyFieldValue))
    ) {
      item.message = "空白行";
      continue;
    }
    const id =
      request.mode === "create" ? "" : String(row[idColumn!] ?? "").trim();
    if (
      request.mode !== "create" &&
      request.rows.slice(index + 1, end + 1).some((r) => {
        const otherId = String(r[idColumn!] ?? "").trim();
        return otherId && otherId !== id;
      })
    ) {
      item.kind = "error";
      item.message = "data_id 在合并行内含不同值，请核对合并范围";
      item.issues = [
        { fieldId: "data_id", row: item.row, message: item.message },
      ];
      continue;
    }
    if (!id && request.mode === "update") {
      item.message = "data_id 为空";
      continue;
    }
    const found = id ? entries.get(id) : undefined;
    const entry =
      found &&
      (!request.member ||
        groupsForEntry(
          data,
          found,
          request.member.actorId,
          request.member.selection,
        ).some(
          (g) => g.actions.includes("import") && g.actions.includes("edit"),
        ))
        ? found
        : undefined;
    if (id && !entry) {
      item.message = "未找到该 data_id 的已提交记录";
      continue;
    }
    if (id && request.mode === "update" && seen.has(id)) {
      item.message = "data_id 重复，仅更新第一行";
      continue;
    }
    if (id) seen.add(id);
    item.id = entry?.id;
    const definition = entry
      ? form.versions.find((v) => v.version === entry.definitionVersion)
      : form.published;
    if (!definition) {
      item.kind = "error";
      item.message = "记录原表单版本不可用";
      continue;
    }
    try {
      const columns = memberImportColumns(
        form,
        request.mode,
        data,
        request.member,
        definition.schema,
      );
      const fields = [
        ...new Map(
          columns.filter((c) => !c.parent).map((c) => [c.field.id, c.field]),
        ).values(),
      ];
      const values = entry ? copy(staged.get(id) || entry.values) : {};
      item.values = values;
      const addIssue = (fieldId: string, message: string, row = item.row) => {
        (item.issues ||= []).push({ fieldId, row, message });
      };
      const mapped = request.mapping
        .filter((m) => m.fieldId !== "data_id" && (!entry || !m.parentId))
        .filter(
          (m) =>
            !request.member || columns.some((c) => c.field.id === m.fieldId),
        )
        .map((m) => {
          const column = columns.find(
            (c) => c.field.id === m.fieldId && c.addressPart === m.addressPart,
          );
          if (
            !column ||
            column.field.type !== m.type ||
            column.parent?.id !== m.parentId
          )
            throw Error("匹配字段已删除或与记录原版本的类型不同，请分别导入");
          return { ...column, binding: m, input: row[m.column] ?? null };
        });
      if (!mapped.length) {
        item.message = "记录原版本没有可导入的匹配字段";
        continue;
      }
      const main = mapped.filter((c) => !c.parent);
      for (const column of main) {
        if (
          request.rows
            .slice(index + 1, end + 1)
            .some(
              (r) =>
                !emptyFieldValue(r[column.binding.column]) &&
                r[column.binding.column] !== column.input,
            )
        )
          addIssue(
            column.field.id,
            `主表「${column.label}」在合并行内含不同值，请核对合并范围`,
          );
      }
      // Department dependencies read converted values, regardless of Excel column order.
      const inputs = importInputs(main, entry ? values : undefined);
      const ordered = [
        ...inputs.filter((m) => !orgTypes.includes(m.field.type)),
        ...inputs.filter((m) => m.field.type.startsWith("department")),
        ...inputs.filter((m) => m.field.type.startsWith("member")),
      ];
      for (const { field, input } of ordered) {
        if (!entry && field.type === "serial") continue;
        if (entry && emptyFieldValue(input)) continue;
        if (
          field.type === "relation" &&
          currentColumns.find((c) => c.field.id === field.id)?.field
            .referenceFormId !== field.referenceFormId
        )
          throw Error(
            `「${field.label}」与记录原版本的关联主表不同，请分别导入`,
          );
        try {
          const value = importFieldValue(
            field,
            input,
            values,
            conversionData,
            request.validate,
            relationIndexes.get(field.id),
            definition.schema.fields,
          );
          if (
            field.type === "relation" &&
            field.referenceFormId === form.id &&
            entry &&
            value === entry.id
          )
            throw Error(`「${field.label}」不能关联记录自身`);
          values[field.id] = value;
          if (!emptyFieldValue(input) && emptyFieldValue(value))
            item.warnings.push(`${field.label}格式无效，按空值导入`);
        } catch (error) {
          // This failed row is never written. Its correction control must show
          // the rejected input, rather than the record's previous valid value.
          delete values[field.id];
          addIssue(field.id, (error as Error).message);
        }
      }
      const parents = new Map(
        mapped.filter((c) => c.parent).map((c) => [c.parent!.id, c.parent!]),
      );
      if (entry && request.mapping.some((m) => m.parentId))
        item.warnings.push("仅更新主表字段，原子表明细保持不变");
      if (!entry)
        for (const parent of parents.values()) {
          const children = mapped.filter((c) => c.parent?.id === parent.id);
          const childRows: FormValues[] = [];
          for (let physical = index; physical <= end; physical++) {
            const inputRow = request.rows[physical]!;
            if (
              children.every((c) => emptyFieldValue(inputRow[c.binding.column]))
            )
              continue;
            const childValues: FormValues = {};
            const inputs = importInputs(
              children.map((c) => ({
                ...c,
                input: inputRow[c.binding.column] ?? null,
              })),
            );
            const orderedChildren = [
              ...inputs.filter((c) => !orgTypes.includes(c.field.type)),
              ...inputs.filter((c) => c.field.type.startsWith("department")),
              ...inputs.filter((c) => c.field.type.startsWith("member")),
            ];
            for (const column of orderedChildren) {
              const input = column.input;
              try {
                const value = importFieldValue(
                  column.field,
                  input,
                  { ...values, ...childValues },
                  conversionData,
                  request.validate,
                  undefined,
                  definition.schema.fields,
                );
                childValues[column.field.id] = value;
                if (!emptyFieldValue(input) && emptyFieldValue(value))
                  item.warnings.push(
                    `Excel 第 ${request.firstRow + physical} 行「${column.label}」格式无效，按空值导入`,
                  );
              } catch (error) {
                addIssue(
                  column.field.id,
                  `Excel 第 ${request.firstRow + physical} 行：${(error as Error).message}`,
                  request.firstRow + physical,
                );
              }
            }
            if (request.validate) {
              const issues = validateValues(
                {
                  ...definition.schema,
                  settings: { ...definition.schema.settings, rules: [] },
                  fields: inputs.map((c) => ({
                    ...c.field,
                    unique: false,
                    required: false,
                    visible: true,
                    retainPrecision: false,
                  })),
                },
                { ...values, ...childValues },
              );
              for (const issue of issues)
                addIssue(
                  issue.fieldId,
                  `Excel 第 ${request.firstRow + physical} 行「${parent.label}」：${issue.message}`,
                  request.firstRow + physical,
                );
            }
            childRows.push(childValues);
          }
          values[parent.id] = childRows;
        }
      for (const issue of subformRowLimitErrors(
        definition.schema.fields,
        values,
        entry?.values,
      ))
        addIssue(issue.fieldId, issue.message);
      const validationFields: FormField[] = fields
        .filter((f) => f.type !== "serial" && request.validate)
        .map((f) => ({
          ...f,
          unique: false,
          visible: true,
          required: false,
          retainPrecision: false,
        }));
      const issues = validateValues(
        {
          ...definition.schema,
          settings: { ...definition.schema.settings, rules: [] },
          fields: validationFields,
        },
        values,
      );
      for (const issue of issues) addIssue(issue.fieldId, issue.message);
      const uniqueFields = request.validate
        ? fields.filter((f) => f.unique && f.type !== "serial")
        : [];
      for (const field of uniqueFields) {
        const value = values[field.id];
        if (
          !emptyFieldValue(value) &&
          [...(unique.get(field.id)?.get(JSON.stringify(value)) || [])].some(
            (key) => key !== id,
          )
        )
          addIssue(field.id, `${field.label}不能重复`);
      }
      if (item.issues?.length) {
        item.kind = "error";
        item.message = item.issues[0]!.message;
        continue;
      }
      item.kind = entry ? "update" : "create";
      item.id = entry?.id;
      item.values = values;
      for (const field of uniqueFields) {
        const index = unique.get(field.id)!;
        const previous = staged.get(id) || entry?.values;
        if (entry && previous)
          index.get(JSON.stringify(previous[field.id]))?.delete(id);
        if (!emptyFieldValue(values[field.id])) {
          const key = JSON.stringify(values[field.id]),
            ids = index.get(key) || new Set<string>();
          ids.add(id || `new:${item.row}`);
          index.set(key, ids);
        }
      }
      if (entry) staged.set(id, values);
    } catch (error) {
      item.kind = "error";
      item.message = (error as Error).message;
    }
  }
  if (
    request.triggerWorkflow &&
    (request.mode === "update" ||
      form.kind !== "workflow" ||
      result.filter((r) => r.kind === "create").length > 300)
  )
    throw Error("触发流程仅用于新增流程数据，每次最多 300 条");
  return result;
}
export function importExcelValue(
  field: FormField,
  entry: Pick<FormEntry, "values">,
  data: WorkspaceData,
  matchFieldId?: string,
  addressPart?: keyof AddressValue,
): ExcelValue {
  const value = entry.values[field.id];
  if (emptyFieldValue(value)) return null;
  if (field.type === "address") {
    if (!isAddressValue(value))
      throw Error(`「${field.label}」的地址格式无效，请核对后导出`);
    return addressPart
      ? addressParts(field).includes(addressPart)
        ? value[addressPart] || null
        : null
      : addressText(value, "", addressParts(field));
  }
  if (field.type === "relation") {
    const ids = idsOf(value);
    const related = sourceEntries(data, field.referenceFormId).find(
      (record) => record.id === ids[0],
    );
    if (ids.length !== 1 || !related || !entryDefinition(related, data))
      throw Error(`「${field.label}」的关联记录不可用，请核对后导出`);
    if (matchFieldId) {
      const key = scopeFields(
        entryDefinition(related, data)!.schema.fields,
      ).find(
        (f) => f.id === matchFieldId && relationMatchTypes.includes(f.type),
      );
      if (!key) throw Error(`「${field.label}」的匹配字段不可用，请重新核对`);
      return importExcelValue(key, related, data);
    }
    return entryTitle(related, data);
  }
  if (["radio", "select", "checkbox", "multiselect"].includes(field.type)) {
    const options = resolveChoices(
      { ...field, choiceSource: { ...field.choiceSource, filters: [] } },
      data,
      {},
    );
    const labels = (Array.isArray(value) ? value : [value]).map((v) =>
      choiceValueLabel(options, v),
    );
    if (
      multiple.includes(field.type) &&
      labels.some((label) => label.includes(","))
    )
      throw Error(
        `「${field.label}」的多选项名称含逗号，无法生成可导回的 Excel。请使用 CSV 导出查看，或调整选项名称。`,
      );
    return labels.join(",");
  }
  if (orgTypes.includes(field.type))
    return (Array.isArray(value) ? value : [value])
      .map((id) => {
        const directory = field.type.startsWith("department")
          ? data.organization.departments
          : data.organization.employees;
        const selected = directory.find((item) => item.id === id);
        if (
          selected &&
          !selected.name.includes(",") &&
          !selected.name.includes("#") &&
          directory.filter((item) => item.name === selected.name).length === 1
        )
          return selected.name;
        const identifier = String(
          selected && "number" in selected ? selected.number : id,
        );
        if (
          identifier.includes("#") ||
          (multiple.includes(field.type) && identifier.includes(","))
        )
          throw Error(
            `「${field.label}」的编号包含逗号或 #，无法生成可导回的 Excel。请调整编号，或使用 CSV 导出查看。`,
          );
        return `#${identifier}#`;
      })
      .join(",");
  if (field.type === "datetime") return String(value).replace("T", " ");
  return typeof value === "number" || typeof value === "boolean"
    ? value
    : String(value);
}
