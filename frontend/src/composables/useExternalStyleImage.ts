import { computed, ref, watch } from "vue";
import type { ExternalStyleImage } from "@platform/contracts";
import { readFile } from "../repositories/fileRepository";
import { externalThemes } from "../domain/externalThemes";

/** Shared preview/fill hydration. Replacing or unmounting releases URLs and cancels stale reads. */
export function useExternalStyleImage(
  value: () => ExternalStyleImage | undefined,
  surface: "background" | "header",
) {
  const uploaded = ref(""),
    error = ref("");
  const url = computed(() => {
    const image = value();
    if (typeof image !== "number") return uploaded.value;
    const theme = externalThemes[image];
    return surface === "header"
      ? theme?.banner || ""
      : theme && "backgroundImage" in theme
        ? theme.backgroundImage
        : "";
  });
  watch(
    value,
    async (image, _, cleanup) => {
      let active = true,
        current = "";
      uploaded.value = "";
      error.value = "";
      cleanup(() => {
        active = false;
        if (current) URL.revokeObjectURL(current);
      });
      if (!image || typeof image === "number") return;
      try {
        const blob = await readFile(image);
        if (!active) return;
        current = URL.createObjectURL(blob);
        uploaded.value = current;
      } catch {
        if (active) error.value = "图片无法读取，请重新上传";
      }
    },
    { immediate: true },
  );
  function failed() {
    error.value = "图片无法显示，请重新上传";
  }
  return { url, error, failed };
}
