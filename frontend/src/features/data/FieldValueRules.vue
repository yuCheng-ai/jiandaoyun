<script setup lang="ts">
import { computed } from "vue";
import {
  isChoiceField,
  isOrganizationField,
  dateFormats,
  dateInputType,
  dateInputStep,
  dateFormatPatch,
  normalizeDateValue,
  textFormats,
  type FormField,
  type FormSchema,
  formulaTypes,
  defaultPageSettings,
} from "@platform/contracts";
import DefaultLinkInspector from "../forms/components/DefaultLinkInspector.vue";
import OrganizationFieldRules from "./OrganizationFieldRules.vue";
import ManualChoiceEditor from "../forms/components/ManualChoiceEditor.vue";
import FileFieldInspector from "../forms/components/FileFieldInspector.vue";
const props = defineProps<{
  field: FormField;
  schema?: FormSchema;
  fields?: FormField[];
  parentId?: string;
  disabled?: boolean;
}>();
const formulaSchema = computed(
  () =>
    props.schema || {
      version: 1 as const,
      fields: props.fields || [props.field],
      settings: defaultPageSettings(),
    },
);
const emit = defineEmits<{ update: [value: Partial<FormField>] }>();
const number = (event: Event) => {
  const value = (event.target as HTMLInputElement).value;
  return value === "" ? undefined : Number(value);
};
</script>
<template>
  <fieldset class="field-value-rules" :disabled="disabled">
    <template v-if="field.type === 'file' || field.type === 'image'">
      <FileFieldInspector
        :field="field"
        section="appearance"
        @update="emit('update', $event)"
      />
      <FileFieldInspector :field="field" @update="emit('update', $event)" />
    </template>
    <OrganizationFieldRules
      v-if="isOrganizationField(field.type)"
      :field="field"
      :fields="fields || []"
      :parent-id="parentId"
      :disabled="disabled"
      @update="emit('update', $event)"
    />
    <template v-if="['text', 'textarea', 'phone'].includes(field.type)">
      <label
        >最大长度<input
          :value="field.maxLength"
          type="number"
          min="0"
          max="10000"
          :aria-label="`${field.label}最大长度`"
          @input="emit('update', { maxLength: number($event) ?? 0 })"
      /></label>
      <label v-if="field.type !== 'phone'"
        >文本格式<select
          :value="field.format || 'none'"
          :aria-label="`${field.label}文本格式`"
          @change="
            emit('update', {
              format: ($event.target as HTMLSelectElement).value,
            })
          "
        >
          <option
            v-for="item in textFormats.filter(
              (item) =>
                field.type === 'text' || ['none', 'email'].includes(item.value),
            )"
            :key="item.value"
            :value="item.value"
          >
            {{ item.value === "none" ? "普通文本" : item.label }}
          </option>
        </select></label
      >
    </template>
    <template v-if="field.type === 'number'">
      <label
        >最小值<input
          :value="field.min"
          type="number"
          :aria-label="`${field.label}最小值`"
          @input="emit('update', { min: number($event) })"
      /></label>
      <label
        >最大值<input
          :value="field.max"
          type="number"
          :aria-label="`${field.label}最大值`"
          @input="emit('update', { max: number($event) })"
      /></label>
      <label
        >小数位<input
          :value="field.precision"
          type="number"
          min="0"
          max="8"
          :aria-label="`${field.label}小数位`"
          @input="emit('update', { precision: number($event) ?? 0 })"
      /></label>
    </template>
    <template v-if="field.type === 'datetime'">
      <label
        >日期格式<select
          :value="field.format"
          :aria-label="`${field.label}日期格式`"
          @change="
            emit(
              'update',
              dateFormatPatch(
                field,
                ($event.target as HTMLSelectElement).value,
              ),
            )
          "
        >
          <option
            v-for="item in dateFormats"
            :key="item.value"
            :value="item.value"
          >
            {{ item.label }}
          </option>
        </select></label
      >
    </template>
    <ManualChoiceEditor
      v-if="isChoiceField(field.type)"
      :field="field"
      :disabled="disabled"
      :label-prefix="field.label"
      @update="emit('update', $event)"
    />
    <DefaultLinkInspector
      v-else-if="formulaTypes.includes(field.type)"
      :field="field"
      :schema="formulaSchema"
      form-id=""
      :allow-linked="false"
      @update="emit('update', $event)"
    >
      <input
        :value="field.defaultValue"
        :aria-label="`${field.label}默认值`"
        :type="
          field.type === 'datetime'
            ? dateInputType(field.format)
            : field.type === 'number'
              ? 'number'
              : 'text'
        "
        :step="
          field.type === 'datetime' ? dateInputStep(field.format) : undefined
        "
        @input="
          emit('update', {
            defaultValue:
              field.type === 'datetime'
                ? normalizeDateValue(
                    field.format,
                    ($event.target as HTMLInputElement).value,
                  )
                : field.type === 'number'
                  ? (number($event) ?? '')
                  : ($event.target as HTMLInputElement).value,
          })
        "
      />
    </DefaultLinkInspector>
    <label
      v-else-if="
        !['subform', 'file', 'image'].includes(field.type) &&
        !isOrganizationField(field.type)
      "
      >默认值<input
        :value="field.defaultValue"
        :aria-label="`${field.label}默认值`"
        :type="field.type === 'number' ? 'number' : 'text'"
        @input="
          emit('update', {
            defaultValue:
              field.type === 'number'
                ? (number($event) ?? '')
                : ($event.target as HTMLInputElement).value,
          })
        "
    /></label>
  </fieldset>
</template>
<style scoped>
.field-value-rules {
  border: 0;
  padding: 0;
  margin: 0;
  min-width: 0;
}
.field-value-rules > label {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 6px 0;
  font-size: 12px;
}
.field-value-rules > label > input,
.field-value-rules select {
  min-width: 0;
  flex: 1;
  width: 100%;
}
</style>
