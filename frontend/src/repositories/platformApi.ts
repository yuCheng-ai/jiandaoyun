import { accessGroupSelections } from "./accessGroupState";
import type {
  CollectionStatus,
  FieldValidationIssue,
} from "@platform/contracts";

export class PlatformError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly collection?: CollectionStatus,
    readonly requestId?: string,
    readonly issues: FieldValidationIssue[] = [],
  ) {
    super(message);
    this.name = "PlatformError";
  }
}

/** 请求层只归一化错误和日志，由操作所在页面展示一次，不在此弹窗或跳转。 */
function fail(
  error: PlatformError,
  method: string,
  event = "api.request_failed",
): never {
  if (error.status !== 401) {
    const log =
      error.status === 0 ||
      error.status >= 500 ||
      event === "api.invalid_response"
        ? console.error
        : console.warn;
    log(event, { method, status: error.status, requestId: error.requestId });
  }
  throw error;
}

async function responseData(response: Response, method: string) {
  if (response.status === 204) return undefined;
  try {
    return await response.json();
  } catch {
    const requestId = response.headers.get("X-Request-ID") || undefined;
    fail(
      new PlatformError(
        "服务返回异常，请重试。",
        response.status,
        undefined,
        requestId,
      ),
      method,
      "api.invalid_response",
    );
  }
}

function failureMessage(status: number, data: Record<string, unknown>) {
  // 服务端内部异常可能包含 SQL 或堆栈，不直接展示到界面。
  if (status >= 500) return "服务暂时不可用，请稍后重试。";
  if (status === 413) return "提交内容过大，请减少内容后重试。";
  if (typeof data.message === "string" && data.message.trim())
    return data.message;
  if (Array.isArray(data.message)) {
    const messages = data.message.filter(
      (item): item is string => typeof item === "string" && !!item.trim(),
    );
    if (messages.length) return messages.join("\n");
  }
  if (status === 401) return "请先登录后继续操作。";
  if (status === 403) return "没有权限执行此操作。";
  if (status === 404) return "请求的内容不存在或已被移除。";
  if (status === 409) return "内容已更新，请重新读取后再操作。";
  if (status === 429) return "操作过于频繁，请稍后重试。";
  return "操作失败，请检查输入后重试。";
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
    fail(new PlatformError("网络连接失败，请检查连接后重试。", 0), method);
  }
  if (response.ok) return response;

  const requestId = response.headers.get("X-Request-ID") || undefined;
  // 代理层可能返回 HTML、空正文或 JSON null；它们都不应覆盖原 HTTP 状态。
  const bodyData: unknown = await response.json().catch(() => undefined);
  const data =
    bodyData && typeof bodyData === "object" && !Array.isArray(bodyData)
      ? (bodyData as Record<string, unknown>)
      : {};
  const collection = data.collection;
  const hasCollection =
    !!collection &&
    typeof collection === "object" &&
    "accepting" in collection &&
    typeof collection.accepting === "boolean" &&
    "code" in collection &&
    typeof collection.code === "string" &&
    "checkedAt" in collection &&
    typeof collection.checkedAt === "string";
  const issues: FieldValidationIssue[] = [];
  if (response.status === 400 && Array.isArray(data.issues)) {
    for (const item of data.issues) {
      if (!item || typeof item !== "object") continue;
      if (typeof item.fieldId !== "string" || typeof item.message !== "string")
        continue;
      if (item.subformId !== undefined && typeof item.subformId !== "string")
        continue;
      if (item.rowId !== undefined && typeof item.rowId !== "string") continue;
      if (
        item.rowIndex !== undefined &&
        (!Number.isInteger(item.rowIndex) || item.rowIndex < 0)
      )
        continue;
      issues.push({
        fieldId: item.fieldId,
        message: item.message,
        subformId: item.subformId,
        rowId: item.rowId,
        rowIndex: item.rowIndex,
      });
    }
  }
  fail(
    new PlatformError(
      failureMessage(response.status, data),
      response.status,
      hasCollection ? (collection as CollectionStatus) : undefined,
      requestId,
      issues,
    ),
    method,
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
