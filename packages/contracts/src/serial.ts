import type { SerialSettings, SerialRule } from "./form";

export const serialResetCycles = {
  none: "不自动重置",
  day: "每日重置",
  month: "每月重置",
  year: "每年重置",
} as const;
export const serialDateFormats = [
  "yyyy",
  "yyyyMM",
  "yyyy-MM",
  "yyyy/MM",
  "yyyyMMdd",
  "yyyy-MM-dd",
  "yyyy/MM/dd",
  "MMdd",
  "MM-dd",
  "MM/dd",
] as const;
export function defaultSerialSettings(counterId: string): SerialSettings {
  return {
    digits: 5,
    fixed: true,
    reset: "none",
    initial: 1,
    rules: [{ id: counterId, type: "counter" }],
  };
}
/** Structural parsing preserves unfinished settings; publication checks their business validity. */
export function parseSerialSettings(raw: unknown): SerialSettings {
  const s = raw as SerialSettings;
  if (
    !s ||
    typeof s !== "object" ||
    !Number.isFinite(s.digits) ||
    typeof s.fixed !== "boolean" ||
    !Object.hasOwn(serialResetCycles, s.reset) ||
    !Number.isFinite(s.initial) ||
    !Array.isArray(s.rules)
  )
    throw Error("流水号配置无效");
  const ids = new Set<string>();
  const rules = s.rules.map((r): SerialRule => {
    if (!r || typeof r.id !== "string" || !r.id || ids.has(r.id))
      throw Error("流水号规则无效或重复");
    ids.add(r.id);
    if (r.type === "counter") return { id: r.id, type: r.type };
    if (r.type === "text" && typeof r.value === "string")
      return { id: r.id, type: r.type, value: r.value };
    if (r.type === "field" && typeof r.fieldId === "string")
      return { id: r.id, type: r.type, fieldId: r.fieldId };
    if (
      r.type === "date" &&
      ["preset", "custom"].includes(r.mode) &&
      typeof r.format === "string"
    )
      return { id: r.id, type: r.type, mode: r.mode, format: r.format };
    throw Error("流水号规则无效");
  });
  return {
    digits: s.digits,
    fixed: s.fixed,
    reset: s.reset,
    initial: s.initial,
    rules,
  };
}
export function serialSettingsErrors(s: SerialSettings): string[] {
  const errors: string[] = [];
  if (!Number.isInteger(s.digits) || s.digits < 2 || s.digits > 12)
    errors.push("计数位数应为 2～12 的整数");
  if (
    !Number.isInteger(s.initial) ||
    s.initial < 0 ||
    s.initial >= 10 ** s.digits
  )
    errors.push("初始值应为计数位数范围内的非负整数");
  if (s.rules.filter((r) => r.type === "counter").length !== 1)
    errors.push("请保留一条自动计数规则");
  if (s.rules.filter((r) => r.type === "date").length > 1)
    errors.push("提交日期只能添加一次");
  for (const r of s.rules) {
    if (
      r.type === "date" &&
      (!r.format.trim() ||
        (r.mode === "preset" &&
          !(serialDateFormats as readonly string[]).includes(r.format)))
    )
      errors.push("请选择或填写有效的日期格式");
  }
  return errors;
}
export function serialDateParts(now: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return { year: get("year"), month: get("month"), day: get("day") };
}
export function formatSerialDate(format: string, now: Date): string {
  const p = serialDateParts(now);
  return format.replace(/y+|M+|d+/g, (token) => {
    if (token[0] === "y") return token.length === 2 ? p.year.slice(-2) : p.year;
    const value = token[0] === "M" ? p.month : p.day;
    return token.length === 1 ? String(Number(value)) : value;
  });
}
