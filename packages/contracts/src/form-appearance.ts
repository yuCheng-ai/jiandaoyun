import type { FormSchema } from "./form";
import { isFileValue, type FileValue } from "./files";

export const externalThemeCount = 23;
/** A preset image is a fixed catalogue ID; uploads reuse the existing file repository. */
export type ExternalStyleImage = number | FileValue;
export interface ExternalStyleSurface {
  type: "color" | "image";
  color: string;
  image?: ExternalStyleImage;
}
export interface CustomExternalStyle {
  background: ExternalStyleSurface;
  header: ExternalStyleSurface;
  title: {
    visible: boolean;
    align: "left" | "center" | "right";
    size: number;
    bold: boolean;
    italic: boolean;
    underline: boolean;
    color: string;
  };
  buttonColor: string;
}
export interface ExternalFormStyle {
  theme: number;
  /** Present when custom styling is active. Selecting a template replaces these overrides. */
  custom?: CustomExternalStyle;
}
const color = (value: unknown) =>
  typeof value === "string" && /^#[\da-f]{6}$/i.test(value);
const object = (value: unknown, keys: string[]) =>
  !!value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).every((key) => keys.includes(key));

export function externalImageIssue(value: unknown): string | undefined {
  if (
    !isFileValue(value) ||
    !/^.+\.(jpg|jpeg|gif|png)$/i.test(value.name) ||
    !/^image\/(jpeg|gif|png)$/i.test(value.type)
  )
    return "请选择 jpg、gif 或 png 图片";
  if (value.size <= 0 || value.size > 5 * 1024 * 1024)
    return "图片大小应大于 0 且不超过 5 MB";
}
function surface(value: unknown, background: boolean): boolean {
  if (!object(value, ["type", "color", "image"])) return false;
  const s = value as ExternalStyleSurface;
  if (!["color", "image"].includes(s.type) || !color(s.color)) return false;
  if (s.image === undefined) return true;
  if (typeof s.image === "number")
    return background
      ? s.image === 4
      : Number.isInteger(s.image) &&
          s.image > 0 &&
          s.image < externalThemeCount;
  return (
    !externalImageIssue(s.image) &&
    object(s.image, ["id", "name", "size", "type"]) &&
    typeof s.image.id === "string" &&
    /^file_[\da-f-]{36}$/i.test(s.image.id) &&
    s.image.name.length <= 255
  );
}

export function externalStyleErrors(
  settings: FormSchema["settings"],
): string[] {
  const style = settings.externalStyle;
  if (style === undefined) return [];
  if (
    object(style, ["theme", "custom"]) &&
    Number.isInteger(style.theme) &&
    style.theme >= 0 &&
    style.theme < externalThemeCount
  ) {
    if (style.custom === undefined) return [];
    const c = style.custom,
      t = c?.title;
    if (
      object(c, ["background", "header", "title", "buttonColor"]) &&
      surface(c.background, true) &&
      surface(c.header, false) &&
      color(c.buttonColor) &&
      object(t, [
        "visible",
        "align",
        "size",
        "bold",
        "italic",
        "underline",
        "color",
      ]) &&
      [t.visible, t.bold, t.italic, t.underline].every(
        (v) => typeof v === "boolean",
      ) &&
      ["left", "center", "right"].includes(t.align) &&
      Number.isInteger(t.size) &&
      t.size >= 12 &&
      t.size <= 40 &&
      color(t.color)
    )
      return [];
  }
  return ["表单外链样式不合法，请检查样式设置"];
}
