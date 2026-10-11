import type { FormField } from "./form";

/** Historical calculations remain numeric; text results use the existing format setting. */
export function isNumericField(
  field:
    (Pick<FormField, "type"> & Partial<Pick<FormField, "format">>) | undefined,
): boolean {
  return (
    !!field &&
    (field.type === "number" ||
      (field.type === "calculated" && field.format !== "text"))
  );
}

export type NumberSettings = Partial<
  Pick<
    FormField,
    | "format"
    | "precision"
    | "retainPrecision"
    | "numberGrouping"
    | "limitRange"
    | "min"
    | "max"
  >
>;

function shiftDecimal(value: number, places: number) {
  const [mantissa, exponent = "0"] = String(value).split("e");
  return Number(`${mantissa}e${Number(exponent) + places}`);
}

/** Display formatting never changes the numeric value used by calculations or storage. */
export function formatNumberValue(
  field: NumberSettings,
  value: unknown,
  options: { editing?: boolean; percentSuffix?: boolean } = {},
): string {
  if (value === "" || value == null) return "";
  if (typeof value !== "number" || !Number.isFinite(value))
    return String(value);
  if (
    field.retainPrecision === undefined &&
    (!field.format || field.format === "none")
  )
    return String(value);
  const percent = field.format === "percent";
  if (options.editing) return String(percent ? shiftDecimal(value, 2) : value);
  const precision = Math.max(0, Math.min(8, field.precision ?? 2));
  const retain = field.retainPrecision !== false;
  const formatted = new Intl.NumberFormat("en-US", {
    style: percent ? "percent" : "decimal",
    useGrouping: !percent && !!field.numberGrouping,
    minimumFractionDigits: retain ? precision : 0,
    maximumFractionDigits: retain ? precision : 20,
  }).format(value);
  return percent && options.percentSuffix === false
    ? formatted.replace(/%$/, "")
    : formatted;
}

/** Invalid input remains visible as text; never emit NaN, which JSON would turn into null. */
export function parseNumberInput(
  field: NumberSettings,
  input: string,
): string | number {
  let text = input.trim();
  if (!text) return "";
  if (field.format === "percent") text = text.replace(/%$/, "").trim();
  if (text.includes(",")) {
    if (
      field.format === "percent" ||
      !field.numberGrouping ||
      !/^[+-]?\d{1,3}(,\d{3})+(\.\d*)?$/.test(text)
    )
      return input;
    text = text.replaceAll(",", "");
  }
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text))
    return input;
  const entered = Number(text);
  const value =
    field.format === "percent" ? shiftDecimal(entered, -2) : entered;
  return Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER
    ? value
    : input;
}

export function numberValueIssue(
  field: NumberSettings,
  value: unknown,
): "invalid" | "range" | "precision" | undefined {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    Math.abs(value) > Number.MAX_SAFE_INTEGER
  )
    return "invalid";
  if (
    field.limitRange !== false &&
    ((field.min !== undefined && value < field.min) ||
      (field.max !== undefined && value > field.max))
  )
    return "range";
  // Older published schemas used precision as an input constraint. Preserve their rule;
  // an explicit formatting setting uses precision only for display.
  if (field.retainPrecision === undefined) {
    const scaled = value * 10 ** (field.precision ?? 2);
    if (Math.abs(scaled - Math.round(scaled)) > 0.000001) return "precision";
  }
}
