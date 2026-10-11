import {
  formatSerialDate,
  serialDateParts,
  serialSettingsErrors,
  validDateValue,
  type SerialResetCycle,
} from "@platform/contracts";
import {
  copy,
  flattenFields,
  resolveCalculations,
  type FormField,
  type FormSchema,
  type FormValues,
} from "./form";
import { displayValue, scopeFields } from "./relations";
import type { WorkspaceData } from "./workspace";

export interface SerialCounter {
  period: string;
  next: number;
}
export type SerialCounters = Record<
  string,
  Record<string, Partial<Record<SerialResetCycle, SerialCounter>>>
>;
export const serialSourceTypes = ["text", "number", "radio", "select"];
export function serialSourceFields(schema: FormSchema) {
  return scopeFields(schema.fields).filter((f) =>
    serialSourceTypes.includes(f.type),
  );
}
export function serialConfigurationErrors(
  field: FormField,
  schema: FormSchema,
): string[] {
  if (!field.serial) return [];
  const errors = serialSettingsErrors(field.serial),
    main = scopeFields(schema.fields);
  if (field.type !== "serial") errors.push("流水号规则仅用于流水号字段");
  if (!main.some((f) => f.id === field.id))
    errors.push("流水号只能添加在主表中");
  if (
    flattenFields(schema.fields).filter((f) => f.type === "serial").length > 1
  )
    errors.push("一个表单只能添加一个流水号字段");
  const source = serialSourceFields(schema);
  for (const rule of field.serial.rules)
    if (rule.type === "field" && !source.some((f) => f.id === rule.fieldId))
      errors.push("流水号引用字段已删除或不支持，请重新选择");
  return errors;
}
export function serialPeriod(reset: SerialResetCycle, now: Date): string {
  const p = serialDateParts(now);
  return reset === "none"
    ? "all"
    : reset === "year"
      ? p.year
      : reset === "month"
        ? `${p.year}-${p.month}`
        : `${p.year}-${p.month}-${p.day}`;
}
export function currentSerialCounter(
  data: WorkspaceData,
  formId: string,
  field: FormField,
  now = new Date(),
): SerialCounter {
  const s = field.serial!;
  const period = serialPeriod(s.reset, now),
    stored = data.serialCounters?.[formId]?.[field.id]?.[s.reset];
  return stored?.period === period
    ? { period, next: stored.next % 10 ** s.digits }
    : { period, next: s.initial };
}
/** Stages a number inside the existing record transaction; preview and draft saves do not call it. */
export function allocateSerialValues(
  schema: FormSchema,
  values: FormValues,
  data: WorkspaceData,
  formId: string,
  now: Date,
  options: { calculate?: boolean } = {},
): { values: FormValues; counters: SerialCounters | undefined } {
  const fields = scopeFields(schema.fields).filter(
    (f) => f.type === "serial" && f.serial,
  );
  if (!fields.length) return { values, counters: data.serialCounters };
  const nextValues = copy(values),
    counters = copy(data.serialCounters || {});
  for (const field of fields) {
    const errors = serialConfigurationErrors(field, schema);
    if (errors.length) throw Error(`「${field.label}」${errors[0]}`);
    const s = field.serial!,
      counter = currentSerialCounter(
        { ...data, serialCounters: counters },
        formId,
        field,
        now,
      );
    nextValues[field.id] = s.rules
      .map((rule) => {
        if (rule.type === "counter")
          return s.fixed
            ? String(counter.next).padStart(s.digits, "0")
            : String(counter.next);
        if (rule.type === "date") return formatSerialDate(rule.format, now);
        if (rule.type === "text") return rule.value;
        const source = serialSourceFields(schema).find(
          (f) => f.id === rule.fieldId,
        )!;
        const value = nextValues[source.id];
        return value == null || value === ""
          ? ""
          : displayValue(source, value, data);
      })
      .join("");
    counters[formId] = {
      ...counters[formId],
      [field.id]: {
        ...counters[formId]?.[field.id],
        [s.reset]: {
          period: counter.period,
          next: (counter.next + 1) % 10 ** s.digits,
        },
      },
    };
  }
  return {
    values:
      options.calculate === false
        ? nextValues
        : resolveCalculations(schema.fields, nextValues),
    counters,
  };
}
/** Never guess a replacement counter when persisted numbering state is damaged. */
export function parseSerialCounters(raw: unknown): SerialCounters {
  const validObject = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === "object" && !Array.isArray(v);
  const safeKey = (key: string) =>
    !!key && !["__proto__", "constructor", "prototype"].includes(key);
  if (!validObject(raw)) throw Error("流水号计数数据无效");
  for (const [formId, fields] of Object.entries(raw)) {
    if (!safeKey(formId) || !validObject(fields))
      throw Error("流水号计数数据无效");
    for (const [fieldId, cycles] of Object.entries(fields)) {
      if (!safeKey(fieldId) || !validObject(cycles))
        throw Error("流水号计数数据无效");
      for (const [cycle, counter] of Object.entries(cycles)) {
        if (
          !["none", "day", "month", "year"].includes(cycle) ||
          !validObject(counter) ||
          typeof counter.period !== "string" ||
          (cycle === "none"
            ? counter.period !== "all"
            : !validDateValue(
                cycle === "day" ? "date" : cycle,
                counter.period,
              )) ||
          !Number.isInteger(counter.next) ||
          Number(counter.next) < 0 ||
          Number(counter.next) >= 1e12
        )
          throw Error("流水号计数数据无效");
      }
    }
  }
  return copy(raw) as SerialCounters;
}
