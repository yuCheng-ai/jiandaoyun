<script setup lang="ts">
import { ref, watch, useId } from "vue";
import BaseDialog from "../BaseDialog.vue";
import {
  richImageAccept,
  richImageFilesIssue,
  richImageFilesHtml,
  richTextLink,
} from "../../domain/richText";
const props = withDefaults(
  defineProps<{
    open: boolean;
    maxSizeMb?: number;
    maxCount?: number;
    upload?: (files: File[]) => Promise<string>;
  }>(),
  { maxSizeMb: 1, maxCount: 10 },
);
const emit = defineEmits<{ close: []; insert: [html: string] }>();
const mode = ref("file"),
  files = ref<File[]>([]),
  url = ref(""),
  error = ref(""),
  busy = ref(false);
const imageUrlId = `${useId()}-image-url`;
const picker = ref<HTMLInputElement>();
let generation = 0;
watch(
  () => props.open,
  () => {
    generation++;
    mode.value = "file";
    files.value = [];
    url.value = "";
    error.value = "";
    busy.value = false;
  },
);
function selectFiles(next: File[]) {
  if (busy.value) return;
  const combined = [...files.value, ...next];
  error.value = richImageFilesIssue(combined, props.maxSizeMb, props.maxCount);
  if (!error.value) files.value = combined;
}
function choose(event: Event) {
  const input = event.target as HTMLInputElement;
  selectFiles(Array.from(input.files || []));
  input.value = "";
}
async function insert() {
  error.value = "";
  if (mode.value === "url") {
    if (props.maxCount < 1) {
      error.value = "已达到图片数量上限，请先移除已有图片";
      return;
    }
    const href = richTextLink(url.value);
    if (!href || !/^https?:\/\//i.test(href)) {
      error.value = "请输入有效的 http 或 https 图片地址";
      return;
    }
    const image = document.createElement("img");
    image.src = href;
    emit("insert", image.outerHTML);
    return;
  }
  if (!files.value.length || busy.value) return;
  const current = generation;
  busy.value = true;
  try {
    const issue = richImageFilesIssue(
      files.value,
      props.maxSizeMb,
      props.maxCount,
    );
    if (issue) throw Error(issue);
    const html = props.upload
      ? await props.upload(files.value)
      : await richImageFilesHtml(files.value, props.maxSizeMb, props.maxCount);
    if (props.open && current === generation) emit("insert", html);
  } catch (reason) {
    if (props.open && current === generation)
      error.value = (reason as Error).message;
  } finally {
    if (current === generation) busy.value = false;
  }
}
</script>
<template>
  <BaseDialog
    :open="open"
    title="插入图片"
    width="500px"
    :busy="busy"
    pending-text="正在保存图片…"
    @close="emit('close')"
  >
    <div class="image-source" role="group" aria-label="图片来源">
      <button
        v-for="item in [
          { value: 'file', label: '上传图片' },
          { value: 'url', label: '图片网址' },
        ]"
        :key="item.value"
        type="button"
        :aria-pressed="mode === item.value"
        @click="
          mode = item.value;
          error = '';
        "
      >
        {{ item.label }}
      </button>
    </div>
    <div
      v-if="mode === 'file'"
      class="image-files"
      @dragover.prevent
      @drop.prevent="selectFiles(Array.from($event.dataTransfer?.files || []))"
    >
      <p class="help-text">
        每张不超过 {{ maxSizeMb }} MB，最多可再添加 {{ maxCount }} 张
      </p>
      <button
        type="button"
        class="button"
        :disabled="files.length >= maxCount"
        @click="picker?.click()"
      >
        选择图片
      </button>
      <input
        ref="picker"
        hidden
        type="file"
        :accept="richImageAccept"
        multiple
        @change="choose"
      />
      <ul v-if="files.length" class="image-file-list">
        <li v-for="(file, index) in files" :key="index">
          <span>{{ file.name }}</span
          ><button
            type="button"
            class="text-button"
            :aria-label="`移除图片 ${file.name}`"
            @click="
              files.splice(index, 1);
              error = '';
            "
          >
            移除
          </button>
        </li>
      </ul>
    </div>
    <div v-else class="form-group">
      <label :for="imageUrlId">图片网址</label
      ><input
        :id="imageUrlId"
        v-model="url"
        type="text"
        placeholder="https://example.com/image.png"
        @keydown.enter.prevent="insert"
      />
    </div>
    <p v-if="error" role="status" class="field-error">{{ error }}</p>
    <template #footer
      ><button type="button" class="button" @click="emit('close')">取消</button
      ><button
        type="button"
        class="button primary"
        :disabled="mode === 'file' ? !files.length : !url.trim()"
        @click="insert"
      >
        确定
      </button></template
    >
  </BaseDialog>
</template>
<style scoped>
.image-source {
  display: flex;
  gap: 20px;
  margin-bottom: 16px;
  border-bottom: 1px solid #e6e9ee;
}
.image-source button {
  border: 0;
  border-bottom: 2px solid transparent;
  background: transparent;
  padding: 8px 0;
  color: #525967;
  cursor: pointer;
}
.image-source button[aria-pressed="true"] {
  border-bottom-color: #00a49a;
  color: #00a49a;
}
.image-files {
  min-height: 110px;
}
.image-file-list {
  list-style: none;
  padding: 0;
  max-height: 180px;
  overflow: auto;
}
.image-file-list li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 5px 0;
}
.image-file-list span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
