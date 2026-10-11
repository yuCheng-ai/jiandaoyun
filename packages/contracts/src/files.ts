import type { FormField } from "./form";

export interface FileValue {
  id?: string;
  name: string;
  size: number;
  type: string;
  /** Historical raster previews remain readable without a stored binary. */
  preview?: string;
}
export const maxFieldFiles = 10;
export const imageExtensions = ["jpg", "jpeg", "png", "gif"];
export const fileTypeTokens = (accept: string) =>
  accept
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
export const fileTypesLimited = (field: FormField) =>
  field.limitFileTypes ?? !!field.accept.trim();
export const fileSizeLimit = (field: FormField) => field.maxFileSize ?? 20;
export function fileSettingsErrors(
  field: FormField,
  parsing = false,
): string[] {
  if (!["file", "image"].includes(field.type)) return [];
  const errors: string[] = [];
  if (
    field.limitFileTypes !== undefined &&
    typeof field.limitFileTypes !== "boolean"
  )
    errors.push("文件格式设置无效");
  if (
    field.maxFileSize !== undefined &&
    (!Number.isFinite(field.maxFileSize) ||
      field.maxFileSize <= 0 ||
      field.maxFileSize > (field.type === "image" ? 20 : 500))
  )
    errors.push(
      `单个${field.type === "image" ? "图片" : "文件"}上限应大于 0 且不超过 ${field.type === "image" ? 20 : 500} MB`,
    );
  if (
    field.uploadStyle !== undefined &&
    !["card", "list"].includes(field.uploadStyle)
  )
    errors.push("请选择有效的图片显示样式");
  if (
    field.type === "file" &&
    fileTypesLimited(field) &&
    !(parsing && field.limitFileTypes === undefined)
  ) {
    const tokens = fileTypeTokens(field.accept);
    // MIME tokens are retained for configurations created by older editors.
    if (
      !tokens.length ||
      tokens.length > 30 ||
      tokens.some(
        (t) =>
          !/^\.?[a-z0-9]{1,10}$/.test(t) &&
          !/^[a-z0-9.+-]+\/(?:[a-z0-9.+-]+|\*)$/.test(t),
      )
    )
      errors.push("请设置 1–30 个有效文件格式，每个扩展名最多 10 个字符");
  }
  return errors;
}
export function isFileValue(value: unknown): value is FileValue {
  if (!value || typeof value !== "object") return false;
  const f = value as FileValue;
  return (
    typeof f.name === "string" &&
    !!f.name &&
    typeof f.size === "number" &&
    Number.isFinite(f.size) &&
    f.size >= 0 &&
    typeof f.type === "string" &&
    (f.id === undefined || typeof f.id === "string")
  );
}
export function fileMatches(
  file: Pick<FileValue, "name" | "type">,
  token: string,
): boolean {
  if (token.includes("/"))
    return token.endsWith("/*")
      ? file.type.toLowerCase().startsWith(token.slice(0, -1))
      : file.type.toLowerCase() === token;
  return file.name.toLowerCase().endsWith(`.${token.replace(/^\./, "")}`);
}
/** Used both before storing selected files and when submitting main/subform values. */
export function fileValueIssue(
  field: FormField,
  value: unknown,
  checkUploadLimits = true,
): string | undefined {
  if (!["file", "image"].includes(field.type) || value == null || value === "")
    return;
  if (!Array.isArray(value) || value.some((f) => !isFileValue(f)))
    return "文件信息无效，请重新选择文件";
  if (checkUploadLimits && value.length > (field.multiple ? maxFieldFiles : 1))
    return field.multiple
      ? `最多上传 ${maxFieldFiles} 个${field.type === "image" ? "图片" : "文件"}`
      : `仅允许上传${field.type === "image" ? "一张图片" : "单个文件"}`;
  const seen = new Set<string>();
  for (const file of value as FileValue[]) {
    if (file.id && seen.has(file.id)) return "同一文件不能重复添加";
    if (file.id) seen.add(file.id);
    // Linked defaults have already been uploaded in the source form. Only new uploads use these limits.
    if (!checkUploadLimits) continue;
    if (file.size > fileSizeLimit(field) * 1024 * 1024)
      return `「${file.name}」超过 ${fileSizeLimit(field)} MB`;
    const tokens =
      field.type === "image"
        ? imageExtensions
        : fileTypesLimited(field)
          ? fileTypeTokens(field.accept)
          : [];
    // Preserve historical WebP/image/* fields; new image fields use the source formats.
    const formats =
      field.type === "image" && field.accept === "image/*"
        ? [...tokens, "webp"]
        : tokens;
    if (formats.length && !formats.some((token) => fileMatches(file, token)))
      return `「${file.name}」格式不支持`;
    if (
      field.type === "image" &&
      file.type &&
      !/^image\/(png|jpeg|gif|webp)$/i.test(file.type)
    )
      return `「${file.name}」不是支持的图片`;
  }
}
export function rasterPreview(value: FileValue): string | undefined {
  return typeof value.preview === "string" &&
    /^data:image\/(png|jpeg|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(
      value.preview,
    )
    ? value.preview
    : undefined;
}
