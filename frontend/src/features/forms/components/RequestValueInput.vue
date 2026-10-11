<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import type { ValueBinding } from "@platform/contracts";
import type { FormField } from "../../../domain/form";
const props = withDefaults(
  defineProps<{
    modelValue: ValueBinding;
    fields: FormField[];
    label: string;
    rows?: number;
    placeholder?: string;
  }>(),
  { rows: 1 },
);
const emit = defineEmits<{ "update:modelValue": [value: ValueBinding] }>();
const editor = ref<HTMLInputElement | HTMLTextAreaElement>();
const names = computed(() => {
  const used = new Set<string>();
  return props.fields.map((field) => {
    let name = field.label,
      index = 2;
    while (used.has(name)) name = `${field.label} · ${index++}`;
    used.add(name);
    return { id: field.id, name };
  });
});
const tokens = computed(() => {
  const items = [...names.value];
  for (const token of props.modelValue.value.matchAll(/\{\{([^{}]+)\}\}/g))
    if (!items.some((item) => item.id === token[1]!.trim()))
      items.push({
        id: token[1]!.trim(),
        name: `已移除字段${items.filter((item) => item.name.startsWith("已移除字段")).length + 1}`,
      });
  return items;
});
const display = computed(() => {
  const value =
    props.modelValue.source === "field"
      ? `{{${props.modelValue.value}}}`
      : props.modelValue.value;
  return props.modelValue.source === "constant"
    ? value
    : value.replace(
        /\{\{([^{}]+)\}\}/g,
        (_, id: string) =>
          `{{${tokens.value.find((item) => item.id === id.trim())?.name || "已移除字段"}}}`,
      );
});
function update(value: string) {
  emit("update:modelValue", {
    source: "template",
    value: value.replace(
      /\{\{([^{}]+)\}\}/g,
      (_, name: string) =>
        `{{${tokens.value.find((item) => item.name === name.trim())?.id || name.trim()}}}`,
    ),
  });
}
async function insert(event: Event) {
  const select = event.target as HTMLSelectElement,
    name = names.value.find((item) => item.id === select.value)?.name;
  if (!name) return;
  const start = editor.value?.selectionStart ?? display.value.length,
    end = editor.value?.selectionEnd ?? start;
  const text = `{{${name}}}`;
  update(display.value.slice(0, start) + text + display.value.slice(end));
  select.value = "";
  await nextTick();
  editor.value?.focus();
  editor.value?.setSelectionRange(start + text.length, start + text.length);
}
</script>
<template>
  <div class="request-value-input" :class="{ multiline: rows > 1 }">
    <textarea
      v-if="rows > 1"
      ref="editor"
      :aria-label="label"
      :rows="rows"
      :value="display"
      :placeholder="placeholder"
      @input="update(($event.target as HTMLTextAreaElement).value)"
    />
    <input
      v-else
      ref="editor"
      :aria-label="label"
      :value="display"
      :placeholder="placeholder"
      @input="update(($event.target as HTMLInputElement).value)"
    />
    <select :aria-label="`${label}插入字段`" value="" @change="insert">
      <option value="">插入字段</option>
      <option v-for="field in names" :key="field.id" :value="field.id">
        {{ field.name }}
      </option>
    </select>
  </div>
</template>
<style>
.request-value-input {
  display: flex;
  min-width: 0;
  align-items: stretch;
}
.request-value-input input,
.request-value-input textarea {
  flex: 1;
  min-width: 0;
  border-top-right-radius: 0;
  border-bottom-right-radius: 0;
  font-size: 13px;
}
.base-dialog .request-value-input select {
  width: 106px;
  flex-shrink: 0;
  border-left: 0;
  border-top-left-radius: 0;
  border-bottom-left-radius: 0;
  color: var(--teal);
  font-size: 12px;
}
.request-value-input.multiline {
  position: relative;
  display: block;
}
.request-value-input.multiline textarea {
  display: block;
  width: 100%;
  padding-right: 116px;
  resize: none;
  height: 70px;
  min-height: 70px;
  border-radius: 3px;
}
.request-value-input.multiline select {
  position: absolute;
  right: 0;
  top: -30px;
  border: 0;
  background: transparent;
}
</style>
