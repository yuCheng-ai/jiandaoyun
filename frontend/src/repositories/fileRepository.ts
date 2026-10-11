import type { FileValue } from "@platform/contracts";
import { rasterPreview } from "@platform/contracts";

const databaseName = "workflow-studio-files-v1";
function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined")
      return reject(
        Error("当前浏览器无法保存文件，请换用支持文件存储的浏览器"),
      );
    const request = indexedDB.open(databaseName, 1);
    let blocked = false;
    request.onupgradeneeded = () => request.result.createObjectStore("files");
    request.onsuccess = () => {
      if (blocked) {
        request.result.close();
        return;
      }
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(Error("文件保存失败，请重试"));
    request.onblocked = () => {
      blocked = true;
      reject(Error("文件存储暂不可用，请关闭旧页面后重试"));
    };
  });
}
/** A selection commits atomically. Metadata never points at a partially written batch. */
export async function saveFiles(files: File[]): Promise<FileValue[]> {
  const values: FileValue[] = await Promise.all(
    files.map(async (file) => {
      const value: FileValue = {
        id: `file_${crypto.randomUUID()}`,
        name: file.name,
        size: file.size,
        type: file.type,
      };
      // Retain the small raster preview consumed by existing record/print layouts.
      if (
        /^image\/(png|jpeg|gif|webp)$/.test(file.type) &&
        file.size <= 300 * 1024
      ) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        let text = "";
        for (const byte of bytes) text += String.fromCharCode(byte);
        value.preview = `data:${file.type};base64,${btoa(text)}`;
      }
      return value;
    }),
  );
  const db = await open();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("files", "readwrite");
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(Error("文件保存失败，已保留原有附件，请重试"));
      tx.onerror = () => {};
      try {
        files.forEach((file, i) =>
          tx.objectStore("files").put(file, values[i]!.id),
        );
      } catch {
        tx.abort();
      }
    });
    return values;
  } finally {
    db.close();
  }
}
export async function readFile(value: FileValue): Promise<Blob> {
  if (value.id) {
    const db = await open();
    try {
      const blob = await new Promise<Blob | undefined>((resolve, reject) => {
        const tx = db.transaction("files", "readonly");
        const request = tx.objectStore("files").get(value.id!);
        tx.oncomplete = () => resolve(request.result);
        tx.onabort = () => reject(Error("文件读取失败，请重试"));
        tx.onerror = () => {};
      });
      if (blob instanceof Blob) return blob;
    } finally {
      db.close();
    }
  }
  const preview = rasterPreview(value);
  if (preview) {
    const [header, base64] = preview.split(",");
    const bytes = Uint8Array.from(atob(base64!), (c) => c.charCodeAt(0));
    return new Blob([bytes], { type: header!.slice(5, header!.indexOf(";")) });
  }
  throw Error(
    value.id
      ? "此文件内容在当前浏览器中不可用，请在上传文件的浏览器打开，或重新上传。"
      : "此文件内容不可用，请重新上传。旧记录只保留了文件名称。",
  );
}
