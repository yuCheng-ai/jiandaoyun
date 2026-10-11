<script setup lang="ts">
import { useRuntimeData } from "../../../composables/useRuntimeData";
import { computed, ref, watch, onBeforeUnmount } from "vue";
import {
  formatNumberValue,
  parseNumberInput,
  isNumericField,
  supportsFieldPlaceholder,
} from "@platform/contracts";
import ChoiceFieldControl from "./ChoiceFieldControl.vue";
import FormDivider from "./FormDivider.vue";
import AppIcon from "../../../components/AppIcon.vue";
import RichTextEditor from "./RichTextEditor.vue";
import DateFieldControl from "./DateFieldControl.vue";
import LocationFieldControl from "./LocationFieldControl.vue";
import { ocrTemplate } from "@platform/contracts";
import AddressFieldControl from "./AddressFieldControl.vue";
import SignaturePad from "./SignaturePad.vue";
import FileFieldControl from "./FileFieldControl.vue";
import IdentityInput from "../../../components/organization/IdentityInput.vue";
import RelationControl from "./RelationControl.vue";
import LookupControl from "./LookupControl.vue";
import { resolveChoices } from "../../../domain/relations";
import type { FormField, FormValues } from "../../../domain/form";
const props = withDefaults(
  defineProps<{
    field: FormField;
    fields?: FormField[];
    modelValue?: unknown;
    design?: boolean;
    readonly?: boolean;
    editSerial?: boolean;
    disabled?: boolean;
    buttonEnabled?: boolean;
    label?: string;
    values?: FormValues;
    entryId?: string;
    autoTextarea?: boolean;
    device?: "desktop" | "mobile";
  }>(),
  {
    design: false,
    disabled: false,
    buttonEnabled: false,
    values: () => ({}),
    fields: () => [],
  },
);
const emit = defineEmits<{
  "update:modelValue": [value: unknown];
  activate: [];
}>();
const runtimeData = useRuntimeData();
const placeholder = computed(
  () =>
    props.field.placeholder ||
    (props.device === "mobile" && supportsFieldPlaceholder(props.field.type)
      ? ["select", "multiselect", "datetime"].includes(props.field.type)
        ? "请选择"
        : "请输入"
      : ""),
);
const label = computed(() => props.label || props.field.label);
const disabled = computed(
  () =>
    props.design ||
    props.disabled ||
    props.readonly ||
    !props.field.editable ||
    (props.field.type === "button" && !props.buttonEnabled),
);
const choices = computed(() =>
  resolveChoices(props.field, runtimeData.value, props.values, props.fields),
);
const scalar = computed(() =>
  typeof props.modelValue === "string" || typeof props.modelValue === "number"
    ? props.modelValue
    : "",
);
const textarea = ref<HTMLTextAreaElement>();
let textareaWidth = 0;
let textareaObserver: ResizeObserver | undefined;
function resizeTextarea() {
  const input = textarea.value;
  if (!input) return;
  if (!props.autoTextarea) {
    input.style.height = "";
    input.style.overflowY = "";
    return;
  }
  input.style.height = "auto";
  const height = Math.min(180, Math.max(32, input.scrollHeight + 2));
  input.style.height = `${height}px`;
  input.style.overflowY = input.scrollHeight + 2 > 180 ? "auto" : "hidden";
}
watch(
  [textarea, () => props.autoTextarea],
  ([input, auto]) => {
    textareaObserver?.disconnect();
    textareaObserver = undefined;
    textareaWidth = 0;
    if (input && auto && typeof ResizeObserver !== "undefined") {
      textareaObserver = new ResizeObserver((entries) => {
        const width = entries[0]?.contentRect.width ?? 0;
        if (Math.abs(width - textareaWidth) > 0.5) {
          textareaWidth = width;
          resizeTextarea();
        }
      });
      textareaObserver.observe(input);
    }
    resizeTextarea();
  },
  { flush: "post" },
);
watch(scalar, resizeTextarea, { flush: "post" });
onBeforeUnmount(() => textareaObserver?.disconnect());
const numberEditing = ref(false),
  numberText = ref("");
const displayedNumber = computed(() =>
  numberEditing.value
    ? numberText.value
    : formatNumberValue(props.field, props.modelValue, {
        percentSuffix: false,
      }),
);
function focusNumber() {
  if (disabled.value || props.field.type === "calculated") return;
  numberText.value = formatNumberValue(props.field, props.modelValue, {
    editing: true,
  });
  numberEditing.value = true;
}
function updateNumber(event: Event) {
  if (disabled.value || props.field.type === "calculated") return;
  numberText.value = (event.target as HTMLInputElement).value;
  emit("update:modelValue", parseNumberInput(props.field, numberText.value));
}
watch(
  [() => props.field.id, () => props.field.format, () => disabled.value],
  () => {
    numberEditing.value = false;
  },
);
function update(event: Event) {
  if (props.field.type === "calculated") return;
  const input = event.target as HTMLInputElement;
  emit("update:modelValue", input.value);
}
</script>
<template>
  <FormDivider v-if="field.type === 'divider'" :field="field" />
  <textarea
    v-else-if="field.type === 'textarea'"
    ref="textarea"
    :class="{ 'subform-auto-textarea': autoTextarea }"
    :value="scalar"
    :placeholder="placeholder"
    :rows="autoTextarea ? 1 : field.rows"
    :maxlength="field.maxLength || undefined"
    :disabled="disabled"
    :aria-label="label"
    @input="update"
  />
  <ChoiceFieldControl
    v-else-if="
      ['radio', 'checkbox', 'select', 'multiselect'].includes(field.type)
    "
    :field="field"
    :choices="choices"
    :placeholder="design ? undefined : placeholder"
    :model-value="modelValue"
    :label="label"
    :disabled="disabled"
    @update:model-value="emit('update:modelValue', $event)"
  />
  <IdentityInput
    v-else-if="
      ['member', 'members', 'department', 'departments'].includes(field.type)
    "
    :model-value="modelValue"
    :kind="field.type.startsWith('department') ? 'department' : 'member'"
    :multiple="['members', 'departments'].includes(field.type)"
    :disabled="disabled"
    :label="label"
    :placeholder="field.placeholder"
    :scope="field.organization.scope"
    :values="values"
    @update:model-value="emit('update:modelValue', $event)"
  />
  <LookupControl
    v-else-if="field.type === 'lookup'"
    :field="field"
    :model-value="modelValue"
    :label="label"
    :disabled="disabled"
    :design="design"
    :readonly="readonly"
    @activate="emit('activate')"
  />
  <RelationControl
    :fields="fields"
    v-else-if="['query', 'relation', 'relationTable'].includes(field.type)"
    :field="field"
    :model-value="modelValue"
    :values="values"
    :entry-id="entryId"
    :disabled="disabled"
    :design="design"
    :label="label"
    @update:model-value="emit('update:modelValue', $event)"
  />
  <FileFieldControl
    v-else-if="field.type === 'file' || field.type === 'image'"
    :field="field"
    :model-value="modelValue"
    :disabled="disabled"
    :design="design"
    :label="label"
    @update:model-value="emit('update:modelValue', $event)"
  />
  <AddressFieldControl
    v-else-if="field.type === 'address'"
    :field="field"
    :model-value="modelValue"
    :label="label"
    :disabled="disabled"
    @update:model-value="emit('update:modelValue', $event)"
  />
  <SignaturePad
    v-else-if="field.type === 'signature'"
    :model-value="modelValue"
    :label="label"
    :disabled="disabled || readonly"
    @update:model-value="emit('update:modelValue', $event)"
  />
  <RichTextEditor
    v-else-if="field.type === 'richtext'"
    variant="field"
    :model-value="String(modelValue || '')"
    :readonly="disabled"
    :label="label"
    @update:model-value="emit('update:modelValue', $event)"
  />
  <button
    v-else-if="field.type === 'button'"
    type="button"
    class="button"
    :disabled="disabled"
    :aria-label="label"
    :title="!buttonEnabled && !design ? '尚未配置前端事件' : undefined"
    @click="emit('activate')"
  >
    {{ field.buttonText || "按钮" }}
  </button>
  <LocationFieldControl
    v-else-if="field.type === 'location'"
    :field="field"
    :model-value="modelValue"
    :values="values"
    :label="label"
    :disabled="disabled"
    :readonly="readonly"
    :design="design"
    @update:model-value="emit('update:modelValue', $event)"
  />
  <div v-else-if="field.type === 'ocr'">
    <button
      v-if="field.ocr"
      type="button"
      class="button ocr-action"
      :aria-label="label"
      :disabled="
        disabled || readonly || !field.ocr.type || !field.ocr.mappings.length
      "
      @click="emit('activate')"
    >
      {{
        field.ocr.type && field.ocr.mappings.length
          ? `识别${ocrTemplate(field.ocr.type)?.label || "文字"}`
          : "请设置识别内容"
      }}
    </button>
    <textarea
      v-else
      :value="scalar"
      :disabled="disabled || readonly"
      :aria-label="label"
      placeholder="输入或粘贴识别后的文本"
      @input="update"
    />
  </div>
  <div v-else-if="isNumericField(field)" class="number-control">
    <input
      type="text"
      inputmode="decimal"
      :value="displayedNumber"
      :aria-label="label"
      :placeholder="placeholder"
      :disabled="disabled"
      :readonly="field.type === 'calculated'"
      @focus="focusNumber"
      @input="updateNumber"
      @blur="numberEditing = false"
    />
    <span
      v-if="field.format === 'percent'"
      class="number-suffix"
      aria-hidden="true"
      >%</span
    >
  </div>
  <DateFieldControl
    v-else-if="field.type === 'datetime'"
    :field="field"
    :placeholder="placeholder"
    :model-value="modelValue"
    :values="values"
    :label="label"
    :disabled="disabled"
    @update:model-value="emit('update:modelValue', $event)"
  />
  <input
    v-else
    :type="field.type === 'phone' ? 'tel' : 'text'"
    :value="scalar"
    :aria-label="label"
    :placeholder="
      field.type === 'serial' && !editSerial && !readonly
        ? design
          ? '自动生成无需填写'
          : '提交后自动生成'
        : placeholder
    "
    :disabled="disabled"
    :readonly="
      field.type === 'calculated' || (field.type === 'serial' && !editSerial)
    "
    :min="field.min"
    :max="field.max"
    :maxlength="field.maxLength || undefined"
    @input="update"
  />
</template>
<style scoped>
.ocr-action {
  width: 100%;
  justify-content: center;
}
</style>
