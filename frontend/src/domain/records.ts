import { entryTitle } from "./collaboration";
import { isNumericField } from "@platform/contracts";
import type { FormField, FormSchema } from "./form";
import type { FormEntry, WorkspaceData } from "./workspace";
import {
  displayValue,
  matchesFilters,
  scopeFields,
  relationCandidates,
} from "./relations";
import type { DataFilter } from "./fieldConfig";
import { presentationFields } from "./presentation";
import {
  importExcelLayout,
  importExcelValue,
  recordImportColumns,
  type ImportColumn,
} from "./recordImport";
import type { ExcelMerge, ExcelValue } from "../services/excel";

/** Callers provide the exact record schema and permission-masked values. */
export function recordExcelExport(
  data: WorkspaceData,
  columns: FormField[],
  headers: string[],
  records: { entry: FormEntry; schema: FormSchema; extra: ExcelValue[] }[],
) {
  const excelColumns = columns.flatMap<ImportColumn>((field) =>
    ["subform", "address"].includes(field.type)
      ? recordImportColumns({ fields: [field] } as FormSchema)
      : [{ field, label: field.label }],
  );
  const layout = importExcelLayout(
    excelColumns,
    headers,
    headers.map((h) => (h === "data_id" ? h : "")),
  );
  const rows: ExcelValue[][] = [];
  const merges: ExcelMerge[] = [...layout.merges];
  for (const { entry, schema, extra } of records) {
    const importable = new Set(
      recordImportColumns(schema).map((c) => c.field.id),
    );
    const original = scopeFields(schema.fields).flatMap<{
      field: FormField;
      parent?: FormField;
    }>((field) =>
      field.type === "subform"
        ? scopeFields(field.children).map((child) => ({
            field: child,
            parent: field,
          }))
        : [{ field, parent: undefined }],
    );
    const matched = excelColumns.map((column) => {
      const match = original.find((c) => c.field.id === column.field.id);
      if (match && match.parent?.id !== column.parent?.id)
        throw Error("导出字段与记录原版本的子表归属不同，请分别导出");
      if (match && column.addressPart && match.field.type !== "address")
        throw Error("导出字段与记录原版本的地址类型不同，请分别导出");
      return match;
    });
    const parents = new Set(
      matched.flatMap((c) => (c?.parent ? [c.parent.id] : [])),
    );
    const length = Math.max(
      1,
      ...[...parents].map((id) =>
        Array.isArray(entry.values[id]) ? entry.values[id].length : 0,
      ),
    );
    if (rows.length + length > 100000)
      throw Error("导出明细超过10万行，请缩小筛选范围后导出");
    const start = layout.headers.length + rows.length;
    for (let index = 0; index < length; index++) {
      rows.push([
        ...extra.map((value) => (index ? null : value)),
        ...excelColumns.map((column, c) => {
          const match = matched[c];
          if (!match) return null;
          if (column.parent) {
            const raw = entry.values[column.parent.id];
            const values = Array.isArray(raw) ? raw[index] : undefined;
            return values &&
              typeof values === "object" &&
              !Array.isArray(values)
              ? importExcelValue(
                  match.field,
                  { ...entry, values },
                  data,
                  undefined,
                  column.addressPart,
                )
              : null;
          }
          if (index) return null;
          if (
            match.field.type === "relationTable" &&
            match.field.reference.mode === "reverse"
          )
            return `${relationCandidates(match.field, data, entry.values, entry.id, schema.fields).length} 条关联`;
          return importable.has(match.field.id)
            ? importExcelValue(
                match.field,
                entry,
                data,
                undefined,
                column.addressPart,
              )
            : displayValue(match.field, entry.values[match.field.id], data);
        }),
      ]);
    }
    if (length > 1)
      for (let c = 0; c < headers.length + excelColumns.length; c++)
        if (c < headers.length || !excelColumns[c - headers.length]!.parent)
          merges.push({ s: { r: start, c }, e: { r: start + length - 1, c } });
  }
  return {
    rows: [...layout.headers, ...rows],
    fieldIds: layout.fieldIds,
    merges,
  };
}

export interface RecordViewSettings {
  fieldIds: string[];
  sortField: string;
  descending: boolean;
  pageSize: 10 | 20 | 50;
}
export function defaultRecordView(schema: FormSchema): RecordViewSettings {
  return {
    fieldIds: presentationFields(schema)
      .slice(0, 6)
      .map((f) => f.id),
    sortField: "$createdAt",
    descending: true,
    pageSize: 20,
  };
}
export function parseRecordView(raw: any): RecordViewSettings {
  return {
    fieldIds: Array.isArray(raw?.fieldIds)
      ? ([
          ...new Set(
            raw.fieldIds.filter(
              (id: unknown): id is string => typeof id === "string",
            ),
          ),
        ] as string[])
      : [],
    sortField:
      typeof raw?.sortField === "string" ? raw.sortField : "$createdAt",
    descending: raw?.descending !== false,
    pageSize: [10, 20, 50].includes(raw?.pageSize) ? raw.pageSize : 20,
  };
}
export function entrySchema(
  entry: FormEntry,
  data: WorkspaceData,
  fallback: FormSchema,
): FormSchema {
  const form = data.forms.find((f) => f.id === entry.formId);
  return (
    form?.versions.find((v) => v.version === entry.definitionVersion)?.schema ||
    form?.published?.schema ||
    fallback
  );
}
export function filterAndSortRecords(
  entries: FormEntry[],
  schema: FormSchema,
  data: WorkspaceData,
  options: { query: string; filters: DataFilter[]; view: RecordViewSettings },
): FormEntry[] {
  const query = options.query.trim().toLocaleLowerCase();
  const text = (entry: FormEntry, id?: string) => {
    const fields = presentationFields(entrySchema(entry, data, schema));
    return (id ? fields.filter((f) => f.id === id) : fields)
      .map((f) => displayValue(f, entry.values[f.id], data))
      .join(" ")
      .toLocaleLowerCase();
  };
  return entries
    .filter(
      (e) =>
        (!query ||
          text(e).includes(query) ||
          entryTitle(e, data).toLocaleLowerCase().includes(query) ||
          e.id.includes(query)) &&
        matchesFilters(
          options.filters,
          e.values,
          e.values,
          data,
          "all",
          presentationFields(schema),
          presentationFields(entrySchema(e, data, schema)),
        ),
    )
    .sort((a, b) => {
      const field = presentationFields(schema).find(
        (f) => f.id === options.view.sortField,
      );
      const direction = options.view.descending ? -1 : 1;
      const av =
        options.view.sortField === "$createdAt"
          ? Date.parse(a.createdAt)
          : field && isNumericField(field)
            ? Number(a.values[field.id])
            : text(a, options.view.sortField);
      const bv =
        options.view.sortField === "$createdAt"
          ? Date.parse(b.createdAt)
          : field && isNumericField(field)
            ? Number(b.values[field.id])
            : text(b, options.view.sortField);
      return (
        (typeof av === "number" && typeof bv === "number"
          ? (Number.isFinite(av) ? av : 0) - (Number.isFinite(bv) ? bv : 0)
          : String(av).localeCompare(String(bv), "zh-CN", { numeric: true })) *
          direction || a.id.localeCompare(b.id)
      );
    });
}
