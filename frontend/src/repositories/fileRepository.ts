import type { FileValue } from "@platform/contracts";
import { platformApi, platformRequest } from "./platformApi";

/** 逐个上传控制内存占用；全部成功后，控件才更新本次选择。 */
export async function saveFiles(files: File[]): Promise<FileValue[]> {
  const saved: FileValue[] = [];
  try {
    for (const file of files) {
      const body = new FormData();
      body.append("file", file);
      saved.push(await platformApi<FileValue>("/files", "POST", body));
    }
    return saved;
  } catch (cause) {
    await Promise.allSettled(saved.map(discardFile));
    throw cause;
  }
}

export async function readFile(value: FileValue): Promise<Blob> {
  if (!value.id) throw Error("文件内容不可用，请重新上传。");
  const response = await platformRequest(
    `/files/${encodeURIComponent(value.id)}`,
  );
  return response.blob();
}

/** 服务端只移除未绑定记录的本人上传，已保存附件随记录保留。 */
export async function discardFile(value: FileValue): Promise<void> {
  if (!value.id) return;
  await platformApi(`/files/${encodeURIComponent(value.id)}`, "DELETE");
}
