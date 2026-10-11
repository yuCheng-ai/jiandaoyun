<script setup lang="ts">
import { computed, ref, watch } from "vue";
import {
  formatNumberValue,
  parseNumberInput,
  type NumberSettings,
} from "@platform/contracts";

defineOptions({ inheritAttrs: false });
const props = withDefaults(
  defineProps<{
    modelValue: unknown;
    settings: NumberSettings;
    disabled?: boolean;
    readonly?: boolean;
    formatOnBlur?: boolean;
  }>(),
  { formatOnBlur: true },
);
const emit = defineEmits<{ "update:modelValue": [value: string | number] }>();
const editing = ref(false),
  text = ref("");
const plain = () =>
  formatNumberValue(props.settings, props.modelValue, { editing: true });
const displayed = computed(() =>
  editing.value
    ? text.value
    : props.formatOnBlur
      ? formatNumberValue(props.settings, props.modelValue, {
          percentSuffix: false,
        })
      : plain(),
);
function focus() {
  if (props.disabled || props.readonly) return;
  text.value = plain();
  editing.value = true;
}
function input(event: Event) {
  if (props.disabled || props.readonly) return;
  text.value = (event.target as HTMLInputElement).value;
  emit("update:modelValue", parseNumberInput(props.settings, text.value));
}
watch(
  () => props.modelValue,
  (value) => {
    // Keep the user's intermediate "12." while acknowledging our own update,
    // but display a changed value supplied by a parent or dependent rule.
    if (
      editing.value &&
      !Object.is(value, parseNumberInput(props.settings, text.value))
    )
      text.value = plain();
  },
);
watch(
  [() => props.settings.format, () => props.disabled, () => props.readonly],
  () => {
    editing.value = false;
  },
);
</script>
<template>
  <div class="number-control">
    <input
      v-bind="$attrs"
      type="text"
      inputmode="decimal"
      :value="displayed"
      :disabled="disabled"
      :readonly="readonly"
      @focus="focus"
      @input="input"
      @blur="editing = false"
    />
    <span
      v-if="settings.format === 'percent'"
      class="number-suffix"
      aria-hidden="true"
      >%</span
    >
  </div>
</template>
<style scoped>
.number-control {
  position: relative;
  min-width: 0;
}
.number-control > input {
  width: 100%;
}
.number-control:has(.number-suffix) > input {
  padding-right: 28px;
}
.number-suffix {
  position: absolute;
  right: 10px;
  top: 50%;
  transform: translateY(-50%);
  color: #9297a1;
  pointer-events: none;
}
</style>
