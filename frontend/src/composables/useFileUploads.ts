import {
  computed,
  inject,
  onBeforeUnmount,
  provide,
  reactive,
  watch,
  type InjectionKey,
  type Ref,
} from "vue";
import type { FileValue } from "@platform/contracts";
import { discardFile } from "../repositories/fileRepository";

interface FileUploads {
  setPending: (id: symbol, pending: boolean) => void;
  trackFiles: (files: FileValue[]) => void;
  discardFiles: (files: FileValue[]) => Promise<void>;
}
const key: InjectionKey<FileUploads> = Symbol("file-uploads");

/** 上传归整次填写所有，字段临时隐藏或切换标签页不会丢失附件。 */
export function provideFileUploads() {
  const active = reactive(new Set<symbol>());
  const uploaded = new Map<string, FileValue>();
  let closed = false;

  async function discardFiles(files: FileValue[]) {
    await Promise.allSettled(
      files.map(async (file) => {
        await discardFile(file);
        if (file.id) uploaded.delete(file.id);
      }),
    );
  }
  function discardUploads() {
    // 服务端只删除未绑定文件；已提交记录和已保存草稿的附件会保留。
    return discardFiles([...uploaded.values()]);
  }
  provide(key, {
    setPending(id, pending) {
      if (pending) active.add(id);
      else active.delete(id);
    },
    trackFiles(files) {
      for (const file of files) {
        if (file.id) uploaded.set(file.id, file);
      }
      if (closed) void discardUploads();
    },
    discardFiles,
  });
  onBeforeUnmount(() => {
    closed = true;
    void discardUploads();
  });
  return {
    uploading: computed(() => active.size > 0),
    discardUploads,
  };
}
export function useFileUploads(pending?: Ref<boolean>) {
  const uploads = inject(key, undefined);
  const id = Symbol();
  if (pending) {
    watch(pending, (value) => uploads?.setPending(id, value), {
      flush: "sync",
    });
  }
  onBeforeUnmount(() => uploads?.setPending(id, false));
  return {
    trackFiles: (files: FileValue[]) => uploads?.trackFiles(files),
    discardFiles: async (files: FileValue[]) => {
      if (uploads) await uploads.discardFiles(files);
      else await Promise.allSettled(files.map(discardFile));
    },
  };
}
