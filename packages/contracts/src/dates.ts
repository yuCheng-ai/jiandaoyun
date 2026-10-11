import type { FormField } from "./form";
import { parseNumberInput } from "./numbers";

export const dateFormats = [
  { value: "month", label: "年-月" },
  { value: "date", label: "年-月-日" },
  { value: "datetime-local", label: "年-月-日 时:分" },
  { value: "datetime-second", label: "年-月-日 时:分:秒" },
] as const;
export const isDateFormat = (format: string) =>
  dateFormats.some((item) => item.value === format);
export const dateInputType = (format: string) =>
  format === "month"
    ? "month"
    : format.startsWith("datetime-")
      ? "datetime-local"
      : "date";
export const dateInputStep = (format: string) =>
  format === "datetime-second" ? 1 : undefined;

/** Civil calendar values are validated without Date rollover or timezone conversion. */
export function validDateValue(
  format: string,
  value: unknown,
): value is string {
  if (typeof value !== "string") return false;
  const pattern =
    format === "month"
      ? /^(\d{4})-(\d{2})$/
      : format === "date"
        ? /^(\d{4})-(\d{2})-(\d{2})$/
        : format === "datetime-local" || format === "datetime-second"
          ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/
          : undefined;
  const match = pattern?.exec(value);
  if (!match) return false;
  const [, y, m, d, h, minute, second] = match;
  const year = Number(y),
    month = Number(m),
    day = Number(d);
  if (year < 1 || month < 1 || month > 12) return false;
  if (format === "month") return true;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  if (
    day < 1 ||
    day >
      [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!
  )
    return false;
  return (
    format === "date" ||
    (Number(h) < 24 &&
      Number(minute) < 60 &&
      (second === undefined || Number(second) < 60))
  );
}

/** Native inputs may omit :00; keep second-granularity storage canonical. */
export function normalizeDateValue(format: string, value: string) {
  return format === "datetime-second" &&
    value.length === 16 &&
    validDateValue(format, value)
    ? `${value}:00`
    : value;
}

/** Only a draft's custom default changes granularity; existing records are never rewritten. */
export function dateFormatDefault(
  value: FormField["defaultValue"],
  format: string,
): FormField["defaultValue"] {
  if (
    !value ||
    !isDateFormat(format) ||
    !dateFormats.some((item) => validDateValue(item.value, value))
  )
    return value;
  const text = String(value),
    date = text.length === 7 ? `${text}-01` : text.slice(0, 10);
  if (format === "month") return date.slice(0, 7);
  if (format === "date") return date;
  const minute = text.length >= 16 ? text.slice(0, 16) : `${date}T00:00`;
  return format === "datetime-local"
    ? minute
    : text.length >= 19
      ? text.slice(0, 19)
      : `${minute}:00`;
}

export function dateFormatPatch(
  field: FormField,
  format: string,
): Partial<FormField> {
  const range = field.dateRange;
  return {
    format,
    defaultValue: dateFormatDefault(field.defaultValue, format),
    ...(range
      ? {
          dateRange: {
            ...range,
            earliest: {
              ...range.earliest,
              value: String(dateFormatDefault(range.earliest.value, format)),
            },
            latest: {
              ...range.latest,
              value: String(dateFormatDefault(range.latest.value, format)),
            },
          },
        }
      : {}),
  };
}

/** The current platform uses China Standard Time consistently in browser and server defaults. */
export function dateValueAt(format: string, now = new Date()): string {
  if (!isDateFormat(format) || !Number.isFinite(now.getTime())) return "";
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(now)
      .map((part) => [part.type, part.value]),
  );
  const date = `${parts.year!.padStart(4, "0")}-${parts.month}-${parts.day}`;
  return format === "month"
    ? date.slice(0, 7)
    : format === "date"
      ? date
      : `${date}T${parts.hour}:${parts.minute}${format === "datetime-second" ? `:${parts.second}` : ""}`;
}

export function fieldDefaultValue(
  field: Pick<FormField, "type" | "format" | "defaultValue" | "dateDefault">,
  now = new Date(),
) {
  // Historical numeric defaults were stored as text. They already represent
  // the underlying number (including percentage ratios), not fresh user input.
  if (field.type === "number" && typeof field.defaultValue === "string")
    return parseNumberInput({ format: "number" }, field.defaultValue);
  return field.type === "datetime" && field.dateDefault === "now"
    ? dateValueAt(field.format, now)
    : field.defaultValue;
}
