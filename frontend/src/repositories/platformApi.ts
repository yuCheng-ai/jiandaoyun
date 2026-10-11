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
export async function platformApi<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        ...(Object.keys(accessGroupSelections.value).length
          ? {
              "X-Platform-Access-Groups": JSON.stringify(
                accessGroupSelections.value,
              ),
            }
          : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    console.error("api.request_failed", { method, status: 0 });
    throw new PlatformError(
      "暂时无法连接服务，当前输入已保留，请稍后重试。",
      0,
    );
  }
  const requestId = response.headers.get("X-Request-ID") || undefined;
  if (!response.ok && response.status !== 401) {
    const log = response.status >= 500 ? console.error : console.warn;
    log("api.request_failed", { method, status: response.status, requestId });
  }
  let data: any;
  if (response.status === 413)
    throw new PlatformError(
      "本次内容超过服务端接收容量，尚未保存；原内容与当前输入保留。",
      413,
      undefined,
      requestId,
    );
  try {
    data = await response.json();
  } catch {
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
  if (!response.ok)
    throw new PlatformError(
      typeof data.message === "string"
        ? data.message
        : "操作失败，请检查输入后重试。",
      response.status,
      typeof data.collection?.accepting === "boolean" &&
        typeof data.collection?.code === "string" &&
        typeof data.collection?.checkedAt === "string"
        ? data.collection
        : undefined,
      requestId,
    );
  return data as T;
}
