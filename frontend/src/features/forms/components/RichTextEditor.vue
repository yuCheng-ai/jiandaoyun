<script setup lang="ts">
import Editor from "../../../components/rich-text/RichTextEditor.vue";
import type { RichTextImageStorage } from "../../../components/rich-text/types";
import { readFile, saveFiles } from "../../../repositories/fileRepository";
import { richImageFiles } from "../../../domain/richText";

// Keep form policy and local file persistence outside the reusable editor.
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
const storage: RichTextImageStorage = {
  async upload(files) {
    if (props.variant === "field")
      return (await saveFiles(files)).map((file) => ({
        id: file.id,
        alt: file.name,
      }));
    return richImageFiles(files);
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
