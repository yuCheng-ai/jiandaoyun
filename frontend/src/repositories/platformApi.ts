import { accessGroupSelections } from "./accessGroupState";
import type { CollectionStatus } from "@platform/contracts";

export class PlatformError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly collection?: CollectionStatus,
    readonly requestId?: string,
  ) {
    super(message);
  }
}

async function responseData(response: Response, method: string) {
  try {
    return await response.json();
  } catch {
    const requestId = response.headers.get("X-Request-ID") || undefined;
    console.error("api.invalid_response", {
      method,
      status: response.status,
      requestId,
    });
    throw new PlatformError(
      "服务返回异常，当前输入已保留，请重试。",
      response.status,
      undefined,
      requestId,
    );
  }
}

/** JSON、文件上传与下载共用登录态、权限组选取和错误日志。 */
export async function platformRequest(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = {};
  let payload: BodyInit | undefined;
  if (body instanceof FormData) {
    // multipart 的 boundary 由浏览器生成，不能手动覆盖 Content-Type。
    payload = body;
  } else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  if (Object.keys(accessGroupSelections.value).length) {
    headers["X-Platform-Access-Groups"] = JSON.stringify(
      accessGroupSelections.value,
    );
  }

  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      credentials: "same-origin",
      headers,
      body: payload,
    });
  } catch {
    console.error("api.request_failed", { method, status: 0 });
    throw new PlatformError(
      "暂时无法连接服务，当前输入已保留，请稍后重试。",
      0,
    );
  }
  if (response.ok) return response;

  const requestId = response.headers.get("X-Request-ID") || undefined;
  if (response.status !== 401) {
    const log = response.status >= 500 ? console.error : console.warn;
    log("api.request_failed", { method, status: response.status, requestId });
  }
  if (response.status === 413) {
    throw new PlatformError(
      "本次内容超过服务端接收容量，尚未保存；原内容与当前输入保留。",
      413,
      undefined,
      requestId,
    );
  }
  const data = await responseData(response, method);
  const collection = data.collection;
  const hasCollection =
    typeof collection?.accepting === "boolean" &&
    typeof collection?.code === "string" &&
    typeof collection?.checkedAt === "string";
  const message =
    typeof data.message === "string"
      ? data.message
      : "操作失败，请检查输入后重试。";
  throw new PlatformError(
    message,
    response.status,
    hasCollection ? collection : undefined,
    requestId,
  );
}

export async function platformApi<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const response = await platformRequest(path, method, body);
  return responseData(response, method) as Promise<T>;
}
