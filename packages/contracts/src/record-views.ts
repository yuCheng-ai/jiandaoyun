import type { FormField } from "./form";
import type { PageRecordSummary } from "./index";

export const recordRowHeights = [
  { value: "low", label: "低" },
  { value: "medium", label: "中" },
  { value: "high", label: "高" },
  { value: "auto", label: "自适应" },
] as const;
export type RecordRowHeight = (typeof recordRowHeights)[number]["value"];
export interface RecordViewSettings {
  fieldIds: string[];
  sortField: string;
  descending: boolean;
  pageSize: 10 | 20 | 50;
  rowHeight?: RecordRowHeight;
}
export interface SavedRecordView {
  revision: number;
  settings: RecordViewSettings;
}
export interface RecordListResult {
  records: PageRecordSummary[];
  total: number;
  page: number;
  pageSize: number;
  view: SavedRecordView;
  fields: FormField[];
}
/** Tolerant reading of existing local preferences; command validation is strict. */
export function parseRecordView(raw: any): RecordViewSettings {
  return {
    fieldIds: Array.isArray(raw?.fieldIds)
      ? [
          ...new Set<string>(
            raw.fieldIds.filter(
              (id: unknown): id is string => typeof id === "string",
            ),
          ),
        ]
      : [],
    sortField:
      typeof raw?.sortField === "string" ? raw.sortField : "$createdAt",
    descending: raw?.descending !== false,
    pageSize: [10, 20, 50].includes(raw?.pageSize) ? raw.pageSize : 20,
    rowHeight: recordRowHeights.some((item) => item.value === raw?.rowHeight)
      ? raw.rowHeight
      : "low",
  };
}
export function validateRecordView(
  raw: unknown,
  fieldIds: Set<string>,
): RecordViewSettings {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw Error("列表设置格式无效");
  const value = raw as Record<string, unknown>;
  if (
    Object.keys(value).some(
      (key) =>
        ![
          "fieldIds",
          "sortField",
          "descending",
          "pageSize",
          "rowHeight",
        ].includes(key),
    ) ||
    !Array.isArray(value.fieldIds) ||
    value.fieldIds.length > 1000 ||
    new Set(value.fieldIds).size !== value.fieldIds.length ||
    value.fieldIds.some((id) => typeof id !== "string" || !fieldIds.has(id)) ||
    typeof value.sortField !== "string" ||
    (value.sortField !== "$createdAt" && !fieldIds.has(value.sortField)) ||
    typeof value.descending !== "boolean" ||
    ![10, 20, 50].includes(value.pageSize as number) ||
    (value.rowHeight !== undefined &&
      !recordRowHeights.some((item) => item.value === value.rowHeight))
  )
    throw Error("列表字段、排序或分页设置无效，请核对后保存");
  return parseRecordView(value);
}
export function compareRecordSortValues(
  a: string | number,
  b: string | number,
  descending: boolean,
) {
  return (
    (typeof a === "number" && typeof b === "number"
      ? (Number.isFinite(a) ? a : 0) - (Number.isFinite(b) ? b : 0)
      : String(a).localeCompare(String(b), "zh-CN", { numeric: true })) *
    (descending ? -1 : 1)
  );
}
