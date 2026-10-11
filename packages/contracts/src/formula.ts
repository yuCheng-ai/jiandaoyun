import { choiceValueLabel } from "./field-runtime";
import { isNumericField } from "./numbers";
import { dateValueAt, validDateValue } from "./dates";
import { addressText, addressParts, addressKeys, isAddressValue } from "./address";
import { isLocationValue, locationText, locationDistance, type LocationValue } from "./location";
import type { FormField, FormValues, FieldOption, AddressValue } from "./form";

export const formulaTypes = ["text", "textarea", "number", "datetime"];
export const usesFormula = (field: FormField) =>
  field.type === "calculated" ||
  (field.defaultFormula === true && formulaTypes.includes(field.type));
type Value =
  | number
  | string
  | boolean
  | Date
  | AddressValue
  | LocationValue
  | null
  | Value[];
type Node =
  | { kind: "value"; value: Value }
  | { kind: "field"; id: string }
  | { kind: "array"; items: Node[] }
  | { kind: "unary"; op: string; item: Node }
  | { kind: "binary"; op: string; left: Node; right: Node }
  | { kind: "call"; name: string; args: Node[] };
type Token = { text: string; start: number; end: number };
type FunctionDefinition = {
  name: string;
  group: string;
  usage: string;
  description: string;
  min: number;
  max: number;
  returns: string;
  run: (args: Value[], now: Date) => Value;
};
const number = (value: Value): number => {
  if (value === null || value === "") return 0;
  if (typeof value !== "number" || !Number.isFinite(value))
    throw Error("需要数字参数");
  return value;
};
const text = (value: Value): string => {
  if (Array.isArray(value)) throw Error("需要单个文本值");
  if (value instanceof Date)
    return dateValueAt("datetime-second", value).replace("T", " ");
  return value === null ? "" : String(value);
};
const flat = (values: Value[]): Value[] =>
  values.flatMap((v) => (Array.isArray(v) ? flat(v) : [v]));
const numbers = (values: Value[]) => flat(values).map(number);
const timestamp = (value: Value): number => {
  const result =
    value instanceof Date
      ? value.getTime()
      : typeof value === "number"
        ? value
        : NaN;
  if (!Number.isFinite(result)) throw Error("需要有效的日期或时间戳");
  return result;
};
const integer = (value: Value, min = 0, max = 10000) => {
  const n = number(value);
  if (!Number.isInteger(n) || n < min || n > max)
    throw Error("整数参数超出有效范围");
  return n;
};
function datePart(value: Value, part: string) {
  const d = new Date(timestamp(value) + 8 * 3600000);
  return (
    {
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      day: d.getUTCDate(),
      hour: d.getUTCHours(),
      minute: d.getUTCMinutes(),
      second: d.getUTCSeconds(),
    } as Record<string, number>
  )[part]!;
}
function decimalParts(n: number): [string, string] {
  const [mantissa = "0", exponent = "0"] = String(Math.abs(n)).split("e");
  const [whole = "0", fraction = ""] = mantissa.split(".");
  const raw = whole + fraction,
    point = whole.length + Number(exponent);
  const expanded =
    point <= 0
      ? "0." + "0".repeat(-point) + raw
      : point >= raw.length
        ? raw + "0".repeat(point - raw.length)
        : raw.slice(0, point) + "." + raw.slice(point);
  const [integerPart = "0", decimalPart = ""] = expanded.split(".");
  return [integerPart, decimalPart];
}
function chineseNumber(n: number, uppercase: boolean): string {
  const digits = uppercase ? "零壹贰叁肆伍陆柒捌玖" : "零一二三四五六七八九";
  const units = uppercase ? ["", "拾", "佰", "仟"] : ["", "十", "百", "千"];
  const [integerPart, decimalPart] = decimalParts(n);
  if (!Number.isSafeInteger(Number(integerPart)))
    throw Error("数字超出中文格式的有效范围");
  const groups = integerPart.match(/\d{1,4}(?=(?:\d{4})*$)/g) || ["0"];
  let result = "",
    gap = false;
  for (let i = 0; i < groups.length; i++) {
    const group = String(Number(groups[i]));
    if (group === "0") {
      gap = !!result;
      continue;
    }
    if (result && (gap || Number(group) < 1000)) result += digits[0];
    gap = false;
    let part = "",
      zero = false;
    for (let j = 0; j < group.length; j++) {
      const digit = Number(group[j]);
      if (!digit) {
        zero = !!part;
        continue;
      }
      if (zero) part += digits[0];
      part += digits[digit]! + units[group.length - j - 1]!;
      zero = false;
    }
    result += part + ["", "万", "亿", "兆"][groups.length - i - 1]!;
  }
  result ||= digits[0]!;
  if (!uppercase) result = result.replace(/^一十/, "十");
  return (
    (n < 0 ? "负" : "") +
    result +
    (decimalPart
      ? "点" +
        Array.from(decimalPart, (digit) => digits[Number(digit)]).join("")
      : "")
  );
}
function currencyCapital(n: number): string {
  if (n === 0) return "人民币零元整";
  const [whole, fraction] = decimalParts(n);
  const amount = Number(whole),
    digits = "零壹贰叁肆伍陆柒捌玖";
  // Read decimal digits directly; multiplying by 100 can drop a valid cent.
  const jiao = Number(fraction[0] || 0),
    fen = Number(fraction[1] || 0);
  let result = amount
    ? chineseNumber(amount, true).replace("兆", "万亿") + "元"
    : "";
  if (jiao) result += digits[jiao] + "角";
  if (fen) result += (amount && !jiao ? "零" : "") + digits[fen] + "分";
  if (fraction.length <= 1) result += "整";
  return "人民币" + (n < 0 ? "负" : "") + result;
}
function formatText(value: Value, format: string): string {
  // Numeric patterns take precedence: letters in a currency prefix are not date tokens.
  const encoded = /^(.*?)\[Num([012])\]$/.exec(format);
  if (encoded) {
    const n = number(value);
    return (
      encoded[1] +
      (encoded[2] === "0" ? String(n) : chineseNumber(n, encoded[2] === "2"))
    );
  }
  const match = /^(.*?)([0#,]+)(?:\.([0#]+))?(%)?$/.exec(format);
  if (match) {
    const n = number(value);
    const [, prefix, whole, decimal = "", percent] = match;
    if (decimal.length > 8) throw Error("最多保留8位小数");
    let [a, b = ""] = Math.abs(n * (percent ? 100 : 1))
      .toFixed(decimal.length)
      .split(".");
    a = a!.padStart((whole!.match(/0/g) || []).length, "0");
    if (whole!.includes(",")) a = a.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    while (b.endsWith("0") && decimal[b.length - 1] === "#") b = b.slice(0, -1);
    return (
      prefix + (n < 0 ? "-" : "") + a + (b ? "." + b : "") + (percent || "")
    );
  }
  if (/yyyy|yy|MMM|MM|M|dd|d|HH|hh|mm|ss|EEE|EE|E/.test(format)) {
    const stamp = timestamp(value),
      civil = new Date(stamp + 8 * 3600000);
    const pad = (n: number) => String(n).padStart(2, "0");
    const y = civil.getUTCFullYear(),
      month = civil.getUTCMonth() + 1,
      day = civil.getUTCDate(),
      hour = civil.getUTCHours(),
      week = civil.getUTCDay();
    const parts: Record<string, string> = {
      yyyy: String(y).padStart(4, "0"),
      yy: pad(y % 100),
      MMM:
        [
          "一",
          "二",
          "三",
          "四",
          "五",
          "六",
          "七",
          "八",
          "九",
          "十",
          "十一",
          "十二",
        ][month - 1] + "月",
      MM: pad(month),
      M: String(month),
      dd: pad(day),
      d: String(day),
      HH: pad(hour),
      hh: pad(hour % 12 || 12),
      mm: pad(civil.getUTCMinutes()),
      ss: pad(civil.getUTCSeconds()),
      EEE: "星期" + "日一二三四五六"[week],
      EE: "日一二三四五六"[week]!,
      E: String(week),
    };
    return format.replace(
      /yyyy|yy|MMM|MM|M|dd|d|HH|hh|mm|ss|EEE|EE|E/g,
      (token) => parts[token]!,
    );
  }
  throw Error("此文本格式尚不支持");
}
function monthDifference(end: Date, start: Date): number {
  // Use civil months and clamped month-end anchors, preserving the fractional remainder.
  if (end.getUTCDate() < start.getUTCDate())
    return -monthDifference(start, end);
  const whole =
    (start.getUTCFullYear() - end.getUTCFullYear()) * 12 +
    start.getUTCMonth() -
    end.getUTCMonth();
  const anchorAt = (months: number) => {
    const anchor = new Date(end);
    anchor.setUTCDate(1);
    anchor.setUTCMonth(anchor.getUTCMonth() + months);
    const last = new Date(anchor);
    last.setUTCMonth(last.getUTCMonth() + 1, 0);
    anchor.setUTCDate(Math.min(end.getUTCDate(), last.getUTCDate()));
    return anchor.getTime();
  };
  const anchor = anchorAt(whole),
    remaining = start.getTime() - anchor;
  const interval =
    remaining < 0 ? anchor - anchorAt(whole - 1) : anchorAt(whole + 1) - anchor;
  return -(whole + remaining / interval) || 0;
}
function fn(
  name: string,
  group: string,
  usage: string,
  description: string,
  min: number,
  max: number,
  returns: string,
  run: FunctionDefinition["run"],
): FunctionDefinition {
  return { name, group, usage, description, min, max, returns, run };
}
const logic = "逻辑函数",
  words = "文本函数",
  math = "数学函数",
  dates = "日期函数";
const maxFormulaLength = 100000;
export const formulaFunctions: FunctionDefinition[] = [
  fn(
    "IF",
    logic,
    "IF(条件, 成立结果, 不成立结果)",
    "按条件返回两个结果之一",
    3,
    3,
    "branch",
    (a) => (a[0] ? a[1]! : a[2]!),
  ),
  fn(
    "AND",
    logic,
    "AND(条件1, 条件2, …)",
    "所有条件成立",
    1,
    Infinity,
    "boolean",
    (a) => flat(a).every(Boolean),
  ),
  fn(
    "OR",
    logic,
    "OR(条件1, 条件2, …)",
    "任一条件成立",
    1,
    Infinity,
    "boolean",
    (a) => flat(a).some(Boolean),
  ),
  fn("NOT", logic, "NOT(条件)", "条件取反", 1, 1, "boolean", (a) => !a[0]),
  fn("TRUE", logic, "TRUE()", "返回真", 0, 0, "boolean", () => true),
  fn("FALSE", logic, "FALSE()", "返回假", 0, 0, "boolean", () => false),
  fn(
    "CONCATENATE",
    words,
    "CONCATENATE(文本1, 文本2, …)",
    "合并多个文本",
    1,
    Infinity,
    "string",
    (a) => flat(a).map(text).join(""),
  ),
  fn(
    "TEXTPHONE",
    "高级函数",
    'TEXTPHONE(手机, "phone"或"verified")',
    "提取手机号或短信验证状态（0未验证，1已验证）",
    2,
    2,
    "phone-result",
    (a) => {
      if (a[1] !== "phone" && a[1] !== "verified")
        throw Error("返回内容须为phone或verified");
      if (a[0] !== null && typeof a[0] !== "string")
        throw Error("需要手机字段参数");
      // Existing phone strings carry no SMS proof. Never infer verification from their format.
      return a[1] === "phone" ? a[0] || "" : 0;
    },
  ),
  fn(
    "TEXTLOCATION",
    words,
    'TEXTLOCATION(定位, "address")',
    "提取定位或地址中的完整地址、省、市、区、详细地址或经纬度",
    2,
    2,
    "string",
    (a) => {
      const key = text(a[1]!);
      if (
        key !== "address" &&
        key !== "lng" &&
        key !== "lat" &&
        !addressKeys.includes(key as (typeof addressKeys)[number])
      )
        throw Error(
          "地址格式须为address、province、city、district、detail、lng或lat",
        );
      if (a[0] == null || a[0] === "") return "";
      if (isLocationValue(a[0])) {
        if (key === "lng" || key === "lat") return String(a[0][key]);
        return key === "address"
          ? locationText(a[0])
          : a[0][key as keyof AddressValue] || "";
      }
      if (!isAddressValue(a[0])) throw Error("需要定位或地址字段参数");
      if (key === "lng" || key === "lat")
        throw Error("地址格式不支持经纬度，请使用定位字段");
      return key === "address"
        ? addressText(a[0])
        : a[0][key as keyof AddressValue] || "";
    },
  ),
  fn(
    "DISTANCE",
    "数学函数",
    "DISTANCE(定位1, 定位2)",
    "计算两个定位之间的直线距离，单位为米",
    2,
    2,
    "number",
    (a) => {
      if (!isLocationValue(a[0]) || !isLocationValue(a[1]))
        throw Error("需要有效的定位参数");
      return locationDistance(a[0], a[1]);
    },
  ),
  fn(
    "CHAR",
    words,
    "CHAR(数字代码)",
    "返回换行等特殊字符",
    1,
    1,
    "string",
    (a) => {
      const n = integer(a[0]!);
      if (![9, 10, 34, 39, 92].includes(n))
        throw Error("仅支持9、10、34、39、92");
      return String.fromCharCode(n);
    },
  ),
  fn(
    "EXACT",
    words,
    "EXACT(文本1, 文本2)",
    "区分大小写比较文本",
    2,
    2,
    "boolean",
    (a) => text(a[0]!) === text(a[1]!),
  ),
  fn(
    "ISEMPTY",
    words,
    "ISEMPTY(值)",
    "判断空文本或空数组",
    1,
    1,
    "boolean",
    (a) =>
      a[0] === null || a[0] === "" || (Array.isArray(a[0]) && !a[0].length),
  ),
  fn(
    "JOIN",
    words,
    "JOIN(数组, 连接符)",
    "用连接符组合数组",
    2,
    2,
    "string",
    (a) => {
      if (!Array.isArray(a[0])) throw Error("第一个参数需要数组");
      return a[0].map(text).join(text(a[1]!));
    },
  ),
  fn(
    "LEFT",
    words,
    "LEFT(文本, 字符数)",
    "提取左侧字符，默认1个",
    1,
    2,
    "string",
    (a) => text(a[0]!).slice(0, a.length === 2 ? integer(a[1]!) : 1),
  ),
  fn(
    "RIGHT",
    words,
    "RIGHT(文本, 字符数)",
    "提取右侧字符，默认1个",
    1,
    2,
    "string",
    (a) => {
      const n = a.length === 2 ? integer(a[1]!) : 1;
      return n ? text(a[0]!).slice(-n) : "";
    },
  ),
  fn(
    "MID",
    words,
    "MID(文本, 开始位置, 字符数)",
    "从指定位置提取字符",
    3,
    3,
    "string",
    (a) => {
      const start = integer(a[1]!, 1) - 1;
      return text(a[0]!).slice(start, start + integer(a[2]!));
    },
  ),
  fn(
    "LEN",
    words,
    "LEN(文本)",
    "统计字符个数",
    1,
    1,
    "number",
    (a) => text(a[0]!).length,
  ),
  fn(
    "REPLACE",
    words,
    "REPLACE(原文本, 开始位置, 字符数, 新文本)",
    "替换指定位置的文本，位置从1开始",
    4,
    4,
    "string",
    (a) => {
      const value = text(a[0]!);
      const start = integer(a[1]!, 1, Number.MAX_SAFE_INTEGER) - 1;
      const count = integer(a[2]!, 0, Number.MAX_SAFE_INTEGER);
      return value.slice(0, start) + text(a[3]!) + value.slice(start + count);
    },
  ),
  fn("REPT", words, "REPT(文本, 重复次数)", "重复文本", 2, 2, "string", (a) => {
    const value = text(a[0]!),
      times = number(a[1]!);
    if (times < 0) throw Error("重复次数不能为负数");
    const count = Math.floor(times);
    if (value.length * count > maxFormulaLength)
      throw Error("重复结果超过100000字符");
    return value ? value.repeat(count) : "";
  }),
  fn(
    "RMBCAP",
    words,
    "RMBCAP(金额)",
    "将金额转换为人民币大写；只到分位，多余小数直接舍弃",
    1,
    1,
    "string",
    (a) => currencyCapital(number(a[0]!)),
  ),
  fn(
    "SEARCH",
    words,
    "SEARCH(查找文本, 原文本, 开始位置)",
    "查找文本的位置；忽略英文字母大小写，位置从1开始，未找到返回0，开始位置默认1",
    2,
    3,
    "number",
    (a) => {
      const fold = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
      const start =
        a.length === 3 ? integer(a[2]!, 1, Number.MAX_SAFE_INTEGER) : 1;
      const value = fold(text(a[1]!));
      return start > value.length + 1
        ? 0
        : value.indexOf(fold(text(a[0]!)), start - 1) + 1;
    },
  ),
  fn(
    "UNION",
    words,
    "UNION(文本1, 文本2, …) 或 UNION(数组)",
    "剔除重复值并返回数组",
    1,
    Infinity,
    "array",
    (a) => [...new Set(flat(a))],
  ),
  fn("LOWER", words, "LOWER(文本)", "转为小写", 1, 1, "string", (a) =>
    text(a[0]!).toLowerCase(),
  ),
  fn("UPPER", words, "UPPER(文本)", "转为大写", 1, 1, "string", (a) =>
    text(a[0]!).toUpperCase(),
  ),
  fn("TRIM", words, "TRIM(文本)", "清理首尾及重复空格", 1, 1, "string", (a) =>
    text(a[0]!).trim().replace(/ +/g, " "),
  ),
  fn("SPLIT", words, "SPLIT(文本, 分隔符)", "拆分为数组", 2, 2, "array", (a) =>
    text(a[0]!).split(text(a[1]!)),
  ),
  fn(
    "VALUE",
    words,
    "VALUE(文本)",
    "将数字文本转换为数字",
    1,
    1,
    "number",
    (a) => {
      const s = text(a[0]!).trim();
      if (!s || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(s))
        throw Error("文本不是有效数字");
      return Number(s);
    },
  ),
  fn(
    "TEXT",
    words,
    "TEXT(数字或日期, 格式)",
    "按格式生成文本",
    2,
    2,
    "string",
    (a) => formatText(a[0]!, text(a[1]!)),
  ),
  fn("ABS", math, "ABS(数字)", "返回绝对值", 1, 1, "number", (a) =>
    Math.abs(number(a[0]!)),
  ),
  fn(
    "SUM",
    math,
    "SUM(数字1, 数字2, …)",
    "求和，支持子表列",
    1,
    Infinity,
    "number",
    (a) => numbers(a).reduce((s, n) => s + n, 0),
  ),
  fn(
    "PRODUCT",
    math,
    "PRODUCT(数字1, 数字2, …)",
    "求乘积",
    1,
    Infinity,
    "number",
    (a) => numbers(a).reduce((s, n) => s * n, 1),
  ),
  fn(
    "AVERAGE",
    math,
    "AVERAGE(数字1, 数字2, …)",
    "求算术平均值",
    1,
    Infinity,
    "number",
    (a) => {
      const list = numbers(a);
      if (!list.length) throw Error("没有可计算的数字");
      return list.reduce((s, n) => s + n, 0) / list.length;
    },
  ),
  fn(
    "MIN",
    math,
    "MIN(数字1, 数字2, …)",
    "取最小值",
    1,
    Infinity,
    "number",
    (a) => Math.min(...numbers(a)),
  ),
  fn(
    "MAX",
    math,
    "MAX(数字1, 数字2, …)",
    "取最大值",
    1,
    Infinity,
    "number",
    (a) => Math.max(...numbers(a)),
  ),
  fn(
    "COUNT",
    math,
    "COUNT(值1, 值2, …)",
    "统计参数个数",
    1,
    Infinity,
    "number",
    (a) => flat(a).length,
  ),
  fn(
    "ROUND",
    math,
    "ROUND(数字, 小数位数)",
    "四舍五入",
    2,
    2,
    "number",
    (a) => {
      const n = number(a[0]!),
        p = integer(a[1]!, -8, 8),
        scale = 10 ** p;
      return (
        (Math.sign(n) * Math.round((Math.abs(n) + Number.EPSILON) * scale)) /
        scale
      );
    },
  ),
  fn("INT", math, "INT(数字)", "向下取整", 1, 1, "number", (a) =>
    Math.floor(number(a[0]!)),
  ),
  fn("MOD", math, "MOD(数字, 除数)", "返回余数", 2, 2, "number", (a) => {
    const n = number(a[0]!),
      d = number(a[1]!);
    if (!d) throw Error("除数不能为0");
    return n - d * Math.floor(n / d);
  }),
  fn(
    "POWER",
    math,
    "POWER(数字, 指数)",
    "乘幂",
    2,
    2,
    "number",
    (a) => number(a[0]!) ** number(a[1]!),
  ),
  fn("SQRT", math, "SQRT(数字)", "平方根", 1, 1, "number", (a) =>
    Math.sqrt(number(a[0]!)),
  ),
  fn(
    "DATE",
    dates,
    "DATE(时间戳) / DATE(年, 月, 日)",
    "生成日期对象",
    1,
    6,
    "date",
    (a) => {
      if (a.length === 1) return new Date(timestamp(a[0]!));
      if (![3, 6].includes(a.length)) throw Error("需要1、3或6个参数");
      const year = integer(a[0]!, 1, 9999),
        m = integer(a[1]!, 1, 12),
        d = integer(a[2]!, 1, 31);
      const h = a.length === 6 ? integer(a[3]!, 0, 23) : 0,
        minute = a.length === 6 ? integer(a[4]!, 0, 59) : 0,
        sec = a.length === 6 ? integer(a[5]!, 0, 59) : 0;
      const value =
        String(year).padStart(4, "0") +
        "-" +
        String(m).padStart(2, "0") +
        "-" +
        String(d).padStart(2, "0");
      if (!validDateValue("date", value)) throw Error("日期不合法");
      return new Date(
        value +
          "T" +
          [h, minute, sec].map((n) => String(n).padStart(2, "0")).join(":") +
          "+08:00",
      );
    },
  ),
  fn(
    "DATEDELTA",
    dates,
    "DATEDELTA(日期, 天数)",
    "日期增加或减少天数",
    2,
    2,
    "date",
    (a) => new Date(timestamp(a[0]!) + number(a[1]!) * 86400000),
  ),
  fn(
    "DAYS",
    dates,
    "DAYS(结束日期, 开始日期)",
    "计算相差天数",
    2,
    2,
    "number",
    (a) => (timestamp(a[0]!) - timestamp(a[1]!)) / 86400000,
  ),
  fn(
    "DATEDIF",
    dates,
    "DATEDIF(开始日期, 结束日期, [单位])",
    "计算两个时间的差值；单位：y年、M月、d天、h时、m分、s秒，默认d",
    2,
    3,
    "number",
    (a) => {
      const start = timestamp(a[0]!),
        end = timestamp(a[1]!);
      if (end < start) throw Error("结束日期不能早于开始日期");
      const unit = a.length === 3 ? text(a[2]!) : "d";
      if (unit === "y" || unit === "M") {
        const months = monthDifference(
          new Date(end + 8 * 3600000),
          new Date(start + 8 * 3600000),
        );
        return unit === "y" ? months / 12 : months;
      }
      if (!["d", "h", "m", "s"].includes(unit))
        throw Error("单位须为y、M、d、h、m或s");
      const scale = { d: 86400000, h: 3600000, m: 60000, s: 1000 }[
        unit as "d" | "h" | "m" | "s"
      ];
      return (end - start) / scale;
    },
  ),
  fn(
    "TIMESTAMP",
    dates,
    "TIMESTAMP(日期)",
    "将日期转为毫秒时间戳",
    1,
    1,
    "number",
    (a) => timestamp(a[0]!),
  ),
  fn(
    "TIME",
    dates,
    "TIME(小时, 分钟, 秒)",
    "将时间转换为一天的比例，支持超过24小时",
    3,
    3,
    "number",
    (a) => (number(a[0]!) * 3600 + number(a[1]!) * 60 + number(a[2]!)) / 86400,
  ),
  fn(
    "NOW",
    dates,
    "NOW()",
    "返回当前时间",
    0,
    0,
    "date",
    (_, now) => new Date(now),
  ),
  fn(
    "TODAY",
    dates,
    "TODAY()",
    "返回今天的日期",
    0,
    0,
    "date",
    (_, now) => new Date(dateValueAt("date", now) + "T00:00:00+08:00"),
  ),
  ...["YEAR", "MONTH", "DAY", "HOUR", "MINUTE", "SECOND"].map((name) =>
    fn(
      name,
      dates,
      name + "(日期)",
      "提取日期的" +
        (
          {
            YEAR: "年",
            MONTH: "月",
            DAY: "日",
            HOUR: "时",
            MINUTE: "分",
            SECOND: "秒",
          } as Record<string, string>
        )[name],
      1,
      1,
      "number",
      (a) => datePart(a[0]!, name.toLowerCase()),
    ),
  ),
];
const functions = new Map(formulaFunctions.map((item) => [item.name, item]));
const calculatedExcludedFunctions = new Set([
  "GETUSERNAME",
  "MAPX",
  "RECNO",
  "TEXTDEPT",
  "TEXTUSER",
  "UUID",
  "AVERAGE",
  "COUNT",
  "COUNTIF",
  "LARGE",
  "FIXED",
  "PRODUCT",
  "RAND",
  "SMALL",
  "SUM",
  "SUMIF",
  "SUMIFS",
  "SUMPRODUCT",
  "IP",
]);
export function formulaFunctionsFor(field?: FormField) {
  return field?.type === "calculated"
    ? formulaFunctions
        .filter(
          (item) =>
            item.group !== "日期函数" &&
            !calculatedExcludedFunctions.has(item.name),
        )
        .map((item) =>
          item.name === "TEXT" ? { ...item, usage: "TEXT(数字, 格式)" } : item,
        )
    : formulaFunctions;
}
const calculatedArguments: Record<string, string[]> = {
  IF: ["boolean", "any", "any"],
  AND: ["boolean"],
  OR: ["boolean"],
  NOT: ["boolean"],
  CONCATENATE: ["string"],
  EXACT: ["string", "string"],
  JOIN: ["array", "string"],
  LEFT: ["string", "number"],
  RIGHT: ["string", "number"],
  MID: ["string", "number", "number"],
  LEN: ["string"],
  REPLACE: ["string", "number", "number", "string"],
  REPT: ["string", "number"],
  SEARCH: ["string", "string", "number"],
  LOWER: ["string"],
  UPPER: ["string"],
  TRIM: ["string"],
  SPLIT: ["string", "string"],
  VALUE: ["string"],
  TEXT: ["number", "string"],
  RMBCAP: ["number"],
  CHAR: ["number"],
  ABS: ["number"],
  MIN: ["number"],
  MAX: ["number"],
  ROUND: ["number", "number"],
  INT: ["number"],
  MOD: ["number", "number"],
  POWER: ["number", "number"],
  SQRT: ["number"],
  TEXTPHONE: ["string", "string"],
  TEXTLOCATION: ["object", "string"],
  DISTANCE: ["object", "object"],
};
const calculatedIntegerArguments: Record<string, [number, number, number][]> = {
  LEFT: [[1, 0, 10000]],
  RIGHT: [[1, 0, 10000]],
  MID: [
    [1, 1, 10000],
    [2, 0, 10000],
  ],
  REPLACE: [
    [1, 1, Number.MAX_SAFE_INTEGER],
    [2, 0, Number.MAX_SAFE_INTEGER],
  ],
  REPT: [[1, 0, Number.MAX_SAFE_INTEGER]],
  SEARCH: [[2, 1, Number.MAX_SAFE_INTEGER]],
  CHAR: [[0, 0, 10000]],
  ROUND: [[1, -8, 8]],
};
const argumentType = (name: string, index: number) => {
  const types = calculatedArguments[name];
  return types?.[index] || (types?.length === 1 ? types[0] : "any");
};
const argumentError = (name: string, index: number, type: string) =>
  `${name}：第${index + 1}个参数需要${({ boolean: "布尔值", string: "文本", number: "数字", array: "文本数组", object: "地址或定位" } as Record<string, string>)[type]}`;
export function formulaTokens(expression: string): Token[] {
  if (
    expression.length > maxFormulaLength ||
    expression.split("\n").length > 2000 ||
    expression.split("\n").some((line) => line.length > 10000)
  )
    throw Error("公式内容过长");
  const tokens: Token[] = [];
  let start = 0;
  while (start < expression.length) {
    if (/\s/.test(expression[start]!)) {
      start++;
      continue;
    }
    if (expression.startsWith("/*", start)) {
      const end = expression.indexOf("*/", start + 2);
      if (end < 0) throw Error("公式注释未结束");
      start = end + 2;
      continue;
    }
    const match =
      /^(\{\{[a-zA-Z0-9_.:-]+\}\}|"(?:[^"\\]|\\["\\nrt])*"|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[A-Za-z_][A-Za-z_0-9]*|==|!=|>=|<=|[+*/(),\[\]<>-])/.exec(
        expression.slice(start),
      );
    if (!match)
      throw Error("第" + (start + 1) + "个字符不合法，请使用英文标点");
    tokens.push({ text: match[0], start, end: start + match[0].length });
    start += match[0].length;
  }
  return tokens;
}
export function formulaReferences(expression: string): string[] {
  try {
    return [
      ...new Set(
        formulaTokens(expression)
          .filter((t) => t.text.startsWith("{{"))
          .map((t) => t.text.slice(2, -2)),
      ),
    ];
  } catch {
    return [];
  }
}
export function replaceFormulaReferences(
  expression: string,
  mapping: Map<string, string>,
) {
  let tokens: Token[];
  try {
    tokens = formulaTokens(expression);
  } catch {
    return expression;
  }
  let output = "",
    end = 0;
  for (const token of tokens)
    if (token.text.startsWith("{{")) {
      const id = token.text.slice(2, -2);
      output +=
        expression.slice(end, token.start) +
        "{{" +
        (mapping.get(id) || id) +
        "}}";
      end = token.end;
    }
  return output + expression.slice(end);
}
function parse(expression: string): Node {
  const tokens = formulaTokens(expression);
  let index = 0,
    depth = 0;
  const peek = () => tokens[index]?.text;
  const expect = (value: string) => {
    if (peek() !== value) throw Error("缺少 " + value);
    index++;
  };
  function atom(): Node {
    if (++depth > 100) throw Error("公式嵌套过深");
    try {
      const token = tokens[index++]?.text;
      if (!token) throw Error("公式不完整");
      if (token === "+" || token === "-")
        return { kind: "unary", op: token, item: atom() };
      if (token === "(") {
        const item = comparison();
        expect(")");
        return item;
      }
      if (token === "[") {
        const items: Node[] = [];
        if (peek() !== "]") {
          items.push(comparison());
          while (peek() === ",") {
            index++;
            items.push(comparison());
          }
        }
        expect("]");
        return { kind: "array", items };
      }
      if (token.startsWith("{{"))
        return { kind: "field", id: token.slice(2, -2) };
      if (token.startsWith('"'))
        return { kind: "value", value: JSON.parse(token) };
      if (/^\d|^\./.test(token)) return { kind: "value", value: Number(token) };
      if (/^(true|false)$/i.test(token) && peek() !== "(")
        return { kind: "value", value: token.toLowerCase() === "true" };
      const name = token.toUpperCase(),
        definition = functions.get(name);
      if (!definition) throw Error("不支持的函数：" + token);
      expect("(");
      const args: Node[] = [];
      if (peek() !== ")") {
        args.push(comparison());
        while (peek() === ",") {
          index++;
          args.push(comparison());
        }
      }
      expect(")");
      if (
        args.length < definition.min ||
        args.length > definition.max ||
        (name === "DATE" && ![1, 3, 6].includes(args.length))
      )
        throw Error(name + "：参数个数不符合要求");
      return { kind: "call", name, args };
    } finally {
      depth--;
    }
  }
  function product(): Node {
    let left = atom();
    while (peek() === "*" || peek() === "/") {
      const op = tokens[index++]!.text;
      left = { kind: "binary", op, left, right: atom() };
    }
    return left;
  }
  function sum(): Node {
    let left = product();
    while (peek() === "+" || peek() === "-") {
      const op = tokens[index++]!.text;
      left = { kind: "binary", op, left, right: product() };
    }
    return left;
  }
  function comparison(): Node {
    let left = sum();
    while (["==", "!=", ">", "<", ">=", "<="].includes(peek() || "")) {
      const op = tokens[index++]!.text;
      left = { kind: "binary", op, left, right: sum() };
    }
    return left;
  }
  const node = comparison();
  if (index !== tokens.length) throw Error("公式语法错误");
  return node;
}
export function formulaSyntaxError(expression: string): string {
  try {
    parse(expression);
    return "";
  } catch (error) {
    return (error as Error).message;
  }
}
export function evaluateFormula(
  expression: string,
  values: Record<string, Value>,
  now = new Date(),
  failed?: ReadonlySet<string>,
  calculated = false,
): { value: Value; error: string } {
  function run(node: Node): Value {
    if (node.kind === "value") return node.value;
    if (node.kind === "field") {
      if (failed?.has(node.id)) throw Error("引用字段的公式未计算成功");
      const value = values[node.id] ?? null;
      if (
        flat([value]).some((v) => typeof v === "number" && !Number.isFinite(v))
      )
        throw Error("引用字段需要有效数字");
      return value;
    }
    if (node.kind === "array") return node.items.map(run);
    if (node.kind === "unary")
      return (node.op === "-" ? -1 : 1) * number(run(node.item));
    if (node.kind === "call") {
      // Unused conditional branches must not evaluate errors such as division by zero.
      if (node.name === "IF") {
        const condition = run(node.args[0]!);
        if (calculated && typeof condition !== "boolean")
          throw Error(argumentError("IF", 0, "boolean"));
        return condition ? run(node.args[1]!) : run(node.args[2]!);
      }
      try {
        const args = node.args.map(run);
        if (calculated) {
          args.forEach((value, index) => {
            const type = argumentType(node.name, index);
            if (
              type === "any" ||
              (value === null && ["string", "number", "object"].includes(type))
            )
              return;
            if (
              type === "array"
                ? !Array.isArray(value) ||
                  flat(value).some((v) => typeof v !== "string")
                : typeof value !== type
            )
              throw Error(argumentError(node.name, index, type));
          });
          if (
            calculatedIntegerArguments[node.name]?.some(([index, min, max]) => {
              if (index >= args.length) return false;
              const value = number(args[index]!);
              return !Number.isInteger(value) || value < min || value > max;
            })
          )
            return null;
        }
        return functions.get(node.name)!.run(args, now);
      } catch (error) {
        const message = (error as Error).message;
        throw Error(
          message.startsWith(node.name + "：")
            ? message
            : node.name + "：" + message,
        );
      }
    }
    const a = run(node.left),
      b = run(node.right);
    if (["+", "-", "*", "/"].includes(node.op)) {
      const n = number(a),
        m = number(b);
      if (node.op === "/" && m === 0) throw Error("除数不能为0");
      return node.op === "+"
        ? n + m
        : node.op === "-"
          ? n - m
          : node.op === "*"
            ? n * m
            : n / m;
    }
    const left = a instanceof Date ? timestamp(a) : a,
      right = b instanceof Date ? timestamp(b) : b;
    if (Array.isArray(left) || Array.isArray(right))
      throw Error("比较需要单个值");
    if (node.op === "==" || node.op === "!=") {
      const equal =
        !calculated &&
        ((typeof left === "boolean" && typeof right === "number") ||
          (typeof right === "boolean" && typeof left === "number"))
          ? Number(left) === Number(right)
          : left === right;
      return node.op === "==" ? equal : !equal;
    }
    if (left === null || right === null) return false;
    return node.op === ">"
      ? left > right
      : node.op === "<"
        ? left < right
        : node.op === ">="
          ? left >= right
          : left <= right;
  }
  try {
    const value = run(parse(expression));
    if (
      (typeof value === "number" && !Number.isFinite(value)) ||
      (value instanceof Date && !Number.isFinite(value.getTime()))
    )
      throw Error("计算结果无效");
    return { value, error: "" };
  } catch (error) {
    return { value: null, error: (error as Error).message };
  }
}
export type FormulaField = { field: FormField; label: string; column?: string };
/** Main expressions can aggregate detail columns; a detail expression sees only its row and the main form. */
export function formulaFields(
  fields: FormField[],
  targetId = "",
  calculated = false,
): FormulaField[] {
  const scope = (items: FormField[]): FormField[] =>
    items.flatMap((f) => (f.type === "tabs" ? scope(f.children) : [f]));
  const main = scope(fields),
    owner = main.find(
      (f) =>
        f.type === "subform" &&
        scope(f.children).some((c) => c.id === targetId),
    );
  const supported = (f: FormField) =>
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
      "phone",
      "serial",
      "location",
      "address",
      ...(calculated ? ["member", "members", "department", "departments"] : []),
    ].includes(f.type) &&
    (!calculated || f.type !== "datetime");
  return [
    ...main.filter(supported).map((field) => ({ field, label: field.label })),
    ...main
      .filter(
        (f) =>
          !calculated && f.type === "subform" && (!owner || f.id === owner.id),
      )
      .flatMap((parent) =>
        scope(parent.children)
          .filter(supported)
          .map((field) => ({
            field,
            label: parent.label + "." + field.label,
            ...(!owner ? { column: parent.id } : {}),
          })),
      ),
  ];
}
function phoneArgumentError(node: Node, available: FormulaField[]): string {
  function phoneSource(value: Node): boolean {
    if (value.kind === "field")
      return available.some(
        (item) =>
          item.field.id === value.id &&
          item.field.type === "phone" &&
          !item.column,
      );
    return (
      value.kind === "call" &&
      value.name === "IF" &&
      phoneSource(value.args[1]!) &&
      phoneSource(value.args[2]!)
    );
  }
  const pending = [node];
  while (pending.length) {
    const item = pending.pop()!;
    if (item.kind === "call") {
      if (item.name === "TEXTPHONE") {
        if (!phoneSource(item.args[0]!))
          return "TEXTPHONE：需要单个手机字段参数";
        const selector = item.args[1]!;
        if (
          selector.kind === "value" &&
          selector.value !== "phone" &&
          selector.value !== "verified"
        )
          return "TEXTPHONE：返回内容须为phone或verified";
      }
      pending.push(...item.args.slice().reverse());
    } else if (item.kind === "binary") pending.push(item.right, item.left);
    else if (item.kind === "unary") pending.push(item.item);
    else if (item.kind === "array")
      pending.push(...item.items.slice().reverse());
  }
  return "";
}
/** Checks the shared grammar, field scope and possible return types. */
export function formulaExpressionErrors(
  expression: string,
  fields: FormField[],
  config: {
    targetId?: string;
    returns?: "number" | "string" | "date" | "boolean";
    calculated?: boolean;
  } = {},
): string[] {
  try {
    const node = parse(expression),
      available = formulaFields(fields, config.targetId, config.calculated);
    for (const id of formulaReferences(expression)) {
      if (id === config.targetId) return ["公式不能引用当前字段"];
      if (!available.some((item) => item.field.id === id))
        return ["公式引用字段已失效或不在当前范围"];
    }
    if (/\bTEXTPHONE\s*\(/i.test(expression)) {
      const phoneError = phoneArgumentError(node, available);
      if (phoneError) return [phoneError];
    }
    function types(node: Node): string[] {
      if (node.kind === "value")
        return [
          Array.isArray(node.value)
            ? "array"
            : node.value === null
              ? "null"
              : typeof node.value,
        ];
      if (node.kind === "field") {
        const item = available.find((f) => f.field.id === node.id)!;
        return [
          item.column ||
          ["checkbox", "multiselect", "members", "departments"].includes(
            item.field.type,
          )
            ? "array"
            : isNumericField(item.field) || item.field.type === "datetime"
              ? "number"
              : ["address", "location"].includes(item.field.type)
                ? "object"
                : "string",
        ];
      }
      if (node.kind === "array") return ["array"];
      if (node.kind === "unary") return ["number"];
      if (node.kind === "binary")
        return [["+", "-", "*", "/"].includes(node.op) ? "number" : "boolean"];
      if (node.name === "TEXTPHONE") {
        const selector = node.args[1]!;
        return selector.kind === "value"
          ? [selector.value === "verified" ? "number" : "string"]
          : ["string", "number"];
      }
      return node.name === "IF"
        ? [...types(node.args[1]!), ...types(node.args[2]!)]
        : [functions.get(node.name)!.returns];
    }
    if (config.calculated) {
      const pending = [node];
      while (pending.length) {
        const item = pending.pop()!;
        if (item.kind === "call") {
          if (
            functions.get(item.name)!.group === "日期函数" ||
            calculatedExcludedFunctions.has(item.name)
          )
            return ["计算字段不支持函数：" + item.name];
          for (let index = 0; index < item.args.length; index++) {
            const type = argumentType(item.name, index);
            if (
              type !== "any" &&
              types(item.args[index]!).some((value) => value !== type)
            )
              return [argumentError(item.name, index, type)];
          }
          pending.push(...item.args);
        } else if (item.kind === "binary") {
          if (
            ["+", "-", "*", "/"].includes(item.op) &&
            [item.left, item.right].some((arg) =>
              types(arg).some((type) => type !== "number"),
            )
          )
            return ["算术运算需要数字参数；文本连接请使用CONCATENATE"];
          pending.push(item.left, item.right);
        } else if (item.kind === "unary") {
          if (types(item.item).some((type) => type !== "number"))
            return ["算术运算需要数字参数"];
          pending.push(item.item);
        } else if (item.kind === "array") pending.push(...item.items);
      }
    }
    const returns = types(node);
    if (config.returns === "number" && returns.some((t) => t !== "number"))
      return ["公式需要返回数字"];
    if (config.returns === "string" && returns.some((t) => t !== "string"))
      return ["公式需要返回文本"];
    if (
      config.returns === "date" &&
      returns.some((t) => t !== "date" && t !== "number")
    )
      return ["公式需要返回日期或时间戳"];
    if (config.returns === "boolean" && returns.some((t) => t !== "boolean"))
      return ["校验条件需要返回真或假，请使用比较符号或逻辑函数"];
    return [];
  } catch (error) {
    return [(error as Error).message];
  }
}
export function formulaConfigurationErrors(
  field: FormField,
  fields: FormField[],
): string[] {
  if (!formulaTypes.includes(field.type) && field.type !== "calculated")
    return ["此字段不支持公式默认值"];
  if (field.defaultFormula && field.defaultLink?.enabled)
    return ["默认值不能同时使用公式与数据联动"];
  return formulaExpressionErrors(field.expression, fields, {
    targetId: field.id,
    calculated: field.type === "calculated" && field.calculationVersion === 1,
    returns: isNumericField(field)
      ? "number"
      : field.type === "calculated"
        ? "string"
        : field.type === "datetime"
          ? "date"
          : undefined,
  });
}
function civilTimestamp(field: FormField, value: unknown): Value {
  if (!value) return null;
  if (!validDateValue(field.format, value)) throw Error("引用日期不合法");
  const s = String(value);
  return new Date(
    (s.length === 7 ? s + "-01" : s.length === 10 ? s : s.slice(0, 10)) +
      "T" +
      (s.length >= 16 ? s.slice(11) : "00:00:00") +
      "+08:00",
  ).getTime();
}
/** Uses actual field types for both defaults and whole-form conditions. */
export function evaluateFieldFormula(
  expression: string,
  fields: FormField[],
  values: FormValues,
  config: {
    targetId?: string;
    options?: (field: FormField) => FieldOption[];
    now?: Date;
    failed?: ReadonlySet<string>;
    legacyNumbers?: boolean;
    strictCalculated?: boolean;
    calculated?: boolean;
  } = {},
): { value: Value; error: string } {
  try {
    if (config.calculated) {
      const errors = formulaExpressionErrors(expression, fields, {
        targetId: config.targetId,
        calculated: true,
      });
      if (errors.length) throw Error(errors[0]);
    }
    const available = formulaFields(fields, config.targetId, config.calculated),
      converted: Record<string, Value> = {};
    if (/\bTEXTPHONE\s*\(/i.test(expression)) {
      const error = phoneArgumentError(parse(expression), available);
      if (error) throw Error(error);
    }
    for (const id of formulaReferences(expression)) {
      if (config.failed?.has(id)) continue;
      const source = available.find((item) => item.field.id === id);
      if (!source) {
        // Legacy calculated rows may supply parent values without their schema.
        if (!config.legacyNumbers) throw Error("引用字段已失效或不在当前范围");
        converted[id] = Number(values[id] || 0);
        continue;
      }
      function convert(raw: unknown): Value {
        const f = source!.field;
        if (f.type === "phone" && raw != null && typeof raw !== "string")
          throw Error("引用字段需要有效手机值");
        if (f.type === "location") {
          if (raw == null || raw === "") return null;
          if (!isLocationValue(raw)) throw Error("引用字段需要有效定位");
          return raw;
        }
        if (f.type === "address") {
          if (raw == null || raw === "") return {};
          if (!isAddressValue(raw)) throw Error("引用字段需要有效地址");
          return Object.fromEntries(
            addressParts(f).map((key) => [key, raw[key] || ""]),
          );
        }
        if (f.type === "datetime") return civilTimestamp(f, raw);
        if (["radio", "select"].includes(f.type))
          return raw
            ? choiceValueLabel(config.options?.(f) || f.options, raw)
            : "";
        if (["members", "departments"].includes(f.type))
          return Array.isArray(raw) ? raw.map((value) => String(value)) : [];
        if (["checkbox", "multiselect"].includes(f.type))
          return Array.isArray(raw)
            ? raw.map((v) =>
                choiceValueLabel(config.options?.(f) || f.options, v),
              )
            : [];
        if (isNumericField(f)) {
          if (config.strictCalculated && f.type === "calculated" && raw == null)
            return NaN;
          if (raw === "" || raw === null || raw === undefined) return null;
          const value = config.legacyNumbers ? Number(raw) : raw;
          return typeof value === "number" ? value : NaN;
        }
        return String(raw ?? "");
      }
      converted[id] = source.column
        ? (
            (Array.isArray(values[source.column])
              ? values[source.column]
              : []) as FormValues[]
          ).map((row) => convert(row[id]))
        : convert(values[id]);
    }
    return evaluateFormula(
      expression,
      converted,
      config.now,
      config.failed,
      config.calculated,
    );
  } catch (error) {
    return { value: null, error: (error as Error).message };
  }
}
export function formulaValue(
  field: FormField,
  fields: FormField[],
  values: FormValues,
  options?: (field: FormField) => FieldOption[],
  now = new Date(),
  failed?: ReadonlySet<string>,
): { value: unknown; error: string } {
  try {
    const result = evaluateFieldFormula(field.expression, fields, values, {
      targetId: field.id,
      options,
      now,
      failed,
      legacyNumbers:
        field.type === "calculated" &&
        isNumericField(field) &&
        field.calculationVersion !== 1,
      calculated: field.type === "calculated" && field.calculationVersion === 1,
    });
    if (result.error) throw Error(result.error);
    if (field.calculationVersion === 1 && result.value === null) return result;
    if (isNumericField(field)) {
      if (typeof result.value !== "number") throw Error("公式需要返回数字");
      return result;
    }
    if (field.type === "calculated") {
      if (typeof result.value !== "string") throw Error("公式需要返回文本");
      return result;
    }
    if (field.type === "datetime") {
      const value = dateValueAt(
        field.format,
        new Date(timestamp(result.value)),
      );
      if (!validDateValue(field.format, value)) throw Error("公式日期结果无效");
      return { value, error: "" };
    }
    return {
      value: Array.isArray(result.value)
        ? flat(result.value).map(text).join(";")
        : text(result.value),
      error: "",
    };
  } catch (error) {
    return {
      value: field.type === "calculated" ? null : "",
      error: (error as Error).message,
    };
  }
}

export function resolveCalculations(
  fields: FormField[],
  values: FormValues,
  context: FormValues = {},
  formulas: {
    defaults?: readonly string[];
    before?: FormValues;
    now?: Date;
    onError?: (field: FormField, values: FormValues) => void;
    fields?: FormField[];
    choices?: (field: FormField, values: FormValues) => FieldOption[];
    enabled?: (field: FormField, values: FormValues) => boolean;
  } = {},
): FormValues {
  const allFields = formulas.fields || fields;
  // Tab fields share the surrounding scope; each subform row owns its own values.
  const scopedFields = (items: FormField[]): FormField[] =>
    items.flatMap((f) =>
      f.type === "tabs" ? [f, ...scopedFields(f.children)] : [f],
    );
  const active = (field: FormField, scope: Scope) =>
    (field.type === "calculated" ||
      (usesFormula(field) && formulas.defaults?.includes(field.id) &&
        (!formulas.before || affected(field, scope)))) &&
    (formulas.enabled?.(field, input(scope)) ?? true);
  type Scope = {
    fields: FormField[];
    values: FormValues;
    previous?: FormValues;
    parent?: Scope;
    resolving: Set<string>;
    done: Set<string>;
    failed: Set<string>;
  };
  const scopes: Scope[] = [],
    owners = new Map<string, Scope[]>();
  function createScope(
    items: FormField[],
    input: FormValues,
    parent?: Scope,
    previous?: FormValues,
  ): Scope {
    const scope: Scope = {
      fields: scopedFields(items),
      values: { ...input },
      previous,
      parent,
      resolving: new Set(),
      done: new Set(),
      failed: new Set(),
    };
    scopes.push(scope);
    for (const field of scope.fields) {
      const locations = owners.get(field.id) || [];
      locations.push(scope);
      owners.set(field.id, locations);
      if (field.type === "subform" && Array.isArray(scope.values[field.id]))
        scope.values[field.id] = (scope.values[field.id] as FormValues[]).map(
          (row, index) => {
            const oldRows = (previous?.[field.id] || []) as FormValues[];
            const old = row._rowId ? oldRows.find(item => item._rowId === row._rowId) : oldRows[index];
            return createScope(field.children, row, scope, old).values;
          },
        );
    }
    return scope;
  }
  const root = createScope(fields, values, undefined, formulas.before);
  function input(scope: Scope): FormValues {
    return {
      ...(scope.parent ? input(scope.parent) : context),
      ...scope.values,
    };
  }
  // Resolve dependency changes per row so editing one row cannot reset another row's manual value.
  function affected(field: FormField, scope: Scope, path = new Set<string>()): boolean {
    if (!scope.previous) return true;
    if (path.has(field.id)) return false;
    const next = new Set(path).add(field.id);
    for (const id of formulaReferences(field.expression)) {
      const column = formulaFields(allFields, field.id).find(item => item.field.id === id)?.column;
      if (column) {
        if (JSON.stringify(scope.previous[column]) !== JSON.stringify(scope.values[column])) return true;
        for (const owner of owners.get(id) || []) {
          const dependency = owner.fields.find(item => item.id === id)!;
          if (usesFormula(dependency) && affected(dependency, owner, next)) return true;
        }
      } else {
        for (let owner: Scope | undefined = scope; owner; owner = owner.parent) {
          const dependency = owner.fields.find(item => item.id === id);
          if (!dependency) continue;
          if (JSON.stringify(owner.previous?.[id]) !== JSON.stringify(owner.values[id]) ||
            (usesFormula(dependency) && affected(dependency, owner, next))) return true;
          break;
        }
      }
    }
    return false;
  }
  function resolve(field: FormField, scope: Scope) {
    if (scope.done.has(field.id)) return;
    if (scope.resolving.has(field.id)) throw Error("计算字段存在循环引用");
    scope.resolving.add(field.id);
    const available = formulaFields(allFields, field.id);
    const failed = new Set<string>();
    for (const id of formulaReferences(field.expression)) {
      if (available.find((item) => item.field.id === id)?.column) {
        for (const owner of owners.get(id) || []) {
          const dep = owner.fields.find((f) => f.id === id)!;
          if (active(dep, owner)) resolve(dep, owner);
          if (owner.failed.has(id)) failed.add(id);
        }
      } else {
        for (
          let owner: Scope | undefined = scope;
          owner;
          owner = owner.parent
        ) {
          const dep = owner.fields.find((f) => f.id === id);
          if (!dep) continue;
          if (active(dep, owner)) resolve(dep, owner);
          if (owner.failed.has(id)) failed.add(id);
          break;
        }
      }
    }
    const current = input(scope);
    const result = formulaValue(
      field,
      allFields,
      current,
      formulas.choices ? (f) => formulas.choices!(f, current) : undefined,
      formulas.now,
      failed,
    );
    scope.values[field.id] = result.value;
    if (result.error) { scope.failed.add(field.id); formulas.onError?.(field, current); }
    scope.resolving.delete(field.id);
    scope.done.add(field.id);
  }
  for (const scope of scopes)
    for (const field of scope.fields.filter((field) => active(field, scope))) {
      try {
        resolve(field, scope);
      } catch {
        for (const pending of scopes) {
          for (const id of pending.resolving) {
            formulas.onError?.(pending.fields.find(field => field.id === id)!, input(pending));
            pending.values[id] = null;
            pending.failed.add(id);
            pending.done.add(id);
          }
          pending.resolving.clear();
        }
      }
    }
  return root.values;
}

/** Formula validation is independent of the local directory or relation store. */
export function formulaSchemaErrors(fields: FormField[], incomplete = false): string[] {
  const all = fields.flatMap(field => [field, ...field.children]);
  const generated = all.filter(usesFormula), errors: string[] = [];
  for (const field of all) {
    if (field.defaultFormula !== undefined && typeof field.defaultFormula !== "boolean") errors.push(`「${field.label}」的默认值方式不合法`);
    if (field.expression !== undefined && typeof field.expression !== "string") { errors.push(`「${field.label}」的公式格式不合法`); continue; }
    if (!usesFormula(field) || (incomplete && !field.expression?.trim())) continue;
    if (typeof field.expression !== "string") { errors.push(`「${field.label}」请填写公式`); continue; }
    errors.push(...formulaConfigurationErrors(field, fields).map(message => `「${field.label}」${message}`));
  }
  const visiting = new Set<string>(), done = new Set<string>();
  const visit = (field: FormField): boolean => {
    if (visiting.has(field.id)) return true;
    if (done.has(field.id)) return false;
    visiting.add(field.id);
    for (const id of formulaReferences(field.expression)) {
      const source = generated.find(item => item.id === id);
      if (source && visit(source)) return true;
    }
    visiting.delete(field.id); done.add(field.id); return false;
  };
  if (generated.some(visit)) errors.push("字段公式存在循环引用，请调整引用关系");
  return errors;
}
