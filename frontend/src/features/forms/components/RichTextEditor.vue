<script setup lang="ts">
import { ref } from "vue";
import Editor from "../../../components/rich-text/RichTextEditor.vue";
import type { RichTextImageStorage } from "../../../components/rich-text/types";
import { readFile, saveFiles } from "../../../repositories/fileRepository";
import { richImageFiles } from "../../../domain/richText";
import { useFileUploads } from "../../../composables/useFileUploads";

// 表单上传策略留在此处，通用富文本编辑器不依赖业务存储。
const props = withDefaults(
  defineProps<{
    modelValue: string;
    label?: string;
    readonly?: boolean;
    variant?: "description" | "field";
    images?: boolean;
  }>(),
  { label: "描述信息", variant: "description", images: true },
);
const emit = defineEmits<{ "update:modelValue": [value: string] }>();
const pending = ref(false);
const { trackFiles } = useFileUploads(pending);
const storage: RichTextImageStorage = {
  async upload(files) {
    if (props.readonly) throw Error("当前字段不可编辑");
    if (pending.value) throw Error("图片正在上传，请稍后重试");
    // 记录容器等待图片上传完成，再提交包含图片引用的正文。
    pending.value = true;
    try {
      if (props.variant === "field") {
        const uploaded = await saveFiles(files);
        trackFiles(uploaded);
        return uploaded.map((file) => ({
          id: file.id,
          alt: file.name,
        }));
      }
      return await richImageFiles(files);
    } finally {
      pending.value = false;
    }
  },
  resolve: (id) => readFile({ id, name: "富文本图片", size: 0, type: "" }),
};
</script>

<template>
  <Editor
    :model-value="modelValue"
    :label="label"
    :readonly="readonly"
    :toolbar="variant === 'field' ? 'full' : 'compact'"
    :max-image-size-mb="variant === 'field' ? 5 : 1"
    :max-images="images ? (variant === 'field' ? 10 : Infinity) : 0"
    :allow-pasted-images="images && variant !== 'field'"
    :image-storage="storage"
    @update:model-value="emit('update:modelValue', $event)"
  />
</template>
