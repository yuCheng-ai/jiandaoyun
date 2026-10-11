<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import {
  externalImageIssue,
  type ExternalStyleImage,
} from "@platform/contracts";
import { saveFiles } from "../../../repositories/fileRepository";
import { useExternalStyleImage } from "../../../composables/useExternalStyleImage";
import AppIcon from "../../../components/AppIcon.vue";
const props = defineProps<{
  value?: ExternalStyleImage;
  surface: "background" | "header";
  label: string;
}>();
const emit = defineEmits<{ change: [value: ExternalStyleImage | undefined] }>();
const {
  url,
  error: readError,
  failed,
} = useExternalStyleImage(() => props.value, props.surface);
const input = ref<HTMLInputElement>(),
  pending = ref(false),
  error = ref("");
let epoch = 0;
watch(
  () => props.value,
  () => {
    epoch++;
    pending.value = false;
    error.value = "";
  },
);
onBeforeUnmount(() => {
  epoch++;
});
async function choose(event: Event) {
  const el = event.target as HTMLInputElement,
    file = el.files?.[0];
  el.value = "";
  if (!file || pending.value) return;
  error.value = externalImageIssue(file) || "";
  if (error.value) return;
  const token = ++epoch;
  pending.value = true;
  let temporary = "";
  try {
    temporary = URL.createObjectURL(file);
    const image = new Image();
    image.src = temporary;
    await image.decode();
    if (token !== epoch) return;
    const [saved] = await saveFiles([file]);
    if (token !== epoch || !saved) return;
    // Keep binary content in the shared file repository, never inline it in every schema version.
    const { preview: _preview, ...metadata } = saved;
    pending.value = false;
    emit("change", metadata);
  } catch (cause) {
    if (token === epoch)
      error.value =
        cause instanceof Error && cause.message.includes("文件")
          ? cause.message
          : "图片上传失败，请选择有效图片后重试";
  } finally {
    if (temporary) URL.revokeObjectURL(temporary);
    if (token === epoch) pending.value = false;
  }
}
</script>
<template>
  <div class="external-style-image" :aria-busy="pending">
    <button
      type="button"
      class="external-style-image-upload"
      :aria-label="`上传${label}图片`"
      :disabled="pending"
      @click="input?.click()"
    >
      <img v-if="url && !readError" :src="url" alt="" @error="failed" />
      <span v-else
        ><AppIcon name="add" :size="22" />{{
          pending ? "正在上传…" : "上传图片"
        }}</span
      >
      <span
        v-if="pending && url"
        class="external-style-upload-status"
        role="status"
        >正在上传…</span
      >
    </button>
    <button
      v-if="value !== undefined"
      type="button"
      class="external-style-image-remove"
      :aria-label="`删除${label}图片`"
      :disabled="pending"
      @click="emit('change', undefined)"
    >
      <AppIcon name="close" :size="12" />
    </button>
    <input
      ref="input"
      type="file"
      accept=".jpg,.jpeg,.gif,.png"
      :aria-label="`${label}图片文件`"
      hidden
      @change="choose"
    />
    <p class="external-style-image-hint">
      支持jpg、gif、png格式，不超过5M的图片
    </p>
    <p v-if="error || readError" class="error" role="alert">
      {{ error || readError }}
    </p>
  </div>
</template>
<style scoped>
.external-style-image {
  position: relative;
}
.external-style-image-upload {
  padding: 0;
  width: 100%;
  height: 88px;
  border: 1px solid #dce1e7;
  border-radius: 2px;
  overflow: hidden;
  background: #fafbfd;
  cursor: pointer;
}
.external-style-image-upload img {
  display: block;
  width: 100%;
  height: 100%;
}
.external-style-image-upload > span {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  height: 100%;
  color: #8590a0;
  font-size: 12px;
}
.external-style-image-upload .external-style-upload-status {
  position: absolute;
  inset: 0 0 auto;
  height: 88px;
  background: #ffffffcc;
}
.external-style-image-remove {
  position: absolute;
  top: 7px;
  right: 7px;
  display: grid;
  place-items: center;
  width: 16px;
  height: 16px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: white;
  color: #8590a0;
  cursor: pointer;
}
.external-style-image-hint {
  margin: 8px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: #919baa;
}
.error {
  margin: 6px 0 0;
  font-size: 12px;
}
</style>
