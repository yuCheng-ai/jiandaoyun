<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { ocrTemplate, type FileValue } from "@platform/contracts";
import type { FormField, FormSchema, FormValues } from "../../../domain/form";
import BaseDialog from "../../../components/BaseDialog.vue";
import AppIcon from "../../../components/AppIcon.vue";
import { useFileUploads } from "../../../composables/useFileUploads";
import { saveFiles } from "../../../repositories/fileRepository";
import { ocrImageIssue, recognizeOcr } from "../../../services/ocr";
const props = defineProps<{
  field: FormField;
  schema: FormSchema;
  values: FormValues;
  disabled?: boolean;
  contextKey?: string;
  apply: (result: Record<string, unknown>, contextKey?: string) => void;
}>();
const emit = defineEmits<{ close: [] }>();
const images = ref<Partial<Record<"front" | "back", File>>>({}),
  previews = ref<Partial<Record<"front" | "back", string>>>({}),
  error = ref(""),
  busy = ref(false);
const stored = new Map<File, FileValue>();
useFileUploads(busy);
const template = computed(() => ocrTemplate(props.field.ocr?.type || ""));
const sides = computed(() =>
  template.value?.value === "idCard"
    ? (["front", "back"] as const)
    : (["front"] as const),
);
let controller: AbortController | undefined,
  generation = 0;
function stop() {
  generation++;
  controller?.abort();
  busy.value = false;
}
function release() {
  for (const url of Object.values(previews.value))
    if (url) URL.revokeObjectURL(url);
  previews.value = {};
}
const fingerprint = () =>
  JSON.stringify([
    props.field,
    props.schema,
    props.values,
    props.disabled,
    props.contextKey,
  ]);
watch(fingerprint, () => {
  if (busy.value) {
    stop();
    error.value = "表单已变化，请重新识别；图片和填写内容已保留";
  }
});
onBeforeUnmount(() => {
  stop();
  release();
});
function select(side: "front" | "back", event: Event) {
  const input = event.target as HTMLInputElement,
    file = input.files?.[0];
  input.value = "";
  if (!file || props.disabled || busy.value) return;
  const issue = ocrImageIssue(file);
  if (issue) {
    error.value = issue;
    return;
  }
  if (previews.value[side]) URL.revokeObjectURL(previews.value[side]!);
  images.value[side] = file;
  previews.value[side] = URL.createObjectURL(file);
  error.value = "";
}
function close() {
  stop();
  emit("close");
}
async function recognize() {
  if (props.disabled || busy.value || !template.value) return;
  const inputs = sides.value.flatMap((side) =>
    images.value[side] ? [{ side, file: images.value[side]! }] : [],
  );
  if (!inputs.length) {
    error.value = "请先选择图片";
    return;
  }
  const current = ++generation,
    baseline = fingerprint(),
    contextKey = props.contextKey;
  controller = new AbortController();
  busy.value = true;
  error.value = "";
  try {
    const result = await recognizeOcr(
      template.value.value,
      inputs,
      controller.signal,
    );
    if (current !== generation || props.disabled || baseline !== fingerprint())
      return;
    const originals = template.value.contents.filter(
      (content) =>
        content.defaultType === "image" &&
        props.field.ocr?.mappings.some(
          (mapping) => mapping.contentId === content.id,
        ),
    );
    for (const original of template.value.contents.filter(
      (content) => content.defaultType === "image",
    ))
      delete result[original.id];
    for (const original of originals) {
      const side =
        template.value.value === "idCard" && original.label.includes("国徽")
          ? "back"
          : "front";
      const file = images.value[side];
      if (!file) continue;
      if (!stored.has(file)) stored.set(file, (await saveFiles([file]))[0]!);
      result[original.id] = [stored.get(file)!];
    }
    if (current !== generation || props.disabled || baseline !== fingerprint())
      return;
    // Original-image output is always the selected local file, never service-supplied metadata.
    props.apply(result, contextKey);
    busy.value = false;
    emit("close");
  } catch (e) {
    if (current === generation) error.value = (e as Error).message;
  } finally {
    if (current === generation) busy.value = false;
  }
}
</script>
<template>
  <BaseDialog
    :open="true"
    :title="`识别${template?.label || '文字'}`"
    width="640px"
    @close="close"
  >
    <div class="ocr-images">
      <label v-for="side in sides" :key="side" class="ocr-image-input">
        <span v-if="template?.value === 'idCard'">{{
          side === "front" ? "身份证人像面" : "身份证国徽面"
        }}</span>
        <img
          v-if="previews[side]"
          :src="previews[side]"
          :alt="images[side]?.name"
          @error="error = '图片无法显示，请重新选择清晰图片'"
        />
        <span class="button"
          ><AppIcon name="image" />{{
            images[side] ? "更换图片" : "上传图片"
          }}</span
        >
        <input
          type="file"
          accept=".jpg,.jpeg,.png,.gif"
          :aria-label="
            template?.value === 'idCard'
              ? side === 'front'
                ? '上传身份证人像面'
                : '上传身份证国徽面'
              : '上传识别图片'
          "
          :disabled="disabled || busy"
          @change="select(side, $event)"
        />
        <span v-if="images[side]" class="hint">{{ images[side]!.name }}</span>
      </label>
    </div>
    <p v-if="busy" class="dialog-pending" role="status">
      <span class="visually-hidden">正在识别，请稍候…</span>
    </p>
    <p v-if="error" class="field-error" role="alert">{{ error }}</p>
    <template #footer
      ><button type="button" class="button" @click="close">取消</button
      ><button
        type="button"
        class="button primary"
        :disabled="disabled || busy || !Object.keys(images).length"
        @click="recognize"
      >
        {{ busy ? "正在识别…" : error ? "重试识别" : "识别" }}
      </button></template
    >
  </BaseDialog>
</template>
<style scoped>
.ocr-images {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
}
.ocr-image-input {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  position: relative;
}
.ocr-image-input img {
  max-width: 100%;
  max-height: 280px;
  object-fit: contain;
}
.ocr-image-input input {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
}
.ocr-image-input:focus-within .button {
  outline: 2px solid var(--primary);
  outline-offset: 2px;
}
.hint {
  overflow-wrap: anywhere;
}
</style>
