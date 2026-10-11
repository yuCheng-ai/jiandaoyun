<script setup lang="ts">
import { computed, ref } from "vue";
import { useWorkspaceStore } from "../../../stores/workspace";
import { copy, type FormSchema, type FormValues } from "../../../domain/form";
import { configurableFields, sampleValues } from "../../../domain/extensions";
import FieldControl from "../../forms/components/FieldControl.vue";
const props = defineProps<{
  schema: FormSchema;
  formId: string;
  modelValue: FormValues;
}>();
const emit = defineEmits<{ "update:modelValue": [values: FormValues] }>();
const store = useWorkspaceStore(),
  selected = ref("");
const records = computed(() =>
  store.data.entries.filter(
    (e) => e.formId === props.formId && e.status !== "draft" && !e.deletedAt,
  ),
);
const fields = computed(() =>
  configurableFields(props.schema).filter((field) => field.type !== "lookup"),
);
function pick(e: Event) {
  selected.value = (e.target as HTMLSelectElement).value;
  emit(
    "update:modelValue",
    selected.value
      ? copy(records.value.find((r) => r.id === selected.value)!.values)
      : sampleValues(props.schema),
  );
}
</script>
<template>
  <div class="sample-editor">
    <label
      >使用哪条数据测试？<select
        aria-label="测试数据来源"
        :value="selected"
        @change="pick"
      >
        <option value="">自动生成的示例数据</option>
        <option
          v-for="(entry, index) in records"
          :key="entry.id"
          :value="entry.id"
        >
          记录 {{ index + 1 }} ·
          {{ new Date(entry.createdAt).toLocaleString("zh-CN") }}
        </option>
      </select></label
    >
    <p class="field-hint">可修改下面的测试副本，原始记录不会改变。</p>
    <details>
      <summary>调整示例字段值（{{ fields.length }}）</summary>
      <div class="sample-fields">
        <label v-for="field in fields" :key="field.id"
          ><span>{{ field.label }}</span>
          <pre v-if="field.type === 'subform'">{{
            JSON.stringify(modelValue[field.id] || [], null, 2)
          }}</pre>
          <FieldControl
            v-else
            :field="{ ...field, editable: true }"
            :model-value="modelValue[field.id]"
            :values="modelValue"
            :label="`测试${field.label}`"
            @update:model-value="
              emit('update:modelValue', { ...modelValue, [field.id]: $event })
            "
        /></label>
      </div>
    </details>
  </div>
</template>
