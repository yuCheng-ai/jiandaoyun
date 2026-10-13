<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import {
  fileValueIssue,
  fileSizeLimit,
  fileTypesLimited,
  imageExtensions,
  isFileValue,
  type FileValue,
  type FormField,
} from "@platform/contracts";
import {
  discardFile,
  readFile,
  saveFiles,
} from "../../../repositories/fileRepository";
import BaseDialog from "../../../components/BaseDialog.vue";
import AppIcon from "../../../components/AppIcon.vue";
import { useFileUploads } from "../../../composables/useFileUploads";
const props = withDefaults(
  defineProps<{
    field: FormField;
    modelValue?: unknown;
    disabled?: boolean;
    design?: boolean;
    label?: string;
  }>(),
  { disabled: false, design: false },
);
const emit = defineEmits<{ "update:modelValue": [value: FileValue[]] }>();
const files = computed(() =>
  Array.isArray(props.modelValue) ? props.modelValue.filter(isFileValue) : [],
);
const locked = computed(
  () => props.disabled || props.design || !props.field.editable,
);
const pending = ref(false),
  error = ref(""),
  dragging = ref<number>(),
  input = ref<HTMLInputElement>();
useFileUploads(pending);
const thumbs = ref<Record<number, string>>({});
const selected = ref<{ value: FileValue; url?: string; kind?: string }>();
const viewError = ref(""),
  viewing = ref(false);
let epoch = 0,
  viewEpoch = 0;
const accept = computed(() =>
  props.field.type === "image"
    ? props.field.accept || imageExtensions.map((t) => `.${t}`).join(",")
    : fileTypesLimited(props.field)
      ? props.field.accept
      : "",
);
const card = computed(
  () => props.field.type === "image" && props.field.uploadStyle !== "list",
);
function closePreview() {
  viewEpoch++;
  if (selected.value?.url) URL.revokeObjectURL(selected.value.url);
  selected.value = undefined;
  viewing.value = false;
  viewError.value = "";
}
watch(
  [
    () => props.field.id,
    () => props.field.type,
    // 其他字段重新生成 values 时，不应中断当前内容未变的上传。
    () => JSON.stringify(props.modelValue),
    locked,
    () => accept.value,
    () => props.field.multiple,
    () => props.field.maxFileSize,
  ],
  () => {
    epoch++;
    pending.value = false;
    error.value = "";
    closePreview();
  },
);
watch(
  files,
  (values, _, cleanup) => {
    let active = true;
    const urls: string[] = [];
    thumbs.value = {};
    cleanup(() => {
      active = false;
      urls.forEach((url) => URL.revokeObjectURL(url));
    });
    values.forEach(async (file, index) => {
      if (!/^image\/(png|jpeg|gif|webp)$/i.test(file.type)) return;
      try {
        const blob = await readFile(file);
        if (!active) return;
        const url = URL.createObjectURL(blob);
        urls.push(url);
        thumbs.value[index] = url;
      } catch {
        // 缩略图加载失败仍保留文件名，打开时显示服务端返回的具体错误。
      }
    });
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  epoch++;
  closePreview();
});
async function upload(selection: File[]) {
  if (locked.value || pending.value || !selection.length) return;
  error.value = "";
  const before = files.value;
  const candidate = props.field.multiple
    ? [...before, ...selection]
    : selection;
  const issue = fileValueIssue(props.field, candidate);
  if (issue) {
    error.value = issue;
    return;
  }
  const token = ++epoch;
  pending.value = true;
  try {
    const added = await saveFiles(selection);
    if (token !== epoch || locked.value) {
      await Promise.allSettled(added.map(discardFile));
      return;
    }
    const uploadedIssue = fileValueIssue(props.field, added);
    if (uploadedIssue) {
      await Promise.allSettled(added.map(discardFile));
      error.value = uploadedIssue;
      return;
    }
    emit(
      "update:modelValue",
      props.field.multiple ? [...before, ...added] : added,
    );
  } catch (cause) {
    if (token === epoch)
      error.value =
        cause instanceof Error ? cause.message : "文件保存失败，请重试";
  } finally {
    if (token === epoch) pending.value = false;
  }
}
function choose(event: Event) {
  const el = event.target as HTMLInputElement;
  const selection = Array.from(el.files || []);
  el.value = "";
  void upload(selection);
}
function drop(event: DragEvent) {
  event.preventDefault();
  if (dragging.value !== undefined) return;
  void upload(Array.from(event.dataTransfer?.files || []));
}
function paste(event: ClipboardEvent) {
  const selection = Array.from(event.clipboardData?.files || []);
  if (selection.length) {
    event.preventDefault();
    void upload(selection);
  }
}
function remove(index: number) {
  if (locked.value || pending.value) return;
  const removed = files.value[index];
  emit(
    "update:modelValue",
    files.value.filter((_, i) => i !== index),
  );
  if (removed) void discardFile(removed).catch(() => {});
}
function move(from: number, to: number) {
  if (
    locked.value ||
    pending.value ||
    from === to ||
    from < 0 ||
    to < 0 ||
    to >= files.value.length
  )
    return;
  const next = [...files.value];
  const [file] = next.splice(from, 1);
  next.splice(to, 0, file!);
  emit("update:modelValue", next);
}
function reorder(event: DragEvent, index: number) {
  event.preventDefault();
  event.stopPropagation();
  if (dragging.value !== undefined) move(dragging.value, index);
  dragging.value = undefined;
}
function kind(value: FileValue) {
  const ext = value.name.split(".").pop()?.toLowerCase();
  if (["jpg", "jpeg", "png", "gif", "webp"].includes(ext || "")) return "image";
  if (ext === "pdf") return "pdf";
  if (["ogg", "mp3", "wav"].includes(ext || "")) return "audio";
  if (["mp4", "m4v", "webm"].includes(ext || "")) return "video";
  return "";
}
async function preview(value: FileValue) {
  if (props.design) return;
  closePreview();
  selected.value = { value };
  viewing.value = true;
  const token = viewEpoch;
  try {
    const blob = await readFile(value);
    if (token !== viewEpoch) return;
    const fileKind =
      blob.size > (kind(value) === "image" ? 20 : 100) * 1024 * 1024
        ? ""
        : kind(value);
    // Only allow-listed formats are embedded; arbitrary HTML/SVG attachments are downloadable.
    const type = fileKind === "pdf" ? "application/pdf" : blob.type;
    selected.value = {
      value,
      kind: fileKind,
      url: URL.createObjectURL(new Blob([blob], { type })),
    };
  } catch (cause) {
    if (token === viewEpoch)
      viewError.value =
        cause instanceof Error ? cause.message : "文件读取失败，请重试";
  } finally {
    if (token === viewEpoch) viewing.value = false;
  }
}
function download() {
  if (!selected.value?.url) return;
  const link = document.createElement("a");
  link.href = selected.value.url;
  link.download = selected.value.value.name;
  link.click();
}
</script>
<template>
  <div
    class="file-control"
    :aria-busy="pending"
    @dragover.prevent
    @drop="drop"
    @paste="paste"
  >
    <div v-if="!disabled || design" class="file-select" :class="{ locked }">
      <button
        type="button"
        :disabled="locked || pending"
        @click="input?.click()"
      >
        {{ pending ? "正在上传…" : "选择" }}
      </button>
      <span
        >拖拽或单击后粘贴{{
          field.type === "image" ? "图片，单张" : "文件，单个"
        }}{{ fileSizeLimit(field) }}MB以内</span
      >
      <input
        ref="input"
        type="file"
        tabindex="-1"
        :accept="accept"
        :multiple="field.multiple"
        :disabled="locked || pending"
        :aria-label="label || field.label"
        @change="choose"
      />
    </div>
    <p
      v-if="
        field.type === 'file' &&
        fileTypesLimited(field) &&
        accept &&
        (!disabled || design)
      "
      class="file-format"
    >
      支持格式：{{ accept.replaceAll(".", "") }}
    </p>
    <div class="file-values" :class="{ cards: card }">
      <div
        v-for="(file, index) in files"
        :key="file.id || `${file.name}-${index}`"
        class="file-item"
        :draggable="!locked && !pending"
        @dragstart="dragging = index"
        @dragend="dragging = undefined"
        @dragover.prevent
        @drop="reorder($event, index)"
      >
        <button
          class="file-open"
          type="button"
          :disabled="design"
          :aria-label="`查看 ${file.name}`"
          @click="preview(file)"
        >
          <img
            v-if="thumbs[index]"
            :src="thumbs[index]"
            :alt="file.name"
          /><AppIcon
            v-else
            :name="field.type === 'image' ? 'image' : 'attach'"
            :size="card ? 24 : 18"
          />
          <span :title="file.name">{{ file.name }}</span>
        </button>
        <div v-if="!locked" class="file-actions">
          <button
            v-if="files.length > 1"
            type="button"
            class="icon-button"
            :disabled="pending || index === 0"
            :aria-label="`前移 ${file.name}`"
            @click="move(index, index - 1)"
          >
            <AppIcon name="up" :size="13" />
          </button>
          <button
            v-if="files.length > 1"
            type="button"
            class="icon-button"
            :disabled="pending || index === files.length - 1"
            :aria-label="`后移 ${file.name}`"
            @click="move(index, index + 1)"
          >
            <AppIcon name="down" :size="13" />
          </button>
          <button
            type="button"
            class="icon-button"
            :disabled="pending"
            :aria-label="`移除 ${file.name}`"
            @click="remove(index)"
          >
            <AppIcon name="close" :size="14" />
          </button>
        </div>
      </div>
    </div>
    <p v-if="disabled && !files.length && !design" class="file-format">—</p>
    <p v-if="error" role="alert" class="field-error">{{ error }}</p>
    <BaseDialog
      :open="!!selected"
      :title="selected?.value.name || '文件预览'"
      width="900px"
      @close="closePreview"
    >
      <p v-if="viewing" role="status">正在读取文件…</p>
      <p v-else-if="viewError" role="alert" class="field-error">
        {{ viewError }}
      </p>
      <template v-else-if="selected?.url">
        <div class="file-preview">
          <img
            v-if="selected.kind === 'image'"
            :src="selected.url"
            :alt="selected.value.name"
          />
          <iframe
            v-else-if="selected.kind === 'pdf'"
            :src="selected.url"
            :title="selected.value.name"
          />
          <audio
            v-else-if="selected.kind === 'audio'"
            :src="selected.url"
            controls
          />
          <video
            v-else-if="selected.kind === 'video'"
            :src="selected.url"
            controls
          />
          <p v-else>此格式暂不支持在线预览，可下载后查看。</p>
        </div>
      </template>
      <template #footer
        ><button type="button" class="button" @click="closePreview">关闭</button
        ><button
          v-if="selected?.url"
          type="button"
          class="button primary"
          @click="download"
        >
          <AppIcon name="download" />下载
        </button></template
      >
    </BaseDialog>
  </div>
</template>
<style scoped>
.file-control {
  width: 100%;
  min-width: 0;
}
.file-select {
  display: flex;
  align-items: center;
  gap: 7px;
  border: 1px dashed #dce3e9;
  border-radius: 3px;
  padding: 7px 12px;
  min-height: 34px;
  max-width: 480px;
  background: #fff;
  font-size: 13px;
}
.file-select > button {
  color: var(--primary, #00ada3);
  padding: 0;
  background: none;
  border: 0;
  white-space: nowrap;
  cursor: pointer;
}
.file-select > span {
  color: #a4adba;
  min-width: 0;
}
.file-select.locked > button {
  color: #a4adba;
  cursor: default;
}
.file-select input {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  overflow: hidden;
  pointer-events: none;
}
.file-format {
  font-size: 12px;
  color: #7c8797;
  margin: 6px 0;
  overflow-wrap: anywhere;
}
.file-values {
  max-width: 480px;
}
.file-item {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-top: 8px;
  min-width: 0;
  border: 1px solid #e4e9ed;
  border-radius: 3px;
  padding: 5px 8px;
}
.file-open {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
  border: 0;
  padding: 0;
  background: none;
  cursor: pointer;
  font-size: 13px;
  text-align: left;
  color: #526172;
}
.file-open span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.file-open img {
  width: 36px;
  height: 36px;
  object-fit: cover;
}
.file-actions {
  display: flex;
  gap: 1px;
}
.file-actions .icon-button {
  width: 24px;
  height: 24px;
}
.cards {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.cards .file-item {
  display: block;
  position: relative;
  width: 106px;
  padding: 5px;
}
.cards .file-open {
  flex-direction: column;
  align-items: stretch;
}
.cards .file-open > img {
  width: 94px;
  height: 78px;
  object-fit: cover;
}
.cards .file-open > .app-icon {
  align-self: center;
  margin: 25px 0;
}
.cards .file-open span {
  font-size: 12px;
}
.cards .file-actions {
  justify-content: flex-end;
  margin-top: 4px;
}
.file-preview {
  display: flex;
  min-height: 160px;
  justify-content: center;
  align-items: center;
}
.file-preview img,
.file-preview video {
  max-width: 100%;
  max-height: 65vh;
}
.file-preview iframe {
  width: 100%;
  height: 65vh;
  border: 0;
}
.file-preview audio {
  max-width: 100%;
}
@media (max-width: 600px) {
  .file-select {
    align-items: flex-start;
  }
}
</style>
