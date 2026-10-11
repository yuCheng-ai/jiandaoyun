import type { OcrType } from "@platform/contracts";
export type OcrImage = { side: "front" | "back"; file: File };
export function ocrImageIssue(file: File): string {
  if (
    !/^image\/(png|jpeg|gif)$/.test(file.type) ||
    !/\.(png|jpe?g|gif)$/i.test(file.name)
  )
    return "请选择 JPG、PNG 或 GIF 图片";
  if (!file.size) return "图片为空，请重新选择";
  if (file.size > 20 * 1024 * 1024) return "图片超过20 MB，请压缩后重试";
  return "";
}
/** A deployment-owned endpoint. No provider credentials or synthetic recognition live in the client. */
export async function recognizeOcr(
  type: OcrType,
  images: OcrImage[],
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  for (const image of images) {
    const issue = ocrImageIssue(image.file);
    if (issue) throw Error(issue);
  }
  const endpoint = String(import.meta.env.VITE_OCR_ENDPOINT || "").trim();
  if (!endpoint) throw Error("文字识别服务尚未启用，请稍后重试");
  if (!images.length) throw Error("请先选择图片");
  const form = new FormData();
  form.append("type", type);
  for (const image of images)
    form.append(image.side, image.file, image.file.name);
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  let timeout = false;
  const timer = setTimeout(() => {
    timeout = true;
    controller.abort();
  }, 30000);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      body: form,
      signal: controller.signal,
      credentials: "same-origin",
    });
    if (!response.ok)
      throw Error(
        response.status === 429
          ? "识别请求过多，请稍后重试"
          : [401, 403].includes(response.status)
            ? "当前无法使用文字识别，请联系管理员"
            : "识别服务暂不可用，请重试",
      );
    if (!response.headers.get("content-type")?.includes("application/json"))
      throw Error("识别服务返回格式无效，请联系管理员");
    const result = await response.json();
    if (
      !result ||
      result.type !== type ||
      !result.values ||
      typeof result.values !== "object" ||
      Array.isArray(result.values)
    )
      throw Error("识别服务返回格式无效，请联系管理员");
    return result.values;
  } catch (e) {
    if (timeout) throw Error("识别超时，请重试");
    if (signal.aborted) throw Error("识别已取消");
    if (e instanceof TypeError)
      throw Error("无法连接识别服务，请检查网络后重试");
    throw e;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}
