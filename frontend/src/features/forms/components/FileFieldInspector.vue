<script setup lang="ts">
import { computed, ref, watch } from "vue";
import {
  fileTypesLimited,
  fileTypeTokens,
  type FormField,
} from "@platform/contracts";
import AppIcon from "../../../components/AppIcon.vue";
const props = withDefaults(
  defineProps<{ field: FormField; section?: "appearance" | "validation" }>(),
  { section: "validation" },
);
const emit = defineEmits<{ update: [patch: Partial<FormField>] }>();
const text = ref(""),
  error = ref("");
const tokens = computed(() => fileTypeTokens(props.field.accept));
watch(
  () => props.field.id,
  () => {
    text.value = "";
    error.value = "";
  },
);
function add() {
  const next = text.value
    .trim()
    .toLowerCase()
    .split(",")
    .map((t) => t.trim().replace(/^\./, ""))
    .filter(Boolean);
  if (!next.length) return;
  if (next.some((t) => !/^[a-z0-9]{1,10}$/.test(t))) {
    error.value = "文件格式仅支持字母、数字，每个最多 10 个字符";
    return;
  }
  const all = [
    ...new Set([...tokens.value.map((t) => t.replace(/^\./, "")), ...next]),
  ];
  if (all.length > 30) {
    error.value = "最多设置 30 个文件格式";
    return;
  }
  emit("update", {
    accept: all.map((t) => (t.includes("/") ? t : `.${t}`)).join(","),
  });
  text.value = "";
  error.value = "";
}
function remove(index: number) {
  emit("update", {
    accept: tokens.value.filter((_, i) => i !== index).join(","),
  });
}
</script>
<template>
  <div
    v-if="section === 'appearance' && field.type === 'image'"
    class="form-group"
  >
    <label>显示样式</label>
    <div class="upload-style">
      <button
        v-for="style in ['card', 'list'] as const"
        :key="style"
        type="button"
        :class="{ selected: (field.uploadStyle || 'card') === style }"
        :aria-pressed="(field.uploadStyle || 'card') === style"
        @click="emit('update', { uploadStyle: style })"
      >
        <AppIcon
          :name="style === 'card' ? 'table' : 'list'"
          :size="27"
        /><span>{{ style === "card" ? "卡片" : "列表" }}</span>
      </button>
    </div>
  </div>
  <template v-if="section === 'validation'">
    <label class="checkbox-line"
      ><input
        type="checkbox"
        :checked="!field.multiple"
        @change="
          emit('update', {
            multiple: !($event.target as HTMLInputElement).checked,
          })
        "
      />{{
        field.type === "image" ? "仅允许上传一张图片" : "仅允许上传单个文件"
      }}</label
    >
    <template v-if="field.type === 'file'">
      <label class="checkbox-line"
        ><input
          type="checkbox"
          :checked="fileTypesLimited(field)"
          @change="
            emit('update', {
              limitFileTypes: ($event.target as HTMLInputElement).checked,
            })
          "
        />设置允许上传的文件格式</label
      >
      <div v-if="fileTypesLimited(field)" class="file-extensions">
        <span
          v-for="(token, index) in tokens"
          :key="token"
          class="extension-tag"
          >{{ token.replace(/^\./, "")
          }}<button
            type="button"
            :aria-label="`移除格式 ${token.replace(/^\./, '')}`"
            @click="remove(index)"
          >
            <AppIcon name="close" :size="12" /></button
        ></span>
        <input
          v-model="text"
          aria-label="允许上传的文件格式"
          placeholder="输入文件格式，按 Enter 添加"
          @keydown.enter.prevent="add"
          @blur="add"
        />
      </div>
      <p v-if="error" role="alert" class="field-error">{{ error }}</p>
    </template>
    <label class="checkbox-line"
      ><input
        type="checkbox"
        :checked="field.maxFileSize !== undefined"
        @change="
          emit('update', {
            maxFileSize: ($event.target as HTMLInputElement).checked
              ? 20
              : undefined,
          })
        "
      />{{
        field.type === "image" ? "设置单个图片大小上限" : "设置单个文件上传上限"
      }}</label
    >
    <div v-if="field.maxFileSize !== undefined" class="file-size-limit">
      <input
        type="number"
        min="0.01"
        :max="field.type === 'image' ? 20 : 500"
        step="any"
        :value="field.maxFileSize"
        aria-label="单个文件大小上限"
        @input="
          emit('update', {
            maxFileSize: Number(($event.target as HTMLInputElement).value),
          })
        "
      /><span>MB</span>
    </div>
  </template>
</template>
<style scoped>
.file-extensions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  border: 1px solid #dce3e9;
  border-radius: 3px;
  padding: 7px;
  margin: 6px 0 10px 22px;
}
.file-extensions input {
  min-width: 140px;
  flex: 1;
  border: 0;
  padding: 3px;
  width: 100%;
  height: 28px;
  font-size: 12px;
}
.extension-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  padding: 3px 6px;
  border-radius: 2px;
  background: #eef2f6;
}
.extension-tag button {
  display: flex;
  border: 0;
  padding: 0;
  background: none;
  color: #7c8797;
  cursor: pointer;
}
.file-size-limit {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 8px 0 10px 22px;
}
.file-size-limit input {
  width: 95px;
}
.upload-style {
  display: flex;
  gap: 15px;
  margin: 8px 0 16px;
}
.upload-style button {
  display: flex;
  flex-direction: column;
  gap: 7px;
  align-items: center;
  justify-content: center;
  width: 76px;
  height: 72px;
  border: 0;
  border-radius: 3px;
  background: none;
  color: #98a3af;
  cursor: pointer;
}
.upload-style button.selected {
  background: #e7f6f5;
  color: var(--primary, #00ada3);
}
</style>
