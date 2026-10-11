<script setup lang="ts">
import { computed } from "vue";
import IdentityInput from "../../../components/organization/IdentityInput.vue";
import type { FormField } from "../../../domain/form";
import {
  compatibleField,
  fieldValueType,
  type ValueBinding,
  type ValueType,
} from "../../../domain/extensions";
const props = defineProps<{
  modelValue: ValueBinding;
  fields: FormField[];
  label: string;
  type: ValueType;
  hint?: string;
}>();
const emit = defineEmits<{ "update:modelValue": [binding: ValueBinding] }>();
const choices = computed(() =>
  props.fields.filter((f) => compatibleField(f, props.type)),
);
const patch = (part: Partial<ValueBinding>) =>
  emit("update:modelValue", { ...props.modelValue, ...part });
const val = (e: Event) => (e.target as HTMLInputElement).value;
function insert(e: Event) {
  const id = val(e);
  if (id) patch({ value: props.modelValue.value + "{{" + id + "}}" });
  (e.target as HTMLSelectElement).value = "";
}
</script>
<template>
  <div class="binding-editor">
    <select
      :aria-label="`${label}来源`"
      :value="modelValue.source"
      @change="
        patch({ source: val($event) as ValueBinding['source'], value: '' })
      "
    >
      <option value="constant">固定值</option>
      <option value="field">表单字段</option>
      <option v-if="type === 'text'" value="template">文字与字段组合</option>
    </select>
    <select
      v-if="modelValue.source === 'field'"
      :aria-label="`${label}字段`"
      :value="modelValue.value"
      @change="patch({ value: val($event) })"
    >
      <option value="">选择兼容字段</option>
      <option
        v-if="
          modelValue.value && !choices.some((f) => f.id === modelValue.value)
        "
        :value="modelValue.value"
      >
        字段已删除或类型不兼容
      </option>
      <option v-for="f in choices" :key="f.id" :value="f.id">
        {{ f.label }} ·
        {{
          fieldValueType(f) === "number"
            ? "数字"
            : fieldValueType(f) === "members"
              ? "组织成员"
              : fieldValueType(f) === "json"
                ? "复合数据"
                : "文本"
        }}
      </option>
    </select>
    <IdentityInput
      v-else-if="type === 'members'"
      :model-value="modelValue.value ? modelValue.value.split(',') : []"
      kind="mixed"
      multiple
      :label="label"
      @update:model-value="patch({ value: ($event as string[]).join(',') })"
    />
    <input
      v-else-if="type === 'number'"
      :aria-label="`${label}固定值`"
      type="number"
      :value="modelValue.value"
      @input="patch({ value: val($event) })"
    />
    <textarea
      v-else
      :aria-label="`${label}内容`"
      :rows="type === 'json' ? 5 : 3"
      :placeholder="hint"
      :value="modelValue.value"
      @input="patch({ value: val($event) })"
    />
    <select
      v-if="modelValue.source === 'template'"
      :aria-label="`${label}插入字段`"
      value=""
      @change="insert"
    >
      <option value="">插入字段…</option>
      <option
        v-for="f in fields.filter((f) => compatibleField(f, 'text'))"
        :key="f.id"
        :value="f.id"
      >
        {{ f.label }}
      </option>
    </select>
  </div>
</template>
