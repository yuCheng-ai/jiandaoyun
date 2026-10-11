import type { FormField, FormValues } from "./form";
import { dateValueAt, normalizeDateValue, validDateValue } from "./dates";

export const datePresets = [
  { value: 0, label: "当天" },
  { value: -1, label: "昨天" },
  { value: 1, label: "明天" },
  { value: -7, label: "7天前" },
  { value: 7, label: "7天后" },
  { value: -30, label: "30天前" },
  { value: 30, label: "30天后" },
] as const;
export const dateUnits = [
  { value: "day", label: "天" },
  { value: "week", label: "周" },
  { value: "month", label: "月" },
  { value: "quarter", label: "季" },
  { value: "year", label: "年" },
] as const;
export interface DateBoundary {
  enabled: boolean;
  mode: "dynamic" | "fixed" | "field";
  preset: number | "custom";
  direction: "current" | "past" | "future";
  amount: number;
  unit: (typeof dateUnits)[number]["value"];
  value: string;
  fieldId: string;
}
export interface DateRange {
  weekdaysEnabled: boolean;
  weekdays: number[]; // Sunday = 0, shared with the civil calendar.
  earliest: DateBoundary;
  latest: DateBoundary;
}
export function emptyDateRange(): DateRange {
  const boundary = (): DateBoundary => ({
    enabled: false,
    mode: "dynamic",
    preset: 0,
    direction: "current",
    amount: 1,
    unit: "day",
    value: "",
    fieldId: "",
  });
  return {
    weekdaysEnabled: false,
    weekdays: [1, 2, 3, 4, 5, 6, 0],
    earliest: boundary(),
    latest: boundary(),
  };
}
/** Tabs share their parent's data scope; each subform has its own row scope. */
export function dateScopeFields(fields: FormField[], id: string): FormField[] {
  const flat = (items: FormField[]): FormField[] =>
    items.flatMap((field) =>
      field.type === "tabs" ? flat(field.children) : [field],
    );
  const scope = flat(fields);
  if (scope.some((field) => field.id === id)) return scope;
  for (const field of scope) {
    if (field.type !== "subform") continue;
    const found = dateScopeFields(field.children, id);
    if (found.length) return found;
  }
  return [];
}
/** Validate configuration, never record values: these rules belong to the selection panel. */
export function dateRangeErrors(
  field: FormField,
  scope?: FormField[],
  incomplete = false,
): string[] {
  const range = field.dateRange;
  if (range === undefined) return [];
  if (
    field.type !== "datetime" ||
    !range ||
    typeof range !== "object" ||
    Array.isArray(range)
  )
    return ["日期范围配置不合法"];
  if (
    typeof range.weekdaysEnabled !== "boolean" ||
    !Array.isArray(range.weekdays) ||
    range.weekdays.length > 7 ||
    new Set(range.weekdays).size !== range.weekdays.length ||
    range.weekdays.some((day) => !Number.isInteger(day) || day < 0 || day > 6)
  )
    return ["可选星期配置不合法"];
  const errors: string[] = [];
  for (const key of ["earliest", "latest"] as const) {
    const label = key === "earliest" ? "最早可选时间" : "最晚可选时间",
      boundary = range[key];
    if (
      !boundary ||
      typeof boundary !== "object" ||
      Array.isArray(boundary) ||
      typeof boundary.enabled !== "boolean" ||
      !["dynamic", "fixed", "field"].includes(boundary.mode) ||
      !["current", "past", "future"].includes(boundary.direction) ||
      !dateUnits.some((unit) => unit.value === boundary.unit) ||
      !Number.isInteger(boundary.amount) ||
      boundary.amount < 1 ||
      boundary.amount > 99 ||
      (boundary.preset !== "custom" &&
        !datePresets.some((preset) => preset.value === boundary.preset)) ||
      typeof boundary.value !== "string" ||
      typeof boundary.fieldId !== "string"
    ) {
      errors.push(`${label}配置不合法`);
      continue;
    }
    if (!boundary.enabled) continue;
    if (
      boundary.mode === "fixed" &&
      !(incomplete && boundary.value === "") &&
      !validDateValue(field.format, boundary.value)
    )
      errors.push(`${label}请选择有效日期`);
    if (
      boundary.mode === "field" &&
      scope &&
      !incomplete &&
      !scope.some(
        (other) =>
          other.id !== field.id &&
          other.id === boundary.fieldId &&
          other.type === "datetime" &&
          other.format === field.format,
      )
    )
      errors.push(`${label}请选择同一范围内、类型相同的其他日期字段`);
  }
  if (
    !errors.length &&
    range.earliest.enabled &&
    range.latest.enabled &&
    range.earliest.mode === "fixed" &&
    range.latest.mode === "fixed" &&
    comparable(field.format, range.earliest.value) >
      comparable(field.format, range.latest.value)
  )
    errors.push("最早可选时间不能晚于最晚可选时间");
  return errors;
}
export function civilDate(value: string) {
  const [year, month, day = 1] = value.slice(0, 10).split("-").map(Number),
    date = new Date(0);
  date.setUTCFullYear(year!, month! - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  return date;
}
export function civilDay(date: Date) {
  return `${String(date.getUTCFullYear()).padStart(4, "0")}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}
const comparable = (format: string, value: string) =>
  format.startsWith("datetime-")
    ? normalizeDateValue("datetime-second", value)
    : value;
export function dateBoundaryValue(
  field: FormField,
  key: "earliest" | "latest",
  values: FormValues = {},
  now = new Date(),
): string {
  const boundary = field.dateRange?.[key];
  if (!boundary?.enabled) return "";
  if (boundary.mode !== "dynamic") {
    const value =
      boundary.mode === "fixed" ? boundary.value : values[boundary.fieldId];
    return validDateValue(field.format, value)
      ? comparable(field.format, value)
      : "";
  }
  const start = civilDate(dateValueAt("date", now)),
    unit = boundary.preset === "custom" ? boundary.unit : "day";
  const offset =
    boundary.preset === "custom"
      ? boundary.direction === "current"
        ? 0
        : boundary.amount * (boundary.direction === "past" ? -1 : 1)
      : boundary.preset;
  if (unit === "day" || unit === "week") {
    if (unit === "week")
      start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
    start.setUTCDate(start.getUTCDate() + offset * (unit === "week" ? 7 : 1));
  } else {
    const month =
      unit === "year"
        ? 0
        : unit === "quarter"
          ? Math.floor(start.getUTCMonth() / 3) * 3
          : start.getUTCMonth();
    start.setUTCMonth(month, 1);
    start.setUTCMonth(
      start.getUTCMonth() +
        offset * (unit === "year" ? 12 : unit === "quarter" ? 3 : 1),
    );
  }
  const end = new Date(start);
  if (unit === "day" || unit === "week")
    end.setUTCDate(end.getUTCDate() + (unit === "week" ? 7 : 1));
  else
    end.setUTCMonth(
      end.getUTCMonth() + (unit === "year" ? 12 : unit === "quarter" ? 3 : 1),
    );
  end.setUTCDate(end.getUTCDate() - 1);
  const day = civilDay(key === "earliest" ? start : end);
  return field.format === "month"
    ? day.slice(0, 7)
    : field.format === "date"
      ? day
      : `${day}T${key === "earliest" ? "00:00:00" : "23:59:59"}`;
}
export function selectableDateValue(
  field: FormField,
  value: string,
  values: FormValues = {},
  now = new Date(),
) {
  if (!validDateValue(field.format, value)) return false;
  const min = dateBoundaryValue(field, "earliest", values, now),
    max = dateBoundaryValue(field, "latest", values, now),
    text = comparable(field.format, value);
  if ((min && text < min) || (max && text > max)) return false;
  const range = field.dateRange;
  return (
    !range?.weekdaysEnabled ||
    (field.format === "month"
      ? range.weekdays.length > 0
      : range.weekdays.includes(civilDate(value).getUTCDay()))
  );
}
/** Choosing a date retains time where possible and clamps it to that day's permitted interval. */
export function datePanelValue(
  field: FormField,
  day: string,
  current: string,
  values: FormValues = {},
  now = new Date(),
) {
  let value =
    field.format === "month"
      ? day.slice(0, 7)
      : field.format === "date"
        ? day
        : `${day.slice(0, 10)}T${validDateValue(field.format, current) ? comparable(field.format, current).slice(11) : "00:00:00"}`;
  if (field.format.startsWith("datetime-")) {
    if (field.format === "datetime-local") value = `${value.slice(0, 16)}:00`;
    const min = dateBoundaryValue(field, "earliest", values, now),
      max = dateBoundaryValue(field, "latest", values, now);
    if (min && min.slice(0, 10) === day.slice(0, 10) && value < min) {
      value = min;
      if (field.format === "datetime-local" && Number(min.slice(17, 19))) {
        const next = civilDate(min);
        next.setUTCHours(
          Number(min.slice(11, 13)),
          Number(min.slice(14, 16)) + 1,
        );
        value = `${civilDay(next)}T${String(next.getUTCHours()).padStart(2, "0")}:${String(next.getUTCMinutes()).padStart(2, "0")}:00`;
      }
    }
    if (max && max.slice(0, 10) === day.slice(0, 10) && value > max)
      value = max;
    if (field.format === "datetime-local") value = value.slice(0, 16);
    if (value.slice(0, 10) !== day.slice(0, 10)) return "";
  }
  return value;
}
