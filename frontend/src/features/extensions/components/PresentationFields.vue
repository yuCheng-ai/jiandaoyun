<script setup lang="ts">
import { computed } from "vue";
import type { FormSchema } from "../../../domain/form";
import { presentationFields } from "../../../domain/presentation";
import AppIcon from "../../../components/AppIcon.vue";
const props = defineProps<{
  modelValue: string[];
  schema: FormSchema;
  options?: { id: string; label: string }[];
  includeLookup?: boolean;
}>();
const emit = defineEmits<{ "update:modelValue": [value: string[]] }>();
const fields = computed(
  () => props.options || presentationFields(props.schema, props.includeLookup),
);
const selected = computed(() =>
  props.modelValue.map((id) => ({
    id,
    label: fields.value.find((f) => f.id === id)?.label || "已删除字段",
    invalid: !fields.value.some((f) => f.id === id),
  })),
);
function toggle(id: string) {
  emit(
    "update:modelValue",
    props.modelValue.includes(id)
      ? props.modelValue.filter((v) => v !== id)
      : [...props.modelValue, id],
  );
}
function move(index: number, delta: number) {
  const next = [...props.modelValue];
  [next[index], next[index + delta]] = [next[index + delta]!, next[index]!];
  emit("update:modelValue", next);
}
</script>
<template>
  <div class="presentation-field-picker">
    <div class="field-selection-tools">
      <button
        class="text-button"
        @click="
          emit(
            'update:modelValue',
            fields.map((f) => f.id),
          )
        "
      >
        选择全部</button
      ><button class="text-button" @click="emit('update:modelValue', [])">
        清空选择</button
      ><span>已选 {{ modelValue.length }} 项</span>
    </div>
    <div class="presentation-field-options">
      <label v-for="field in fields" :key="field.id"
        ><input
          type="checkbox"
          :checked="modelValue.includes(field.id)"
          @change="toggle(field.id)"
        />{{ field.label }}</label
      >
    </div>
    <ol class="presentation-field-order" aria-label="字段展示顺序">
      <li
        v-for="(field, index) in selected"
        :key="field.id"
        :class="{ invalid: field.invalid }"
      >
        <span>{{ index + 1 }}. {{ field.label }}</span
        ><button
          class="icon-button"
          :aria-label="`上移${field.label}`"
          :disabled="index === 0"
          @click="move(index, -1)"
        >
          <AppIcon name="up" /></button
        ><button
          class="icon-button"
          :aria-label="`下移${field.label}`"
          :disabled="index === selected.length - 1"
          @click="move(index, 1)"
        >
          <AppIcon name="moveDown" /></button
        ><button
          class="icon-button"
          :aria-label="`移除${field.label}`"
          @click="toggle(field.id)"
        >
          <AppIcon name="close" />
        </button>
      </li>
    </ol>
  </div>
</template>
