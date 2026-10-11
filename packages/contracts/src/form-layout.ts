import type { FormField, FormSchema, FormTitleLayout } from "./form";
import { choicePalette } from "./choices";

/** Same recommended colors, in the source form-appearance palette order. */
export const formAppearancePalette = [
  0, 8, 1, 9, 3, 11, 2, 10, 4, 12, 5, 13, 6, 14, 7, 15, 16, 24, 17, 25, 19, 27,
  18, 26, 20, 28, 21, 29, 22, 30, 23, 31,
].map((i) => choicePalette[i]!);

/** Missing appearance retains the colors of existing published dividers. */
export function dividerColors(field: FormField) {
  const safeColor = (value: unknown, fallback: string) =>
    typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value)
      ? value
      : fallback;
  return {
    color: safeColor(field.dividerColor, "#e0e5eb"),
    titleColor: safeColor(field.dividerTitleColor, "#949eac"),
  };
}

export function dividerAppearanceErrors(field: FormField): string[] {
  const keys = ["dividerColor", "dividerTitleColor"] as const;
  if (
    (field.dividerStyle !== undefined ||
      keys.some((key) => field[key] !== undefined)) &&
    field.type !== "divider"
  )
    return ["分割线样式和颜色只能用于分割线字段"];
  const errors: string[] = keys
    .filter(
      (key) =>
        field[key] !== undefined &&
        (typeof field[key] !== "string" ||
          !/^#[0-9a-f]{6}$/i.test(field[key]!)),
    )
    .map((key) =>
      key === "dividerColor"
        ? "请选择有效的分割线配色"
        : "请选择有效的分割线标题颜色",
    );
  if (
    field.dividerStyle !== undefined &&
    !formDividerStyles.includes(field.dividerStyle)
  )
    errors.push("请选择有效的分割线样式");
  return errors;
}

/** Source identifiers; absent in older definitions, whose appearance stays unchanged. */
export const formDividerStyles: readonly NonNullable<
  FormField["dividerStyle"]
>[] = [
  "none",
  "dashed",
  "thin",
  "thick",
  "style1",
  "style2",
  "style3",
  "style6",
  "style7",
  "style8",
  "style9",
  "style4",
  "style5",
];

/** Containers span the grid; dividers may also reserve part of a row. */
export function fieldGridSpan(field: FormField, columns: number): number {
  if (
    ["tabs", "subform"].includes(field.type) ||
    (field.type === "divider" && field.width === 12)
  )
    return 12;
  return field.width === 12 ? 12 / columns : field.width;
}

export const subformWidthOptions = [
  { value: "half", label: "1/2" },
  { value: "standard", label: "标准" },
  { value: "double", label: "2倍" },
] as const;

export function subformWidthErrors(
  field: Pick<FormField, "subformWidth">,
): string[] {
  const width = field.subformWidth;
  if (
    width !== undefined &&
    !(typeof width === "number"
      ? Number.isInteger(width) && width > 0 && width <= 1000
      : subformWidthOptions.some((option) => option.value === width))
  )
    return ["子字段宽度应为1–1000px的整数"];
  return [];
}

/** Shared by design and filling; old definitions do not acquire new settings. */
export function subformColumnWidth(
  field: Pick<FormField, "subformWidth">,
): number {
  if (subformWidthErrors(field).length) return 200;
  const width = field.subformWidth;
  return typeof width === "number"
    ? width
    : width === "half"
      ? 100
      : width === "double"
        ? 400
        : 200;
}

export function subformFixedColumnErrors(
  field: Pick<FormField, "type" | "subformFixedColumns">,
): string[] {
  const value = field.subformFixedColumns;
  if (value === undefined) return [];
  return field.type !== "subform" ||
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !["desktop", "mobile"].includes(key)) ||
    [value.desktop, value.mobile].some(
      (count) => !Number.isInteger(count) || count < 0 || count > 300,
    )
    ? ["固定列数应为0–300的整数"]
    : [];
}

/** Excluded columns are removed after choosing the original fixed prefix. */
export function subformFixedColumnIds(
  field: FormField,
  mobile = false,
): Set<string> {
  const count = field.subformFixedColumns?.[mobile ? "mobile" : "desktop"] ?? 0;
  return new Set(field.children.slice(0, count).map((child) => child.id));
}

export function subformSummarySupported(
  field: Pick<FormField, "type">,
): boolean {
  return ![
    "image",
    "file",
    "query",
    "lookup",
    "signature",
    "subform",
    "tabs",
    "divider",
    "button",
  ].includes(field.type);
}

export function subformMobileErrors(
  field: Pick<FormField, "type" | "subformMobile"> &
    Partial<Pick<FormField, "children">>,
  checkReferences = false,
): string[] {
  const value = field.subformMobile;
  if (value === undefined) return [];
  if (
    field.type !== "subform" ||
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some(
      (key) => !["layout", "summary", "fieldIds"].includes(key),
    ) ||
    !["vertical", "table"].includes(value.layout) ||
    !["first", "custom"].includes(value.summary) ||
    !Array.isArray(value.fieldIds) ||
    value.fieldIds.length > 3 ||
    value.fieldIds.some(
      (id) => typeof id !== "string" || !id || id.length > 100,
    ) ||
    new Set(value.fieldIds).size !== value.fieldIds.length
  )
    return ["请选择有效的移动端展示样式和最多3个简报字段"];
  if (
    checkReferences &&
    value.summary === "custom" &&
    value.fieldIds.some((id) => {
      const child = field.children?.find((child) => child.id === id);
      return !child || !subformSummarySupported(child);
    })
  )
    return ["简报字段已移除或不支持展示，请重新选择"];
  return [];
}

/** Choose the original prefix before excluding unsupported, hidden or masked fields. */
export function subformSummaryFields(field: FormField): FormField[] {
  const selected =
    field.subformMobile?.summary === "custom"
      ? field.subformMobile.fieldIds.flatMap((id) => {
          const child = field.children.find((child) => child.id === id);
          return child ? [child] : [];
        })
      : field.children.slice(0, 3);
  return selected.filter(
    (child) => subformSummarySupported(child) && child.visible && !child.masked,
  );
}

export const defaultMobileLayout = (): FormTitleLayout => ({
  labelPosition: "top",
  labelWidth: 120,
  labelAlignment: "left",
  descriptionMode: "show",
});

export function formTitleLayout(
  settings: FormSchema["settings"],
  mobile: boolean,
): FormTitleLayout {
  return mobile
    ? { ...defaultMobileLayout(), ...settings.mobileLayout }
    : {
        labelPosition: settings.labelPosition,
        labelWidth: settings.labelWidth,
        labelAlignment: settings.labelAlignment || "left",
        descriptionMode: settings.descriptionMode || "show",
      };
}

/** Optional settings are never silently dropped while reading a saved form/page. */
export function formLayoutErrors(settings: FormSchema["settings"]): string[] {
  const errors: string[] = [];
  for (const key of [
    "labelAlignment",
    "descriptionMode",
    "inputWidth",
  ] as const) {
    const choices =
      key === "labelAlignment"
        ? ["left", "right"]
        : key === "descriptionMode"
          ? ["show", "popover"]
          : ["standard", "auto"];
    if (settings[key] !== undefined && !choices.includes(settings[key]!))
      errors.push("表单布局设置不合法");
  }
  const mobile = settings.mobileLayout;
  if (
    mobile !== undefined &&
    (!mobile ||
      typeof mobile !== "object" ||
      Array.isArray(mobile) ||
      !["top", "left"].includes(mobile.labelPosition) ||
      !["left", "right"].includes(mobile.labelAlignment) ||
      !["show", "popover"].includes(mobile.descriptionMode) ||
      !Number.isInteger(mobile.labelWidth) ||
      mobile.labelWidth < 50 ||
      mobile.labelWidth > 500)
  )
    errors.push("移动端表单布局不合法，标题宽度应为50–500");
  return errors;
}

/** Layout settings change display only; missing settings retain historical tabs. */
export const formTabStyles = ["line", "top", "card", "solid", "slant"] as const;
export function tabAppearanceErrors(
  field: import("./form").FormField,
): string[] {
  const configured =
    field.tabStyle !== undefined ||
    field.tabCustomColor !== undefined ||
    field.tabColor !== undefined;
  if (configured && field.type !== "tabs")
    return ["标签页样式只能用于多标签页字段"];
  const errors: string[] = [];
  if (field.tabStyle !== undefined && !formTabStyles.includes(field.tabStyle))
    errors.push("请选择有效的标签页样式");
  if (
    field.tabCustomColor !== undefined &&
    typeof field.tabCustomColor !== "boolean"
  )
    errors.push("标签页自定义颜色开关不合法");
  if (
    field.tabColor !== undefined &&
    (typeof field.tabColor !== "string" ||
      !/^#[0-9a-f]{6}$/i.test(field.tabColor))
  )
    errors.push("请选择有效的标签页颜色");
  return errors;
}
