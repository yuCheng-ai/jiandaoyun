<script setup lang="ts">
import {
  isChoiceField,
  isOrganizationField,
  type OrganizationIdentity,
  type FormField,
  type FormValues,
} from "@platform/contracts";
import ServerOrganizationControl from "./ServerOrganizationControl.vue";
import ChoiceFieldControl from "../forms/components/ChoiceFieldControl.vue";
import DateFieldControl from "../forms/components/DateFieldControl.vue";
import FileFieldControl from "../forms/components/FileFieldControl.vue";
const props = defineProps<{
  organizationRequest?: { path: string; body: Record<string, unknown> };
  identities?: OrganizationIdentity[];
  field: FormField;
  modelValue: unknown;
  values?: FormValues;
  disabled?: boolean;
  inputId: string;
  label: string;
}>();
const emit = defineEmits<{ "update:modelValue": [value: unknown] }>();
function input(event: Event) {
  const value = (event.target as HTMLInputElement).value;
  emit(
    "update:modelValue",
    props.field.type === "number" && value !== "" ? Number(value) : value,
  );
}
</script>
<template>
  <FileFieldControl
    v-if="field.type === 'file' || field.type === 'image'"
    :field="field"
    :model-value="modelValue"
    :disabled="disabled"
    :label="label"
    @update:model-value="emit('update:modelValue', $event)"
  />
  <ServerOrganizationControl
    v-else-if="isOrganizationField(field.type)"
    :field="field"
    :model-value="modelValue"
    :disabled="disabled"
    :label="label"
    :identities="identities"
    :request="organizationRequest"
    @update:model-value="emit('update:modelValue', $event)"
  />
  <ChoiceFieldControl
    v-else-if="isChoiceField(field.type)"
    :field="field"
    :model-value="modelValue"
    :disabled="disabled"
    :label="label"
    :input-id="inputId"
    clearable-radio
    @update:model-value="emit('update:modelValue', $event)"
  />
  <textarea
    v-else-if="field.type === 'textarea'"
    :id="inputId"
    :aria-label="label"
    :value="String(modelValue ?? '')"
    :disabled="disabled"
    :rows="field.rows"
    :placeholder="field.placeholder"
    :maxlength="field.maxLength || undefined"
    @input="input"
  />
  <DateFieldControl
    v-else-if="field.type === 'datetime'"
    :field="field"
    :model-value="modelValue"
    :values="values"
    :input-id="inputId"
    :label="label"
    :disabled="disabled"
    @update:model-value="emit('update:modelValue', $event)"
  />
  <input
    v-else
    :id="inputId"
    :aria-label="label"
    :type="
      field.type === 'number'
        ? 'number'
        : field.type === 'phone'
          ? 'tel'
          : field.format === 'email'
            ? 'email'
            : 'text'
    "
    :value="modelValue"
    :disabled="disabled"
    :placeholder="field.placeholder"
    :min="field.min"
    :max="field.max"
    :step="field.type === 'number' ? 10 ** -field.precision : undefined"
    :maxlength="field.maxLength || undefined"
    @input="input"
  />
</template>
