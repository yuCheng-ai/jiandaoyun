import { accessGroupSelections } from "./accessGroupState";
import type { CollectionStatus } from "@platform/contracts";
export class PlatformError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly collection?: CollectionStatus,
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
      headers: { "Content-Type": "application/json", ...(Object.keys(accessGroupSelections.value).length ? { "X-Platform-Access-Groups": JSON.stringify(accessGroupSelections.value) } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new PlatformError(
      "暂时无法连接协作服务，输入已保留，请稍后重试。",
      0,
    );
  }
  let data: any;
  if (response.status === 413) throw new PlatformError("本次内容超过服务端接收容量，尚未保存；原内容与当前输入保留。", 413);
  try {
    data = await response.json();
  } catch {
    throw new PlatformError(
      "协作服务尚未连接。此入口需要本地前后端同时运行。",
      response.status,
    );
  }
  if (!response.ok)
    throw new PlatformError(
      typeof data.message === "string"
        ? data.message
        : "操作失败，请检查输入后重试。",
      response.status,
      typeof data.collection?.accepting === 'boolean' && typeof data.collection?.code === 'string' && typeof data.collection?.checkedAt === 'string' ? data.collection : undefined,
    );
  return data as T;
}
