<script setup lang="ts">
import { computed } from "vue";
import {
  isChoiceField,
  isNumericField,
  isOrganizationField,
  type OrganizationIdentity,
  type FormField,
  type FormValues,
} from "@platform/contracts";
import ServerOrganizationControl from "./ServerOrganizationControl.vue";
import ChoiceFieldControl from "../forms/components/ChoiceFieldControl.vue";
import DateFieldControl from "../forms/components/DateFieldControl.vue";
import FileFieldControl from "../forms/components/FileFieldControl.vue";
import AddressFieldControl from "../forms/components/AddressFieldControl.vue";
import SignaturePad from "../forms/components/SignaturePad.vue";
import LocationFieldControl from "../forms/components/LocationFieldControl.vue";
import RichTextEditor from "../forms/components/RichTextEditor.vue";
import NumberInput from "../../components/NumberInput.vue";
const props = defineProps<{
  organizationRequest?: { path: string; body: Record<string, unknown> };
  identities?: OrganizationIdentity[];
  field: FormField;
  modelValue: unknown;
  values?: FormValues;
  disabled?: boolean;
  inputId: string;
  label: string;
  error?: string;
  warning?: string;
}>();
const emit = defineEmits<{ "update:modelValue": [value: unknown] }>();
const locked = computed(() => props.disabled || !props.field.editable);
const generated = computed(() =>
  ["calculated", "serial"].includes(props.field.type),
);
const scalar = computed(() => {
  const value = props.modelValue;
  return typeof value === "string" || typeof value === "number" ? value : "";
});
const inputType = computed(() => {
  if (props.field.type === "phone") return "tel";
  if (props.field.format === "email") return "email";
  return "text";
});
function update(value: unknown) {
  // 权限变更后，已打开的控件也不能把迟到的输入写回记录。
  if (locked.value || generated.value) return;
  emit("update:modelValue", value);
}
function input(event: Event) {
  update((event.target as HTMLInputElement).value);
}
</script>
<template>
  <div
    class="server-field-control"
    :class="{ invalid: !!error }"
    role="group"
    :aria-label="label"
    :aria-invalid="!!error || undefined"
    :aria-describedby="error || warning ? `${inputId}-feedback` : undefined"
    tabindex="-1"
  >
    <div class="server-control-input">
      <FileFieldControl
        v-if="field.type === 'file' || field.type === 'image'"
        :field="field"
        :model-value="modelValue"
        :disabled="locked"
        :label="label"
        @update:model-value="update"
      />
      <ServerOrganizationControl
        v-else-if="isOrganizationField(field.type)"
        :field="field"
        :model-value="modelValue"
        :disabled="locked"
        :label="label"
        :identities="identities"
        :request="organizationRequest"
        @update:model-value="update"
      />
      <ChoiceFieldControl
        v-else-if="isChoiceField(field.type)"
        :field="field"
        :model-value="modelValue"
        :disabled="locked"
        :label="label"
        :input-id="inputId"
        clearable-radio
        @update:model-value="update"
      />
      <textarea
        v-else-if="field.type === 'textarea'"
        :id="inputId"
        :aria-label="label"
        :value="scalar"
        :disabled="locked"
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
        :disabled="locked"
        @update:model-value="update"
      />
      <AddressFieldControl
        v-else-if="field.type === 'address'"
        :field="field"
        :model-value="modelValue"
        :label="label"
        :disabled="locked"
        @update:model-value="update"
      />
      <SignaturePad
        v-else-if="field.type === 'signature'"
        :model-value="modelValue"
        :label="label"
        :disabled="locked"
        @update:model-value="update"
      />
      <LocationFieldControl
        v-else-if="field.type === 'location'"
        :field="field"
        :model-value="modelValue"
        :values="values"
        :label="label"
        :disabled="locked"
        :readonly="locked"
        @update:model-value="update"
      />
      <RichTextEditor
        v-else-if="field.type === 'richtext'"
        variant="field"
        :model-value="String(scalar)"
        :label="label"
        :readonly="locked"
        @update:model-value="update"
      />
      <NumberInput
        v-else-if="isNumericField(field)"
        :id="inputId"
        :settings="field"
        :model-value="modelValue"
        :aria-label="label"
        :placeholder="field.placeholder"
        :disabled="locked"
        :readonly="generated"
        @update:model-value="update"
      />
      <input
        v-else
        :id="inputId"
        :aria-label="label"
        :type="inputType"
        :value="modelValue"
        :disabled="locked"
        :readonly="generated"
        :placeholder="
          field.type === 'serial' ? '提交后自动生成' : field.placeholder
        "
        :maxlength="field.maxLength || undefined"
        @input="input"
      />
    </div>
    <p
      v-if="error || warning"
      :id="`${inputId}-feedback`"
      class="server-field-feedback"
      :class="{ warning: !error }"
      :role="error ? 'alert' : 'status'"
    >
      {{ error || warning }}
    </p>
  </div>
</template>
<style scoped>
.server-field-control,
.server-control-input {
  display: grid;
  min-width: 0;
  gap: 6px;
}
.server-field-control {
  outline: none;
}
.server-field-control.invalid > .server-control-input {
  outline: 1px solid #d94b45;
  outline-offset: 1px;
  border-radius: 4px;
}
.server-field-feedback {
  margin: 0;
  color: #c13c36;
  font-size: 12px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.server-field-feedback.warning {
  color: #a26b16;
}
</style>
