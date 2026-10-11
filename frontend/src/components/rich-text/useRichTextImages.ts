import { onBeforeUnmount, ref, watch, type Ref } from "vue";
import type { RichTextImageStorage } from "./types";

/** Object URLs live only as long as their editor and never enter the saved HTML. */
export function useRichTextImages(
  editor: Ref<HTMLElement | undefined>,
  storage: () => RichTextImageStorage | undefined,
) {
  const imageLoadError = ref("");
  const urls = new Map<string, string>();
  let generation = 0;
  function release() {
    generation++;
    urls.forEach((url) => URL.revokeObjectURL(url));
    urls.clear();
  }
  async function loadStoredImages() {
    const current = ++generation;
    const images = Array.from(
      editor.value?.querySelectorAll<HTMLImageElement>("img[data-file-id]") ||
        [],
    );
    const ids = new Set(images.map((image) => image.dataset.fileId!));
    for (const [id, url] of urls) {
      if (!ids.has(id)) {
        URL.revokeObjectURL(url);
        urls.delete(id);
      }
    }
    imageLoadError.value = "";
    for (const id of ids) {
      try {
        if (!urls.has(id)) {
          const source = storage();
          if (!source?.resolve) throw Error("图片暂不可用");
          const blob = await source.resolve(id);
          if (current !== generation) return;
          if (!/^image\/(png|jpeg|gif|webp)$/.test(blob.type))
            throw Error("图片格式不受支持");
          urls.set(id, URL.createObjectURL(blob));
        }
        for (const image of images.filter(
          (image) => image.dataset.fileId === id,
        ))
          if (editor.value?.contains(image)) image.src = urls.get(id)!;
      } catch (reason) {
        if (current === generation)
          imageLoadError.value =
            reason instanceof Error ? reason.message : "图片加载失败，请重试";
      }
    }
  }
  watch(storage, () => {
    release();
    editor.value
      ?.querySelectorAll("img[data-file-id]")
      .forEach((image) => image.removeAttribute("src"));
    void loadStoredImages();
  });
  onBeforeUnmount(release);
  return { imageLoadError, loadStoredImages };
}
